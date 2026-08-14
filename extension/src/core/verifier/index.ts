import { compactKey } from '@autofill/core';
import {
  CONFIDENCE,
  type FieldDescriptor,
  type FillOutcome,
  type FillPlan,
  type FillSummary,
  type SkipReason,
} from '@/shared/types';
import type { FillAttempt } from '@/core/filler';

/**
 * The verifier (ARCHITECTURE.md §3.4).
 *
 * After filling, re-read every field and compare against intent:
 *
 *   ✅ filled          — value matches
 *   ⚠️ low confidence  — filled, but the mapping scored below threshold
 *   ❌ rejected        — written, then reverted or cleared by the page
 *   ⬜ skipped         — no mapping, or no profile data for the mapped key
 *
 * "Silent partial fills are worse than no fill, because you submit an
 * application with a blank required field and never learn why."
 */

const SKIP_REASONS: Record<SkipReason, string> = {
  unmapped: 'No matching profile field',
  'no-profile-data': 'Your profile has nothing for this',
  'free-text': 'Free-text question — needs a written answer',
  'not-fillable': 'This control cannot be filled',
  'eeo-disabled': 'Voluntary self-identification is turned off',
  'cross-origin-frame': 'Inside a frame AutoFill cannot reach',
  'needs-attach': 'Uploading re-runs this site’s own résumé parser, so it is your call',
};

export function verifyFills(
  fields: ReadonlyMap<string, FieldDescriptor>,
  plan: FillPlan,
  attempts: FillAttempt[],
): FillOutcome[] {
  const outcomes: FillOutcome[] = [];

  for (const attempt of attempts) {
    const field = fields.get(attempt.fieldId);
    if (!field) continue;

    const actual = readCurrentValue(field);
    const base = {
      fieldId: attempt.fieldId,
      label: field.displayLabel,
      key: attempt.key,
      intended: attempt.intended,
      actual,
      confidence: attempt.confidence,
      source: attempt.source,
      signature: field.signature,
      kind: field.kind,
      ...(field.options ? { options: field.options } : {}),
    };

    if (attempt.error) {
      outcomes.push({ ...base, status: 'rejected', reason: attempt.error });
      continue;
    }

    if (!valueLanded(field, attempt.wrote ?? attempt.intended, actual)) {
      outcomes.push({
        ...base,
        status: 'rejected',
        reason: 'The page cleared or overwrote the value',
      });
      continue;
    }

    outcomes.push({
      ...base,
      status: attempt.confidence < CONFIDENCE.reviewThreshold ? 'low-confidence' : 'filled',
    });
  }

  // Recalled answers (§3.6). They have no canonical key and no profile value,
  // so they are verified purely on whether the value is on the page now.
  for (const answered of plan.answers ?? []) {
    const field = fields.get(answered.fieldId);
    if (!field) continue;

    const actual = readCurrentValue(field);
    const landed = valueLanded(field, answered.answer, actual);

    outcomes.push({
      fieldId: answered.fieldId,
      label: field.displayLabel,
      status: landed ? 'filled' : 'rejected',
      intended: answered.answer,
      actual,
      confidence: 1,
      source: 'override',
      signature: field.signature,
      kind: field.kind,
      ...(field.options ? { options: field.options } : {}),
      ...(landed ? {} : { reason: 'Your saved answer did not stay in the field' }),
    });
  }

  for (const skip of plan.skipped) {
    const field = fields.get(skip.fieldId);
    if (!field) continue;
    outcomes.push({
      fieldId: skip.fieldId,
      label: field.displayLabel,
      status: 'skipped',
      reason: SKIP_REASONS[skip.reason],
      skipReason: skip.reason,
      signature: field.signature,
      // The panel offers a way to answer an unmapped question, and needs the
      // control's shape to offer the right one.
      kind: field.kind,
      ...(field.options ? { options: field.options } : {}),
      ...(skip.key ? { key: skip.key } : {}),
    });
  }

  return outcomes;
}

export function summarise(outcomes: FillOutcome[], durationMs: number): FillSummary {
  const summary: FillSummary = {
    filled: 0,
    lowConfidence: 0,
    rejected: 0,
    skipped: 0,
    total: outcomes.length,
    durationMs,
  };
  for (const outcome of outcomes) {
    if (outcome.status === 'filled') summary.filled += 1;
    else if (outcome.status === 'low-confidence') summary.lowConfidence += 1;
    else if (outcome.status === 'rejected') summary.rejected += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/** What the DOM holds now, per control kind. */
export function readCurrentValue(field: FieldDescriptor): string {
  const el = field.el.deref();
  if (!el || !el.isConnected) return '';

  if (el instanceof HTMLSelectElement) {
    return el.selectedOptions[0]?.text ?? el.value;
  }

  if (field.kind === 'radio-group') {
    const radios = (field.radios ?? []).map((ref) => ref.deref());
    const checkedIndex = radios.findIndex((radio) => radio?.checked);
    if (checkedIndex < 0) return '';
    return field.options?.[checkedIndex]?.text ?? radios[checkedIndex]?.value ?? '';
  }

  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked ? 'checked' : 'unchecked';
    if (el.type === 'file') return el.files?.[0]?.name ?? '';
    return el.value;
  }

  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el.getAttribute('contenteditable') !== null) return el.textContent ?? '';
  return (el as HTMLInputElement).value ?? '';
}

/**
 * Did the value actually land?
 *
 * Exact equality is too strict: a combobox stores a code and displays a name, a
 * phone input reformats as you type, a select shows option text rather than its
 * value. Containment in either direction, on a compacted key, is the honest test
 * — it catches the failure that matters (the field is empty or holds something
 * else) without flagging cosmetic reformatting.
 */
export function valueLanded(field: FieldDescriptor, intended: string, actual: string): boolean {
  if (field.kind === 'checkbox') return actual === intended;
  if (!intended) return true;
  if (!actual) return false;

  const a = compactKey(actual);
  const b = compactKey(intended);
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}
