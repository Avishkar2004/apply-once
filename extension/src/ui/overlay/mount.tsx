import { createRoot, type Root } from 'react-dom/client';
import type { CanonicalKey } from '@autofill/core';
import type { FillOutcome } from '@/shared/types';
import { OVERLAY_HOST_ATTRIBUTE } from '@/core/scanner';
import { Overlay, type OverlayPhase } from './Overlay';
import { OVERLAY_CSS } from './styles';

/**
 * Mounts the review overlay into a **closed** shadow root
 * (ARCHITECTURE.md §3.5 — "isolated so page CSS cannot touch it").
 *
 * Closed rather than open, deliberately: the host page has no legitimate reason
 * to reach into our panel, and `mode: 'closed'` means `host.shadowRoot` is null
 * for page scripts. It is not a security boundary — a page can still see the
 * host element — but it removes the accidental-CSS and accidental-querySelector
 * failure modes entirely.
 */

export interface OverlayHandlers {
  onClose: () => void;
  onRefill: () => void;
  onHighlight: (fieldId: string) => void;
  onCorrect: (outcome: FillOutcome, key: CanonicalKey) => Promise<void>;
  onOpenOptions: () => void;
  onDraft: (outcome: FillOutcome) => Promise<{ answer: string; source: 'bank' | 'llm' }>;
  onAcceptDraft: (outcome: FillOutcome, answer: string) => Promise<boolean>;
}

export interface OverlayController {
  render(phase: OverlayPhase, unreachableFrames?: number): void;
  destroy(): void;
}

export function mountOverlay(handlers: OverlayHandlers, doc: Document = document): OverlayController {
  const host = doc.createElement('div');
  host.setAttribute(OVERLAY_HOST_ATTRIBUTE, '');
  // The panel positions itself from `:host`; the element itself stays inert.
  host.style.setProperty('all', 'initial');

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.append(style);

  const container = doc.createElement('div');
  shadow.append(container);
  doc.documentElement.append(host);

  let root: Root | undefined = createRoot(container);

  return {
    render(phase, unreachableFrames = 0) {
      root?.render(<Overlay phase={phase} unreachableFrames={unreachableFrames} {...handlers} />);
    },
    destroy() {
      root?.unmount();
      root = undefined;
      host.remove();
    },
  };
}

export type { OverlayPhase } from './Overlay';
