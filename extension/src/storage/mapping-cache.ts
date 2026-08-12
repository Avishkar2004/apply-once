import { stableHash } from '@autofill/core';
import type { MappingSource } from '@/shared/types';
import { db, type MappingCacheRecord } from './db';

/**
 * The mapping cache (ARCHITECTURE.md §3.2, §11).
 *
 * Keyed by `hash(hostname + signature)` so an expensive resolution happens once
 * per *site*, not once per application. Tiers 2 and 3 write here; Tier 0/1 do not
 * (they are already free, and caching them would only add a way to go stale).
 */

export const cacheKeyFor = (hostname: string, signature: string): string =>
  stableHash(`${hostname}|${signature}`);

export async function readCache(
  hostname: string,
  signatures: string[],
): Promise<Map<string, MappingCacheRecord>> {
  const keys = signatures.map((signature) => cacheKeyFor(hostname, signature));
  const records = await db().mappingCache.bulkGet(keys);
  const out = new Map<string, MappingCacheRecord>();
  records.forEach((record, index) => {
    const signature = signatures[index];
    if (record && signature) out.set(signature, record);
  });
  return out;
}

export async function writeCache(
  hostname: string,
  entries: Array<{
    signature: string;
    canonicalKey: MappingCacheRecord['canonicalKey'];
    confidence: number;
    source: MappingSource;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  const createdAt = new Date().toISOString();
  await db().mappingCache.bulkPut(
    entries.map((entry) => ({
      cacheKey: cacheKeyFor(hostname, entry.signature),
      hostname,
      canonicalKey: entry.canonicalKey,
      confidence: entry.confidence,
      source: entry.source,
      createdAt,
    })),
  );
}

/** Called when a user correction contradicts a cached guess. */
export async function invalidateCache(hostname: string, signature: string): Promise<void> {
  await db().mappingCache.delete(cacheKeyFor(hostname, signature));
}

export async function clearCacheForHost(hostname: string): Promise<void> {
  await db().mappingCache.where('hostname').equals(hostname).delete();
}
