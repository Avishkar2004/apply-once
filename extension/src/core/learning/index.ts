import type { CanonicalKey } from '@autofill/core';
import { invalidateCache } from '@/storage/mapping-cache';
import { clearOverride, overridesForHost, setOverride } from '@/storage/overrides';

/**
 * Learning from corrections (ARCHITECTURE.md §3.5, milestone M2).
 *
 * "Editing a row writes a learned override — `(hostname, signature) →
 * canonicalKey` at confidence 1.00. Next application on that site, Tier 0
 * catches it instantly."
 *
 * The cache invalidation is the part that is easy to forget: without it, a
 * cached Tier 2/3 verdict for the same signature would keep being consulted for
 * *other* fields sharing that signature, and the correction would look flaky.
 */

export interface Correction {
  hostname: string;
  signature: string;
  canonicalKey: CanonicalKey;
  /** The label as the user saw it — shown in the overrides list in settings. */
  label?: string;
}

export async function recordCorrection(correction: Correction): Promise<void> {
  await setOverride(correction);
  await invalidateCache(correction.hostname, correction.signature);
}

export async function forgetCorrection(hostname: string, signature: string): Promise<void> {
  await clearOverride(hostname, signature);
  await invalidateCache(hostname, signature);
}

/** Tier 0 input for one fill: every override this host has learned. */
export async function loadOverrides(hostname: string): Promise<ReadonlyMap<string, CanonicalKey>> {
  return overridesForHost(hostname);
}
