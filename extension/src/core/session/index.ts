import { fromBase64 } from '@autofill/core';
import type { DraftEmailResponse } from '@/shared/messages';
import type { AtsAdapter } from '@/adapters';
import { detectApplicationEmail, type EmailDetection } from '@/core/email/detect';
import {
  gmailComposeUrl,
  mailtoUrl,
  plainTextEmail,
  type ComposedEmail,
  type SendMethod,
} from '@/core/email/send';
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
import {
  toDto,
  type FieldDescriptor,
  type FillInstruction,
  type FillPlan,
  type FillSession,
  type PageContext,
} from '@/shared/types';

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
  /** Document instructions held back for an explicit click — see `withholdDocuments`. */
  private withheld = new Map<string, FillInstruction>();
  /** Signatures of file inputs already attached, so a re-fill never uploads twice. */
  private attached = new Set<string>();

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
   * Find the address an application should go to (§3.7).
   *
   * Pure reading — nothing is written to the page and nothing leaves the device.
   * The page context is refreshed first because the ranking leans on the job
   * description to tell posting text from site furniture, and a detection run
   * before any fill would otherwise have none.
   */
  detectEmail(): EmailDetection | undefined {
    if (!this.pageContext.jobDescription) this.pageContext = readPageContext(this.doc);
    return detectApplicationEmail(this.doc, { page: this.pageContext });
  }

  /** Ask the worker to compose the application email. It records, never sends. */
  async draftEmail(to: string): Promise<DraftEmailResponse> {
    const url = new URL(this.doc.location.href);
    return sendToBackground('email:draft', {
      to,
      hostname: url.hostname,
      url: url.href,
      page: this.pageContext,
    });
  }

  /**
   * Hand a composed email to something that can send it (§3.7).
   *
   * Every route opens a compose window the user still has to press send in.
   * There is no path from here to a delivered email, by design — the same
   * guarantee as §6.7's "never submits".
   */
  async sendEmail(method: SendMethod, email: ComposedEmail, entryId: number): Promise<boolean> {
    const handed = await this.handOff(method, email);
    if (!handed) return false;

    // "Sent" means a compose window opened holding this draft. Recorded after
    // the hand-off succeeds, so a blocked pop-up does not mark it sent.
    await sendToBackground('email:mark-sent', { entryId, to: email.to }).catch((error: unknown) =>
      log.warn('could not mark the email as sent', error),
    );
    return true;
  }

  private async handOff(method: SendMethod, email: ComposedEmail): Promise<boolean> {
    if (method === 'clipboard') {
      try {
        await navigator.clipboard.writeText(plainTextEmail(email));
        return true;
      } catch (error) {
        log.warn('the clipboard refused the email', error);
        return false;
      }
    }

    if (method === 'gmail') {
      // `noopener` so the compose tab cannot reach back into this page.
      return this.doc.defaultView?.open(gmailComposeUrl(email), '_blank', 'noopener') !== null;
    }

    // A `mailto:` anchor click. Not `location.href = …`: the browser hands the
    // URL to the mail client either way, but an anchor leaves the job posting
    // in the tab if no mail client is registered, and a navigation does not.
    const link = this.doc.createElement('a');
    link.href = mailtoUrl(email);
    link.style.display = 'none';
    this.doc.body.append(link);
    link.click();
    link.remove();
    return true;
  }

  /**
   * Download a stored document so the user can attach it by hand.
   *
   * No send route can carry an attachment — `mailto:` forbids it, Gmail's
   * compose URL has no parameter for it, and the clipboard holds text. Saying
   * which file to attach and putting it one click away is the honest version of
   * "attachments included".
   */
  async downloadDocument(blobId: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const file = await sendToBackground('documents:get', { blobId });
      const blob = new Blob([fromBase64(file.base64) as unknown as BlobPart], {
        type: file.mimeType,
      });
      const href = URL.createObjectURL(blob);

      const link = this.doc.createElement('a');
      link.href = href;
      link.download = file.filename;
      link.style.display = 'none';
      this.doc.body.append(link);
      link.click();
      link.remove();
      // Revoked on the next turn — revoking synchronously can beat the download.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);

      return { ok: true, detail: file.filename };
    } catch (error) {
      log.warn('could not download the document', error);
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
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

    const proposed = await sendToBackground('mapping:plan', {
      hostname: url.hostname,
      url: url.href,
      ...(this.adapter ? { adapter: this.adapter.name } : {}),
      fields: fields.map(toDto),
      ...(this.adapter ? { adapterMappings: resolveAdapterMappings(this.adapter, fields, this.doc) } : {}),
      pageContext: this.pageContext,
    });

    const plan = withholdDocuments(proposed, this.fields, this.attached, this.withheld);

    const attempts = await executePlan(this.fields, plan, {
      ...(this.adapter?.comboboxStrategy ? { strategy: this.adapter.comboboxStrategy } : {}),
      fetchDocument,
      ...(onProgress ? { onProgress } : {}),
    });

    // Screener questions the worker recognised from the answer bank. They carry
    // no canonical key, so they are written here rather than by `executePlan`.
    await this.writeRecalledAnswers(plan);

    this.hasFilled = true;
    const outcomes = verifyFills(this.fields, plan, attempts);
    const session: FillSession = {
      sessionId: crypto.randomUUID(),
      hostname: url.hostname,
      url: url.href,
      ...(this.adapter ? { adapter: this.adapter.name } : {}),
      // Scraped above by `readPageContext`; this is what makes the history read
      // as a list of applications rather than a list of domains.
      ...(this.pageContext.jobTitle ? { jobTitle: this.pageContext.jobTitle } : {}),
      ...(this.pageContext.company ? { company: this.pageContext.company } : {}),
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

  /**
   * Write the answers the worker recalled for this page (§3.6).
   *
   * These are questions the user has answered before — "Do you have your own
   * laptop?" — so they need no approval click a second time. The verifier reads
   * the DOM back afterwards, which is what catches a write that did not land.
   */
  private async writeRecalledAnswers(plan: FillPlan): Promise<void> {
    for (const answered of plan.answers ?? []) {
      const field = this.fields.get(answered.fieldId);
      if (!field) continue;

      const outcome = await fillFreeText(field, answered.answer);
      if (!outcome.ok) log.warn(`could not write a recalled answer: ${outcome.reason}`);
    }
  }

  /**
   * Attach a stored document to a file input.
   *
   * The one-click action the review panel offers for a `needs-attach` row, and
   * the *only* path from a stored document to a form. See `withholdDocuments`
   * for why this is never part of a fill.
   */
  async attachDocument(fieldId: string): Promise<{ ok: boolean; detail: string }> {
    const field = this.fields.get(fieldId);
    const instruction = this.withheld.get(fieldId);
    if (!field || !instruction) return { ok: false, detail: 'There is nothing stored to attach.' };

    const [attempt] = await executePlan(
      this.fields,
      { instructions: [instruction], skipped: [] },
      { fetchDocument },
    );
    if (!attempt || attempt.error) {
      return { ok: false, detail: attempt?.error ?? 'The upload control refused the file.' };
    }

    // Latched: a later re-fill will not offer this row again, so the site's
    // parser runs exactly once.
    this.attached.add(field.signature);
    this.highlight(fieldId);
    return { ok: true, detail: attempt.wrote ?? 'Attached' };
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

/**
 * Hold every document back for an explicit click.
 *
 * Attaching a résumé is not like typing a name. Most applicant tracking systems
 * — Keka, Naukri, Workday, SmartRecruiters — run their *own* parser the instant
 * a file lands on the input, then ask whether to overwrite the form with what
 * they extracted. Answering that rewrites the fields, which is a DOM change,
 * which invites another fill, which re-attaches the file, which re-opens the
 * dialog. The user sees an unclosable loop and the extension looks broken.
 *
 * Uploading also puts a document on someone else's server. That is a side
 * effect with the same shape as submitting the form, and §6.7 already says the
 * user makes that call, not us.
 *
 * So file instructions never execute as part of a fill. They are parked here,
 * surfaced in the panel as a `needs-attach` row with a button, and latched by
 * signature once used so a re-fill cannot upload the same document twice.
 */
export function withholdDocuments(
  plan: FillPlan,
  fields: ReadonlyMap<string, FieldDescriptor>,
  attached: ReadonlySet<string>,
  parked: Map<string, FillInstruction>,
): FillPlan {
  const instructions: FillInstruction[] = [];
  const skipped = [...plan.skipped];
  parked.clear();

  for (const instruction of plan.instructions) {
    const field = fields.get(instruction.fieldId);
    if (field?.kind !== 'file') {
      instructions.push(instruction);
      continue;
    }
    // Already attached in this session: the file is on the form, and offering
    // it again is exactly the loop this function exists to prevent.
    if (attached.has(field.signature)) continue;

    parked.set(instruction.fieldId, instruction);
    skipped.push({ fieldId: instruction.fieldId, reason: 'needs-attach', key: instruction.key });
  }

  return { instructions, skipped };
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
