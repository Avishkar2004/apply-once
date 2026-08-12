import { fromBase64 } from '@autofill/core';
import type { AtsAdapter } from '@/adapters';
import {
  annotateRepeatingRows,
  findAdapter,
  resolveAdapterMappings,
  watchWizardSteps,
  type WizardWatcher,
} from '@/adapters';
import { executePlan, fillFreeText } from '@/core/filler';
import { scanRoot } from '@/core/scanner';
import { readPageContext } from '@/core/scanner/page-context';
import { summarise, verifyFills } from '@/core/verifier';
import { createLogger } from '@/shared/logger';
import { sendToBackground } from '@/shared/messaging';
import { toDto, type FieldDescriptor, type FillSession, type PageContext } from '@/shared/types';

const log = createLogger('session');

/**
 * The per-page fill session (ARCHITECTURE.md §3.1 — "keep a per-page session").
 *
 * One instance per frame. It owns the live `FieldDescriptor` objects (which hold
 * `WeakRef`s into the DOM and therefore cannot cross a message boundary) and
 * drives the documented flow:
 *
 *   scan → describe → map (in the worker) → fill → verify → report
 */
export class PageSession {
  private fields = new Map<string, FieldDescriptor>();
  private adapter: AtsAdapter | undefined;
  private lastScan: ReturnType<typeof scanRoot> | undefined;
  /** Job title / company / description, for Tier 3 and the Answer Generator. */
  private pageContext: PageContext = {};
  private wizard: WizardWatcher | undefined;
  /** Wizard auto-fill only arms once the user has asked for a fill at least once. */
  private hasFilled = false;

  constructor(private readonly doc: Document = document) {}

  get context(): PageContext {
    return this.pageContext;
  }

  get adapterName(): string | undefined {
    return this.adapter?.name;
  }

  get comboboxStrategy() {
    return this.adapter?.comboboxStrategy;
  }

  get unreachableFrames(): number {
    return this.lastScan?.unreachableFrames ?? 0;
  }

  /** Walk the DOM and refresh the field registry. Safe to call repeatedly. */
  scan(): FieldDescriptor[] {
    const url = new URL(this.doc.location.href);
    this.adapter = findAdapter(url, this.doc);

    const result = scanRoot(this.doc);
    this.lastScan = result;

    const fields = annotateRepeatingRows(this.adapter, result.fields, this.doc);
    this.fields = new Map(fields.map((field) => [field.id, field]));

    log.info(
      `${fields.length} fields on ${url.hostname}${this.adapter ? ` via ${this.adapter.name}` : ' (generic)'}`,
    );
    return fields;
  }

  getField(fieldId: string): FieldDescriptor | undefined {
    return this.fields.get(fieldId);
  }

  /**
   * Fill each new step of a wizard as the user reaches it (§3.1).
   *
   * Armed only after a first fill has completed, so nothing writes to the page
   * before the user has asked for it once. Returns a disposer.
   */
  watchSteps(onFilled: (session: FillSession) => void): () => void {
    this.wizard?.stop();
    this.wizard = watchWizardSteps(
      this.adapter,
      () => {
        if (!this.hasFilled) return;
        void this.fill()
          .then(onFilled)
          .catch((error: unknown) => log.warn('could not fill the new wizard step', error));
      },
      this.doc,
    );
    return () => this.wizard?.stop();
  }

  /** Ask the worker for a draft answer to a free-text question (§3.6). */
  async draftAnswer(fieldId: string): Promise<{ answer: string; source: 'bank' | 'llm' }> {
    const field = this.fields.get(fieldId);
    if (!field) throw new Error('That field is no longer on the page.');

    const response = await sendToBackground('answers:draft', {
      question: field.displayLabel,
      ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      page: this.pageContext,
    });
    return { answer: response.answer, source: response.source };
  }

  /**
   * Scan, ask the worker for a plan, fill, verify, report.
   *
   * Never submits: the executor's only click path is `safeClick`, which refuses
   * submit controls (§6.7).
   */
  async fill(onProgress?: (done: number, total: number) => void): Promise<FillSession> {
    const startedAt = new Date();
    const started = performance.now();

    const fields = this.scan();
    if (fields.length === 0) {
      return this.emptySession(startedAt, performance.now() - started);
    }

    const url = new URL(this.doc.location.href);
    // Scraped from the page, never from the profile — safe to send with the
    // mapping request (§3.2, §6.3).
    this.pageContext = readPageContext(this.doc);

    const plan = await sendToBackground('mapping:plan', {
      hostname: url.hostname,
      url: url.href,
      ...(this.adapter ? { adapter: this.adapter.name } : {}),
      fields: fields.map(toDto),
      ...(this.adapter ? { adapterMappings: resolveAdapterMappings(this.adapter, fields, this.doc) } : {}),
      pageContext: this.pageContext,
    });

    const attempts = await executePlan(this.fields, plan, {
      ...(this.adapter?.comboboxStrategy ? { strategy: this.adapter.comboboxStrategy } : {}),
      fetchDocument,
      ...(onProgress ? { onProgress } : {}),
    });

    this.hasFilled = true;
    const outcomes = verifyFills(this.fields, plan, attempts);
    const session: FillSession = {
      sessionId: crypto.randomUUID(),
      hostname: url.hostname,
      url: url.href,
      ...(this.adapter ? { adapter: this.adapter.name } : {}),
      outcomes,
      summary: summarise(outcomes, Math.round(performance.now() - started)),
      startedAt: startedAt.toISOString(),
    };

    // Audit log: site, timestamp, counts. No labels, no values (§6.8).
    await sendToBackground('session:report', { session }).catch((error: unknown) =>
      log.warn('could not write the audit entry', error),
    );

    return session;
  }

  private emptySession(startedAt: Date, durationMs: number): FillSession {
    const url = new URL(this.doc.location.href);
    return {
      sessionId: crypto.randomUUID(),
      hostname: url.hostname,
      url: url.href,
      outcomes: [],
      summary: { filled: 0, lowConfidence: 0, rejected: 0, skipped: 0, total: 0, durationMs },
      startedAt: startedAt.toISOString(),
    };
  }

  /**
   * Write an approved answer into a free-text field (§3.6).
   *
   * Only ever called from the overlay's accept button — drafts are never
   * filled silently.
   */
  async acceptDraft(fieldId: string, answer: string): Promise<boolean> {
    const field = this.fields.get(fieldId);
    if (!field) return false;

    const outcome = await fillFreeText(field, answer);
    if (!outcome.ok) {
      log.warn(`could not write the approved answer: ${outcome.reason}`);
      return false;
    }

    await sendToBackground('answers:approve', {
      question: field.displayLabel,
      answer,
      ...(this.pageContext.company ? { company: this.pageContext.company } : {}),
    }).catch((error: unknown) => log.warn('could not store the approved answer', error));

    this.highlight(fieldId);
    return true;
  }

  /** Scroll to a field and outline it — the overlay's row-click behaviour (§3.5). */
  highlight(fieldId: string): void {
    const el = this.fields.get(fieldId)?.el.deref();
    if (!(el instanceof HTMLElement)) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const previousOutline = el.style.outline;
    const previousOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #6366f1';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = previousOutline;
      el.style.outlineOffset = previousOffset;
    }, 1600);
  }
}

/** Documents cross the message boundary base64-encoded (Chrome messaging is JSON). */
async function fetchDocument(blobId: string) {
  const response = await sendToBackground('documents:get', { blobId });
  return {
    bytes: fromBase64(response.base64),
    filename: response.filename,
    mimeType: response.mimeType,
  };
}
