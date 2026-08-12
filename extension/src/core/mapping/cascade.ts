import type { CanonicalKey, MappingTarget } from '@autofill/core';
import { isCanonicalKey, UNMAPPABLE } from '@autofill/core';
import { CONFIDENCE, type FieldDescriptorDto, type FieldMapping } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { mapWithRules } from './tier1';

const log = createLogger('mapping/cascade');

/**
 * The 4-tier cascade (ARCHITECTURE.md §3.2).
 *
 * | Tier | Method                          | Latency | Confidence |
 * |------|---------------------------------|---------|------------|
 * | 0    | learned override / ATS adapter  | ~0ms    | 1.00       |
 * | 1    | deterministic rules             | ~0ms    | 0.95       |
 * | 2    | local embeddings                | ~50ms   | 0.60–0.90  |
 * | 3    | batched LLM call                | ~2s     | varies     |
 *
 * A field exits at the first tier that clears its confidence bar.
 *
 * Tiers 0 and 1 run per field because they are pure lookups. Tiers 2 and 3 run
 * **once over everything still unknown**: the embedder encodes a batch far
 * faster than N single labels, and §11 requires the LLM to "batch all unknowns
 * into one request" for the unit economics to work.
 *
 * Both expensive tiers are injected. When neither is registered — no model
 * downloaded, no API key — the cascade still runs and unknown fields become
 * `UNMAPPABLE`, surfacing as ⬜ in the overlay rather than failing the fill.
 */

export interface CascadeInput {
  hostname: string;
  fields: FieldDescriptorDto[];
  /** Tier 0, from the ATS adapter: field id → key, resolved by selector content-side. */
  adapterMappings?: Record<string, CanonicalKey>;
}

export interface CachedVerdict {
  canonicalKey: MappingTarget;
  confidence: number;
  source: FieldMapping['source'];
}

export interface TierVerdict {
  target: MappingTarget;
  confidence: number;
}

export interface CascadeDeps {
  /** Tier 0, user corrections: signature → key. Beats the adapter on ties (§3.2). */
  overrides: ReadonlyMap<string, CanonicalKey>;
  /** Cached tier 2/3 verdicts for this host: signature → verdict. */
  cache?: ReadonlyMap<string, CachedVerdict>;
  /** Tier 2 — local embedding match over everything tiers 0/1 missed. */
  embeddingMatcher?: (
    fields: FieldDescriptorDto[],
  ) => Promise<ReadonlyMap<string, { key: CanonicalKey; score: number }>>;
  /** Tier 3 — one batched call for everything still unknown. */
  llmMatcher?: (fields: FieldDescriptorDto[]) => Promise<ReadonlyMap<string, TierVerdict>>;
}

export interface CascadeResult {
  mappings: FieldMapping[];
  /** Tier 2/3 verdicts worth writing to the mapping cache. */
  cacheable: Array<{ signature: string } & CachedVerdict>;
}

export async function runCascade(input: CascadeInput, deps: CascadeDeps): Promise<CascadeResult> {
  const resolved = new Map<string, FieldMapping>();
  const cacheable: CascadeResult['cacheable'] = [];
  let pending: FieldDescriptorDto[] = [];

  const settle = (field: FieldDescriptorDto, mapping: Omit<FieldMapping, 'fieldId'>) => {
    resolved.set(field.id, { fieldId: field.id, ...mapping });
  };

  // ── Tiers 0 and 1, plus the per-host cache ──
  for (const field of input.fields) {
    const override = deps.overrides.get(field.signature);
    if (override) {
      settle(field, { target: override, confidence: CONFIDENCE.override, source: 'override' });
      continue;
    }

    const adapterKey = input.adapterMappings?.[field.id];
    if (adapterKey && isCanonicalKey(adapterKey)) {
      settle(field, { target: adapterKey, confidence: CONFIDENCE.adapter, source: 'adapter' });
      continue;
    }

    const rule = mapWithRules(field);
    if (rule) {
      log.debug(`rule ${rule.ruleId} → ${rule.key}`, field.labelBlob);
      settle(field, { target: rule.key, confidence: CONFIDENCE.rule, source: 'rule' });
      continue;
    }

    // Only fields the rules missed can have a cached tier 2/3 verdict.
    const cached = deps.cache?.get(field.signature);
    if (cached) {
      settle(field, {
        target: cached.canonicalKey,
        confidence: cached.confidence,
        source: cached.source,
      });
      continue;
    }

    pending.push(field);
  }

  // ── Tier 2: local embeddings, one batch ──
  if (pending.length > 0 && deps.embeddingMatcher) {
    const scores = await deps.embeddingMatcher(pending);
    const stillPending: FieldDescriptorDto[] = [];

    for (const field of pending) {
      const hit = scores.get(field.id);
      if (!hit || hit.score < CONFIDENCE.embeddingFloor) {
        stillPending.push(field);
        continue;
      }
      settle(field, { target: hit.key, confidence: hit.score, source: 'embedding' });
      cacheable.push({
        signature: field.signature,
        canonicalKey: hit.key,
        confidence: hit.score,
        source: 'embedding',
      });
    }
    pending = stillPending;
  }

  // ── Tier 3: one batched call for everything left ──
  if (pending.length > 0 && deps.llmMatcher) {
    const verdicts = await deps.llmMatcher(pending);
    for (const field of pending) {
      const verdict = verdicts.get(field.id);
      if (!verdict) continue;
      settle(field, {
        target: verdict.target,
        confidence: verdict.confidence,
        source: 'llm',
      });
      cacheable.push({
        signature: field.signature,
        canonicalKey: verdict.target,
        confidence: verdict.confidence,
        source: 'llm',
      });
    }
  }

  // Anything no tier could place. Reported honestly rather than guessed at.
  const mappings = input.fields.map(
    (field) =>
      resolved.get(field.id) ?? {
        fieldId: field.id,
        target: UNMAPPABLE,
        confidence: 0,
        source: 'rule' as const,
      },
  );

  return { mappings, cacheable };
}
