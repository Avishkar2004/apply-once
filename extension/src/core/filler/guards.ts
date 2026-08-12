/**
 * The no-auto-submit guarantee.
 *
 * ARCHITECTURE.md §6.7: "No auto-submit. Architectural, not configurable. The
 * fill executor has no code path that clicks a submit button."
 *
 * Every synthetic click in the filler goes through `safeClick`, which refuses a
 * submit control. This is a hard invariant, covered by a unit test — not a
 * setting, not a confirmation dialog.
 */

export class AutoSubmitBlockedError extends Error {
  constructor(readonly element: Element) {
    super('Refused to click a submit control — AutoFill never submits an application.');
    this.name = 'AutoSubmitBlockedError';
  }
}

const SUBMIT_TEXT = /\b(submit|apply now|apply|send application|finish|complete application)\b/i;

export function isSubmitControl(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    // Checkboxes and radios are values, not actions — the label heuristic below
    // would misfire on a legitimate "Apply to all locations" checkbox.
    if (el.type === 'checkbox' || el.type === 'radio') return false;
    if (el.type === 'submit' || el.type === 'image') return true;
  }
  if (el instanceof HTMLButtonElement) {
    // A <button> inside a form defaults to type="submit".
    const type = el.getAttribute('type')?.toLowerCase() ?? (el.form ? 'submit' : 'button');
    if (type === 'submit') return true;
  }
  if (el.getAttribute('data-action') === 'submit') return true;

  // Text heuristic applies only to things that act like buttons.
  const actsLikeButton =
    el instanceof HTMLButtonElement ||
    el instanceof HTMLAnchorElement ||
    el.getAttribute('role') === 'button' ||
    (el instanceof HTMLInputElement && el.type === 'button');
  if (!actsLikeButton) return false;

  const label = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('value') ?? ''}`;
  return SUBMIT_TEXT.test(label);
}

/** The only click the filler is allowed to make. */
export function safeClick(el: Element): void {
  if (isSubmitControl(el)) throw new AutoSubmitBlockedError(el);
  (el as HTMLElement).click();
}

/**
 * `requestSubmit` / `form.submit` are never called anywhere in this codebase.
 * This assertion exists so the invariant is greppable and testable.
 */
export const NEVER_SUBMITS = true as const;
