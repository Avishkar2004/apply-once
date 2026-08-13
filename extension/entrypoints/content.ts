import { defineContentScript } from 'wxt/utils/define-content-script';
import type { CanonicalKey } from '@autofill/core';
import { PageSession } from '@/core/session';
import { observeChanges } from '@/core/scanner';
import { mapWithRules } from '@/core/mapping/tier1';
import { toDto, type FieldDescriptor } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { ATS_MATCH_PATTERNS } from '@/shared/hosts';
import { registerHandlers, sendToBackground } from '@/shared/messaging';
import { mountOverlay, type OverlayController, type OverlayPhase } from '@/ui/overlay/mount';
import { primePosition } from '@/ui/overlay/position-store';

const log = createLogger('content');

/**
 * The content script — scanner + filler + overlay (ARCHITECTURE.md §8).
 *
 * Registered on the ATS host allow-list only (§6.5) and in **all frames**: an
 * application board embedded in a company career site is a cross-origin iframe,
 * and the frame itself is the only place that can see the form. Each frame
 * decides whether it is the one to scan — see `isRootScanFrame`.
 */
export default defineContentScript({
  matches: [...ATS_MATCH_PATTERNS],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',

  main() {
    // This file is both a declared content script (on the known ATS hosts) and
    // the payload `scripting.executeScript` injects everywhere else. On an ATS
    // host a user click would otherwise run a second copy in the same isolated
    // world, giving the page two overlays and two fillers racing each other.
    const world = globalThis as typeof globalThis & { __autofillReady?: boolean };
    if (world.__autofillReady) {
      log.debug('already running in this frame');
      return;
    }
    world.__autofillReady = true;

    if (!isRootScanFrame()) {
      log.debug('same-origin child frame — the parent scans this subtree');
      return;
    }

    // Read where the user last dragged the panel, well before it can mount, so
    // it appears there rather than jumping once storage resolves.
    void primePosition();

    const session = new PageSession();
    let overlay: OverlayController | undefined;
    let phase: OverlayPhase = { kind: 'idle' };

    const render = () => overlay?.render(phase, session.unreachableFrames);

    const ensureOverlay = (): OverlayController => {
      overlay ??= mountOverlay({
        onClose: () => {
          overlay?.destroy();
          overlay = undefined;
        },
        onRefill: () => void runFill(),
        onHighlight: (fieldId) => session.highlight(fieldId),
        onCorrect: async (outcome, key) => {
          // A correction is permanent for this site (§3.5): Tier 0 catches it
          // on every future application here.
          await sendToBackground('override:set', {
            hostname: location.hostname,
            signature: outcome.signature,
            canonicalKey: key,
            label: outcome.label,
          });
          await runFill();
        },
        onOpenOptions: () => void sendToBackground('ui:open-options'),
        // §3.6 — drafting produces text; only `onAcceptDraft` writes to the page.
        onDraft: (outcome) => session.draftAnswer(outcome.fieldId),
        onAcceptDraft: (outcome, answer) => session.acceptDraft(outcome.fieldId, answer),
        // Uploading is the user's call, never a side effect of filling (§3.4a).
        onAttach: (outcome) => session.attachDocument(outcome.fieldId),
      });
      return overlay;
    };

    const setPhase = (next: OverlayPhase) => {
      phase = next;
      ensureOverlay();
      render();
    };

    let filling = false;
    async function runFill(): Promise<void> {
      if (filling) return;
      filling = true;
      setPhase({ kind: 'filling', done: 0, total: 0 });
      try {
          const result = await session.fill((done, total) =>
          setPhase({ kind: 'filling', done, total }),
        );
        setPhase({ kind: 'done', session: result });
        // Mirror the result into the side panel, if one happens to be open.
        void sendToBackground('panel:session', { session: result }).catch(() => undefined);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.name === 'VaultLockedError') setPhase({ kind: 'locked' });
        else setPhase({ kind: 'error', message: err.message });
        log.warn('fill failed', err);
      } finally {
        filling = false;
      }
    }

    registerHandlers({
      'content:fill': () => {
        void runFill();
        return { started: true };
      },
    });

    /**
     * Fill on arrival, without waiting for a click.
     *
     * The product's whole promise is "zero manual typing" (§G1), and making the
     * user find a toolbar button first is a poor way to deliver it. Nothing here
     * relaxes §6.7 — the executor still has no path to a submit button, and the
     * review overlay appears exactly as it does for a manual fill.
     *
     * It also gives the extension a visible pulse: on a supported page you now
     * always see the panel, even if the answer is "locked" or "no profile yet".
     */
    async function maybeAutoFill(): Promise<void> {
      const settings = await sendToBackground('settings:get').catch(() => undefined);
      if (!settings?.enabled || !settings.autoFill) return;

      // An application form is rarely in the DOM at document_idle — React
      // boards mount it a beat later. Poll briefly rather than firing once and
      // concluding the page is empty.
      const found = await waitForFields(session);
      if (found === 0) return;

      if (!looksLikeIdentityForm(session.scan())) {
        log.debug('not an identity form; waiting to be asked');
        return;
      }

      log.info(`auto-filling ${found} fields`);
      await runFill();
    }

    void maybeAutoFill();

    // Lazy content: keep the field registry fresh so a re-fill sees whatever
    // mounted since the last scan (§3.1).
    const stopObserving = observeChanges(document, () => {
      if (!filling && phase.kind !== 'filling') session.scan();
    });

    // Multi-step wizards: fill each new step as the user reaches it. Armed only
    // after the first explicit fill, so nothing happens unasked (§3.1).
    const stopWatchingSteps = session.watchSteps((result) => {
      setPhase({ kind: 'done', session: result });
      void sendToBackground('panel:session', { session: result }).catch(() => undefined);
    });

    window.addEventListener('pagehide', () => {
      stopObserving();
      stopWatchingSteps();
      overlay?.destroy();
    });
  },
});

/**
 * Is this a form worth filling unasked?
 *
 * The content script now runs on every site, so this is what stops an overlay
 * appearing over a search box, a login form, or a checkout. Filling on *click*
 * is never gated — if the user pressed the button, they meant it.
 *
 * The test is deliberately about identity, not field count: a page qualifies
 * when the rule table alone recognises several distinct profile fields *and* at
 * least one of them is a strong identity signal. A login form resolves one key
 * (email) and is left alone; an application form resolves a dozen.
 *
 * Uses Tier 1 only — pure, local, no profile and no network, so this costs
 * nothing and reveals nothing.
 */
const STRONG_IDENTITY_KEYS = new Set<CanonicalKey>([
  'contact.email',
  'contact.phone',
  'personal.firstName',
  'personal.lastName',
  'personal.fullName',
]);

/** Below this it is a login box or a newsletter signup, not an application. */
const MIN_DISTINCT_KEYS = 3;

export function looksLikeIdentityForm(fields: FieldDescriptor[]): boolean {
  const keys = new Set<CanonicalKey>();

  for (const field of fields) {
    const hit = mapWithRules(toDto(field));
    if (hit) keys.add(hit.key);
  }

  if (keys.size < MIN_DISTINCT_KEYS) return false;
  return [...keys].some((key) => STRONG_IDENTITY_KEYS.has(key));
}

/**
 * Wait for an application form to mount, up to a few seconds.
 *
 * Returns the number of fields found, or 0 if the page never grows one — a
 * job *listing* is not an application, and filling nothing is the right answer
 * there.
 */
async function waitForFields(session: PageSession, timeoutMs = 6000): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const count = session.scan().length;
    // Two fields is a login box; a real application has more than that.
    if (count >= 3) return count;
    if (Date.now() >= deadline) return count >= 1 ? count : 0;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * Only one frame in a same-origin tree scans, and it is the outermost one — the
 * traversal in `scanner/traverse.ts` already descends into same-origin children.
 * A frame whose parent is cross-origin cannot be reached from above, so it scans
 * itself.
 */
function isRootScanFrame(): boolean {
  if (window === window.top) return true;
  try {
    // Throws (or yields null) for a cross-origin parent — then we are the root.
    return window.parent.document === null;
  } catch {
    return true;
  }
}
