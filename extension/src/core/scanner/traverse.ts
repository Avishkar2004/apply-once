import { createLogger } from '@/shared/logger';

const log = createLogger('scanner/traverse');

/**
 * DOM traversal (ARCHITECTURE.md §3.1).
 *
 *  - **Shadow DOM** — every open `shadowRoot` is recursed into. Closed roots are
 *    inaccessible to any extension; they are counted and reported as "cannot
 *    fill" rather than silently dropped.
 *  - **Same-origin iframes** — recursed into via `contentDocument`.
 *  - **Cross-origin iframes** — flagged, not filled. The content script is
 *    registered with `all_frames`, so a cross-origin frame on an ATS host runs
 *    its own instance and fills itself; a frame on any other host is genuinely
 *    out of reach.
 */

export interface TraversalResult {
  elements: Element[];
  /** Frames we could not see into. Surfaced in the overlay as a caveat. */
  unreachableFrames: number;
  /** Closed shadow roots encountered. Diagnostic only. */
  closedShadowRoots: number;
}

/** Everything that can hold a value, native or ARIA. */
const CONTROL_SELECTOR = [
  'input',
  'select',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="radiogroup"]',
].join(',');

/** Input types that hold no user data, or that we must never touch. */
const IGNORED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

const MAX_FRAME_DEPTH = 5;

export function collectControls(root: Document | ShadowRoot): TraversalResult {
  const result: TraversalResult = { elements: [], unreachableFrames: 0, closedShadowRoots: 0 };
  walk(root, result, 0);
  return result;
}

function walk(root: Document | ShadowRoot, result: TraversalResult, depth: number): void {
  for (const el of root.querySelectorAll(CONTROL_SELECTOR)) {
    if (isCandidate(el)) result.elements.push(el);
  }

  // Shadow roots are not reachable from querySelectorAll, so walk hosts separately.
  for (const el of root.querySelectorAll('*')) {
    const shadow = el.shadowRoot;
    if (shadow) {
      walk(shadow, result, depth);
    } else if (isLikelyClosedShadowHost(el)) {
      result.closedShadowRoots += 1;
    }
  }

  if (depth >= MAX_FRAME_DEPTH) return;

  for (const frame of root.querySelectorAll('iframe, frame')) {
    const doc = sameOriginDocument(frame as HTMLIFrameElement);
    if (doc) walk(doc, result, depth + 1);
    else result.unreachableFrames += 1;
  }
}

function sameOriginDocument(frame: HTMLIFrameElement): Document | null {
  try {
    // Throws a SecurityError for cross-origin frames — that is the check.
    return frame.contentDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * A custom element with no children and no accessible shadow root is the usual
 * shape of a closed root. Heuristic, and only used for the diagnostic counter.
 */
function isLikelyClosedShadowHost(el: Element): boolean {
  return el.tagName.includes('-') && el.childElementCount === 0 && el.shadowRoot === null;
}

export function isCandidate(el: Element): boolean {
  if (el instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(el.type)) return false;
  if (isDisabled(el)) return false;
  if (!isVisible(el)) return false;
  return true;
}

export function isDisabled(el: Element): boolean {
  if (el instanceof HTMLSelectElement) return el.disabled;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // A read-only combobox trigger is normal — the widget writes the value, not
    // the keyboard — so read-only only disqualifies genuinely plain inputs.
    return el.disabled || (el.readOnly && !isComboboxLike(el));
  }
  return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
}

export function isComboboxLike(el: Element): boolean {
  return (
    el.getAttribute('role') === 'combobox' ||
    el.hasAttribute('aria-autocomplete') ||
    el.getAttribute('aria-haspopup') === 'listbox' ||
    el.hasAttribute('aria-expanded')
  );
}

/**
 * Visibility.
 *
 * Two deliberate choices:
 *
 *  - A `file` input is exempt. Forms almost always hide the real input behind a
 *    styled button, and it still has to be filled.
 *  - Size is not part of the test. A field inside a collapsed accordion or an
 *    unmounted wizard step has zero size and is still a field the user will
 *    reach; excluding it would silently drop half of a multi-step application.
 *    Only CSS that actually removes the element counts.
 */
export function isVisible(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'file') return true;
  if (!(el instanceof HTMLElement)) return true;
  if (el.hidden) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;

  // The precise API where it exists; computed style everywhere else.
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    log.debug('hidden control skipped', el.tagName);
    return false;
  }
  return true;
}
