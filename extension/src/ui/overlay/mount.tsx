import { createRoot, type Root } from 'react-dom/client';
import type { CanonicalKey } from '@autofill/core';
import type { DraftEmailResponse } from '@/shared/messages';
import type { FillOutcome } from '@/shared/types';
import type { EmailDetection } from '@/core/email/detect';
import type { ComposedEmail, SendMethod } from '@/core/email/send';
import { OVERLAY_HOST_ATTRIBUTE } from '@/core/scanner';
import { Overlay, type OverlayPhase } from './Overlay';
import { OVERLAY_CSS, PANEL_WIDTH } from './styles';
import { DRAG_HANDLE, defaultPosition, makeDraggable } from './drag';
import { rememberPosition, rememberedPosition } from './position-store';

/**
 * Mounts the review overlay into a **closed** shadow root
 * (ARCHITECTURE.md §3.5 — "isolated so page CSS cannot touch it").
 *
 * Closed rather than open, deliberately: the host page has no legitimate reason
 * to reach into our panel, and `mode: 'closed'` means `host.shadowRoot` is null
 * for page scripts. It is not a security boundary — a page can still see the
 * host element — but it removes the accidental-CSS and accidental-querySelector
 * failure modes entirely.
 *
 * The shadow boundary protects the panel's *contents*. The host element itself
 * is an ordinary node in the page's DOM, so every rule that decides where the
 * panel appears is written inline and `!important` here rather than in the
 * stylesheet — see the note on `all: initial` below.
 */

export interface OverlayHandlers {
  onClose: () => void;
  onRefill: () => void;
  onHighlight: (fieldId: string) => void;
  onCorrect: (outcome: FillOutcome, key: CanonicalKey) => Promise<void>;
  onOpenOptions: () => void;
  onDraft: (outcome: FillOutcome) => Promise<{ answer: string; source: 'bank' | 'llm' }>;
  onAcceptDraft: (outcome: FillOutcome, answer: string) => Promise<boolean>;
  onAttach: (outcome: FillOutcome) => Promise<{ ok: boolean; detail: string }>;
  // — Email Apply (§3.7) —
  onDraftEmail: (to: string) => Promise<DraftEmailResponse>;
  onSendEmail: (method: SendMethod, email: ComposedEmail, entryId: number) => Promise<boolean>;
  onDownloadDocument: (blobId: string) => Promise<{ ok: boolean; detail: string }>;
}

/**
 * Everything the panel needs that is not the phase itself.
 *
 * A bag rather than positional arguments: this is the second such fact after
 * `unreachableFrames`, and a third positional parameter is where a render call
 * becomes unreadable at the call site.
 */
export interface OverlayContext {
  unreachableFrames?: number;
  /** Absent when the page offers no application address. */
  email?: EmailDetection;
}

export interface OverlayController {
  render(phase: OverlayPhase, context?: OverlayContext): void;
  destroy(): void;
}

export function mountOverlay(handlers: OverlayHandlers, doc: Document = document): OverlayController {
  const host = doc.createElement('div');
  host.setAttribute(OVERLAY_HOST_ATTRIBUTE, '');

  // `all: initial` shields the host from inherited page styles — but it also
  // resets `position` to `static`, and an inline declaration outranks any rule
  // in our stylesheet. Leaving positioning to `:host` therefore did nothing,
  // and the panel rendered in the normal flow at the end of the document, which
  // is to say: at the very bottom of the page. Everything positional is set
  // here instead, with `!important` so a page stylesheet targeting the host
  // cannot move it either.
  host.style.setProperty('all', 'initial');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('margin', '0', 'important');
  host.style.setProperty('padding', '0', 'important');
  host.style.setProperty('width', 'auto', 'important');
  host.style.setProperty('height', 'auto', 'important');

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.append(style);

  const container = doc.createElement('div');
  shadow.append(container);
  doc.documentElement.append(host);

  const view = doc.defaultView ?? window;
  const initial =
    rememberedPosition() ??
    defaultPosition({ width: PANEL_WIDTH, height: 0 }, { width: view.innerWidth, height: view.innerHeight });

  const drag = makeDraggable({
    host,
    root: shadow,
    handle: DRAG_HANDLE,
    initial,
    onSettle: rememberPosition,
    window: view,
  });

  // The panel's height changes as sections fold open and as a fill completes.
  // Re-clamping on every size change is what stops it growing off the bottom of
  // the window, where its own scrollbar would be unreachable.
  const resize = new ResizeObserver(() => drag.reclamp());
  resize.observe(container);

  let root: Root | undefined = createRoot(container);

  return {
    render(phase, context = {}) {
      root?.render(
        <Overlay
          phase={phase}
          unreachableFrames={context.unreachableFrames ?? 0}
          {...(context.email ? { email: context.email } : {})}
          {...handlers}
        />,
      );
    },
    destroy() {
      resize.disconnect();
      drag.destroy();
      root?.unmount();
      root = undefined;
      host.remove();
    },
  };
}

export type { OverlayPhase } from './Overlay';
