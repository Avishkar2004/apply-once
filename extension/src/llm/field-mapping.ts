import { z } from 'zod';
import {
  CANONICAL_KEYS,
  CANONICAL_KEY_META,
  FREE_TEXT,
  UNMAPPABLE,
  type MappingTarget,
} from '@autofill/core';
import type { FieldDescriptorDto } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { complete, parseJsonOutput } from './client';

const log = createLogger('llm/field-mapping');

/**
 * Tier 3 — one batched LLM call for everything the cheap tiers could not place
 * (ARCHITECTURE.md §3.2).
 *
 * "Input: field descriptors (labels + options only — **never profile values**),
 * the canonical key list, and the page's job title/company. Output: strict JSON
 * `{ fieldId, canonicalKey | "FREE_TEXT" | "UNMAPPABLE", confidence }`,
 * validated with Zod."
 *
 * The no-PII rule (§6.3) is enforced structurally: `toMappableField` builds its
 * payload field by field from an explicit allowlist. It never spreads the
 * descriptor, so a future field added to `FieldDescriptorDto` cannot leak into a
 * request by default — it has to be added here deliberately.
 */

/** One request per site, so the batch has to be bounded rather than unbounded. */
export const MAX_FIELDS_PER_CALL = 60;

/**
 * The response schema. Using an enum of the canonical vocabulary means the model
 * cannot invent a key — an invalid value fails validation instead of reaching
 * the fill executor.
 */
const MAPPING_TARGET = z.enum([...CANONICAL_KEYS, FREE_TEXT, UNMAPPABLE]);

export const FIELD_MAPPING_RESULT = z.object({
  mappings: z.array(
    z.object({
      fieldId: z.string(),
      canonicalKey: MAPPING_TARGET,
      confidence: z.number(),
    }),
  ),
});

export type FieldMappingResult = z.infer<typeof FIELD_MAPPING_RESULT>;

/**
 * The same schema as JSON Schema, for providers that constrain generation with
 * one. Built once — `toJSONSchema` walks the whole canonical key enum.
 */
const MAPPING_JSON_SCHEMA = z.toJSONSchema(FIELD_MAPPING_RESULT) as Record<string, unknown>;

/** Exactly what leaves the device. Label-level only — see the module note. */
export interface MappableField {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  section?: string;
  maxLength?: number;
  options?: string[];
}

export function toMappableField(field: FieldDescriptorDto): MappableField {
  const payload: MappableField = {
    id: field.id,
    // Both are derived from page text; neither can contain profile data.
    label: field.displayLabel || field.labelBlob,
    kind: field.kind,
    required: field.required,
  };
  if (field.sectionHeading) payload.section = field.sectionHeading;
  if (field.maxLength !== undefined) payload.maxLength = field.maxLength;
  if (field.options?.length) {
    // Option text only; a select's values are authored by the site, not by us.
    payload.options = field.options.slice(0, 25).map((option) => option.text || option.value);
  }
  return payload;
}

export interface PageContext {
  hostname: string;
  jobTitle?: string;
  company?: string;
}

const SYSTEM_PROMPT = `You map form fields on a job application to a fixed vocabulary of profile keys.

For each field you are given its visible label, control kind, section heading, and any options. Decide which profile key the applicant's data should go into.

Return one entry per field you were given, using the field's id verbatim.

- Pick the canonical key whose meaning matches the field. Use the section heading to disambiguate: "Start date" under an Education heading is an education date, not an employment one.
- Return FREE_TEXT for open questions that need a written answer rather than a stored value ("Why do you want to work here?", "Describe a challenging project").
- Return UNMAPPABLE when no key fits, or when the field is about the company rather than the applicant. Guessing wrongly is worse than declining: a wrong mapping puts the wrong data in a submitted application.
- confidence is 0..1 — how sure you are. Below 0.6 means you are guessing; return UNMAPPABLE instead.

Never infer voluntary self-identification (eeo.*) from anything other than an explicit label match. You are mapping labels to keys; you never see and never produce the applicant's actual values.`;

function keyReference(): string {
  return CANONICAL_KEYS.map((key) => `${key} — ${CANONICAL_KEY_META[key].label}`).join('\n');
}

function buildUserPrompt(fields: MappableField[], context: PageContext): string {
  const where = [
    context.company ? `Company: ${context.company}` : undefined,
    context.jobTitle ? `Role: ${context.jobTitle}` : undefined,
    `Site: ${context.hostname}`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    where,
    '',
    'Canonical keys:',
    keyReference(),
    '',
    'Fields to map:',
    JSON.stringify(fields, null, 1),
  ].join('\n');
}

/**
 * Map a batch of unknown fields. Returns `fieldId → verdict`.
 *
 * Throws `LlmDisabledError` when the LLM tiers are unavailable — the cascade
 * treats that as "no Tier 3" and degrades to ⬜ skipped rather than failing the
 * fill.
 */
export async function mapFieldsWithLlm(
  fields: FieldDescriptorDto[],
  context: PageContext,
): Promise<ReadonlyMap<string, { target: MappingTarget; confidence: number }>> {
  const verdicts = new Map<string, { target: MappingTarget; confidence: number }>();
  if (fields.length === 0) return verdicts;

  const batch = fields.slice(0, MAX_FIELDS_PER_CALL);
  if (fields.length > batch.length) {
    // Never let a cap be silent (§10 — accuracy has to stay measurable).
    log.warn(
      `${fields.length} unknown fields exceeds the ${MAX_FIELDS_PER_CALL}-field batch cap; ` +
        `${fields.length - batch.length} will be reported as unmapped`,
    );
  }

  const payload = batch.map(toMappableField);

  const { text } = await complete('mapping', {
    maxTokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(payload, context) }],
    json: { name: 'field_mappings', schema: MAPPING_JSON_SCHEMA },
  });

  // Validated here rather than trusted: not every provider enforces a schema,
  // and an invented key must fail validation instead of reaching the executor.
  const parsed = FIELD_MAPPING_RESULT.safeParse(parseJsonOutput(text));
  if (!parsed.success) {
    log.warn('Tier 3 returned no parseable output', parsed.error.issues[0]?.message);
    return verdicts;
  }

  const known = new Set(batch.map((field) => field.id));
  for (const mapping of parsed.data.mappings) {
    // The model echoes ids back; ignore anything it invented.
    if (!known.has(mapping.fieldId)) continue;
    verdicts.set(mapping.fieldId, {
      target: mapping.canonicalKey as MappingTarget,
      confidence: Math.min(Math.max(mapping.confidence, 0), 1),
    });
  }

  log.info(`Tier 3 mapped ${verdicts.size}/${batch.length} fields on ${context.hostname}`);
  return verdicts;
}
