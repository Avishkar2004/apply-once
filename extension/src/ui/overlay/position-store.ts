import { browser } from 'wxt/browser';
import type { Point } from './drag';

/**
 * Where the user last put the review panel.
 *
 * Stored once for every site rather than per host: someone who moves the panel
 * to the left of their screen means it there, and re-dragging it on each new
 * job board would be the opposite of a preference.
 *
 * Read into memory at content-script start so the panel can be positioned
 * synchronously when it mounts — `storage.local` is async, and resolving it
 * during mount would show the panel in one place and then jump it to another.
 */

const KEY = 'overlay:position';

let cached: Point | undefined;
let primed = false;

export async function primePosition(): Promise<void> {
  if (primed) return;
  primed = true;
  try {
    const stored = await browser.storage.local.get(KEY);
    const value = (stored as Record<string, unknown>)[KEY];
    if (isPoint(value)) cached = value;
  } catch {
    // A remembered position is a convenience. The default is a fine answer.
  }
}

export function rememberedPosition(): Point | undefined {
  return cached;
}

export function rememberPosition(point: Point): void {
  cached = point;
  void browser.storage.local.set({ [KEY]: point }).catch(() => undefined);
}

function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y } = value as Partial<Point>;
  return Number.isFinite(x) && Number.isFinite(y);
}
