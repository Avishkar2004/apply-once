/**
 * Pacing (ARCHITECTURE.md §3.3).
 *
 * "Fill sequentially with 30–80ms jitter between fields. Instantaneous parallel
 * fills break autocomplete widgets and trip naive bot heuristics."
 *
 * This is not evasion — the extension operates on a page the human opened, does
 * not submit, and identifies itself in the overlay. Pacing exists because
 * widgets genuinely need the frames, and because a 40-field form filling in one
 * tick is a worse experience than one filling in three seconds.
 */

export const FILL_DELAY_MIN_MS = 30;
export const FILL_DELAY_MAX_MS = 80;

/** Milliseconds a widget gets to render its listbox before we give up. */
export const WIDGET_TIMEOUT_MS = 2000;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function fillDelay(random: () => number = Math.random): number {
  return FILL_DELAY_MIN_MS + random() * (FILL_DELAY_MAX_MS - FILL_DELAY_MIN_MS);
}

export const pause = (random: () => number = Math.random): Promise<void> => sleep(fillDelay(random));

/**
 * Wait for an element to appear, via `MutationObserver` rather than polling.
 * Resolves `null` on timeout — the caller reports the field as ❌ rejected.
 */
export function waitForElement(
  root: ParentNode,
  selector: string,
  timeoutMs = WIDGET_TIMEOUT_MS,
): Promise<Element | null> {
  const existing = root.querySelector(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);

    const observer = new MutationObserver(() => {
      const found = root.querySelector(selector);
      if (!found) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(found);
    });

    // A MutationObserver cannot observe a Document itself — watch its root element.
    const target = (root as Document).documentElement ?? (root as Node);
    observer.observe(target, { childList: true, subtree: true });
  });
}
