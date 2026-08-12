import type { CanonicalKey } from '@autofill/core';
import { db, type OverrideRecord } from './db';

/**
 * Learned overrides — `(hostname, signature) → canonicalKey` at confidence 1.00
 * (ARCHITECTURE.md §3.5).
 *
 * "Correcting a field once fixes it forever on that site" is milestone M2's
 * acceptance test, and this table is the whole mechanism. Stored in the clear:
 * it holds hostnames and key *names*, never values, and Tier 0 is specified at
 * ~0ms.
 */

export const overrideId = (hostname: string, signature: string): string =>
  `${hostname}::${signature}`;

export async function setOverride(input: {
  hostname: string;
  signature: string;
  canonicalKey: CanonicalKey;
  label?: string;
}): Promise<void> {
  await db().overrides.put({
    id: overrideId(input.hostname, input.signature),
    hostname: input.hostname,
    signature: input.signature,
    canonicalKey: input.canonicalKey,
    ...(input.label ? { label: input.label } : {}),
    createdAt: new Date().toISOString(),
  });
}

export async function clearOverride(hostname: string, signature: string): Promise<void> {
  await db().overrides.delete(overrideId(hostname, signature));
}

/** Every override for a host, as `signature → canonicalKey`. One indexed read per fill. */
export async function overridesForHost(hostname: string): Promise<Map<string, CanonicalKey>> {
  const records = await db().overrides.where('hostname').equals(hostname).toArray();
  return new Map(records.map((record) => [record.signature, record.canonicalKey]));
}

export async function listOverrides(hostname?: string): Promise<OverrideRecord[]> {
  const table = db().overrides;
  const records = hostname
    ? await table.where('hostname').equals(hostname).toArray()
    : await table.toArray();
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
