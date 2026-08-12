import type { CanonicalKey } from '@autofill/core';
import { normalizeLabel } from '@autofill/core';
import type { FieldDescriptorDto } from '@/shared/types';
import { AUTOCOMPLETE_RULES, LABEL_RULES, SECTION_OVERRIDES, type LabelRule } from './rules';

/**
 * Tier 1 — deterministic rules. ~0ms, confidence 0.95 (ARCHITECTURE.md §3.2).
 *
 * Order of attempts:
 *   1. the `autocomplete` attribute, when the site set an honest one
 *   2. the ordered label-rule table, first match wins
 *   3. the section heading, which can redirect an ambiguous match
 */

export interface Tier1Hit {
  key: CanonicalKey;
  /** Which rule fired — surfaced in the mapping debug view and asserted in tests. */
  ruleId: string;
}

/** `"section-a shipping given-name"` → `"given-name"`. */
export function normalizeAutocomplete(token: string): string {
  const parts = token.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export function matchAutocomplete(field: FieldDescriptorDto): Tier1Hit | null {
  if (!field.autocomplete) return null;
  const token = normalizeAutocomplete(field.autocomplete);
  const key = AUTOCOMPLETE_RULES[token];
  return key ? { key, ruleId: `autocomplete:${token}` } : null;
}

export function matchLabelRules(
  field: FieldDescriptorDto,
  rules: LabelRule[] = LABEL_RULES,
): Tier1Hit | null {
  const blob = field.labelBlob;
  if (!blob) return null;

  for (const rule of rules) {
    if (rule.kinds && !rule.kinds.includes(field.kind)) continue;
    if (!rule.match.test(blob)) continue;
    if (rule.not?.test(blob)) continue;
    return { key: rule.key, ruleId: rule.id };
  }
  return null;
}

/**
 * Let the section heading redirect a match. "Start date" under an "Education"
 * heading is an education date, not an employment one.
 */
export function applySectionHeading(hit: Tier1Hit, sectionHeading: string | undefined): Tier1Hit {
  if (!sectionHeading) return hit;
  const heading = normalizeLabel(sectionHeading);
  for (const rule of SECTION_OVERRIDES) {
    if (rule.from === hit.key && rule.heading.test(heading)) {
      return { key: rule.to, ruleId: `${hit.ruleId}+section` };
    }
  }
  return hit;
}

export function mapWithRules(field: FieldDescriptorDto): Tier1Hit | null {
  const hit = matchAutocomplete(field) ?? matchLabelRules(field);
  return hit ? applySectionHeading(hit, field.sectionHeading) : null;
}
