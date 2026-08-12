import { defineContentScript } from 'wxt/utils/define-content-script';
import { PageSession } from '@/core/session';
import { observeChanges } from '@/core/scanner';
import { createLogger } from '@/shared/logger';
import { ATS_MATCH_PATTERNS } from '@/shared/hosts';
import { registerHandlers, sendToBackground } from '@/shared/messaging';
import { mountOverlay, type OverlayController, type OverlayPhase } from '@/ui/overlay/mount';

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
    if (!isRootScanFrame()) {
      log.debug('same-origin child frame — the parent scans this subtree');
      return;
    }

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
        const result = await session.fill((done, total) => setPhase({ kind: 'filling', done, total }));
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
