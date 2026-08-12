import {
  FREE_TEXT,
  isCanonicalKey,
  resolveValue,
  sniffDateFormat,
  type Profile,
} from '@autofill/core';
import type {
  FieldDescriptorDto,
  FieldMapping,
  FillInstruction,
  FillPlan,
  SkippedField,
} from '@/shared/types';

/**
 * Mapping + profile → an executable fill plan.
 *
 * This is the only place a profile *value* enters the pipeline, and it runs in
 * the service worker where the DEK lives. The content script receives resolved
 * values for the fields it is about to fill, and nothing else.
 */

export interface PlanOptions {
  /**
   * Voluntary self-identification is off by default (ARCHITECTURE.md §4).
   * Even when the profile carries an EEO answer, it is only filled if the user
   * turned this on.
   */
  fillEeo: boolean;
}

export function buildFillPlan(
  fields: FieldDescriptorDto[],
  mappings: FieldMapping[],
  profile: Profile,
  options: PlanOptions,
): FillPlan {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const instructions: FillInstruction[] = [];
  const skipped: SkippedField[] = [];

  for (const mapping of mappings) {
    const field = byId.get(mapping.fieldId);
    if (!field) continue;

    if (mapping.target === FREE_TEXT) {
      // Routes to the Answer Generator (ARCHITECTURE.md §3.6) — milestone M4.
      skipped.push({ fieldId: field.id, reason: 'free-text' });
      continue;
    }

    if (!isCanonicalKey(mapping.target)) {
      skipped.push({ fieldId: field.id, reason: 'unmapped' });
      continue;
    }

    const key = mapping.target;

    if (key.startsWith('eeo.') && !options.fillEeo) {
      skipped.push({ fieldId: field.id, reason: 'eeo-disabled', key });
      continue;
    }

    const value = resolveValue(profile, key, {
      ...(field.rowIndex !== undefined ? { rowIndex: field.rowIndex } : {}),
      ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      dateFormat: sniffDateFormat({
        inputType: field.inputType,
        placeholder: field.placeholder,
        pattern: field.pattern,
      }),
    });

    if (!value) {
      skipped.push({ fieldId: field.id, reason: 'no-profile-data', key });
      continue;
    }

    instructions.push({
      fieldId: field.id,
      key,
      value,
      confidence: mapping.confidence,
      source: mapping.source,
    });
  }

  return { instructions, skipped };
}
