import type { CanonicalKey } from '@autofill/core';
import type { FieldDescriptor, FillInstruction, FillPlan, MappingSource } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { AutoSubmitBlockedError } from './guards';
import { pause } from './pacing';
import {
  fillCheckbox,
  fillCombobox,
  fillFile,
  fillRadioGroup,
  fillSelect,
  fillTextarea,
  fillTextLike,
  type FillContext,
  type FillValue,
  type StrategyOutcome,
} from './strategies';

export * from './guards';
export * from './native-setter';
export * from './option-matcher';
export * from './pacing';
export * from './strategies';

const log = createLogger('filler');

/** What the executor believes it did. The verifier decides what actually happened. */
export interface FillAttempt {
  fieldId: string;
  key: CanonicalKey;
  intended: string;
  wrote?: string;
  error?: string;
  confidence: number;
  source: MappingSource;
}

export interface ExecuteOptions extends FillContext {
  /** Injected for deterministic tests. */
  random?: () => number;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Run the plan against the live DOM, sequentially and paced
 * (ARCHITECTURE.md §3.3).
 *
 * Sequential is deliberate: parallel writes break autocomplete widgets, and a
 * combobox that is mid-open when the next field steals focus loses its value.
 */
export async function executePlan(
  fields: ReadonlyMap<string, FieldDescriptor>,
  plan: FillPlan,
  options: ExecuteOptions = {},
): Promise<FillAttempt[]> {
  const attempts: FillAttempt[] = [];
  const total = plan.instructions.length;

  for (const [index, instruction] of plan.instructions.entries()) {
    const field = fields.get(instruction.fieldId);
    if (!field) {
      attempts.push(baseAttempt(instruction, { error: 'field disappeared before filling' }));
      continue;
    }

    const el = field.el.deref();
    if (!el || !el.isConnected) {
      attempts.push(baseAttempt(instruction, { error: 'field was removed from the page' }));
      continue;
    }

    let outcome: StrategyOutcome;
    try {
      outcome = await applyStrategy(field, instruction, options);
    } catch (error) {
      if (error instanceof AutoSubmitBlockedError) {
        // The invariant held. Report it loudly — it means a mapping pointed at a
        // submit control, which is a bug in an adapter or a rule.
        log.error('blocked a click on a submit control', error.element);
        outcome = { ok: false, reason: 'refused to click a submit control' };
      } else {
        outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }

    attempts.push(
      outcome.ok
        ? baseAttempt(instruction, { wrote: outcome.wrote })
        : baseAttempt(instruction, { error: outcome.reason }),
    );

    options.onProgress?.(index + 1, total);
    if (index < total - 1) await pause(options.random);
  }

  return attempts;
}

/**
 * Write an approved answer (ARCHITECTURE.md §3.6).
 *
 * Separate from `executePlan` on purpose: an answer has no canonical key and no
 * profile value behind it, and §3.6 requires an explicit approval click before
 * anything reaches the page. This is the function that click calls.
 *
 * It dispatches on control kind like any other fill. Screener questions are
 * very often a Yes/No radio pair or a dropdown — "Do you have your own laptop
 * which you can use for work?" — and writing "Yes" into a radio group as though
 * it were a text box does nothing at all.
 */
export async function fillFreeText(
  field: FieldDescriptor,
  text: string,
  options: ExecuteOptions = {},
): Promise<StrategyOutcome> {
  const el = field.el.deref();
  if (!el || !el.isConnected) return { ok: false, reason: 'field was removed from the page' };

  const affirmative = /^(yes|y|true|1|agree|accept)$/i.test(text.trim());
  const negative = /^(no|n|false|0|decline)$/i.test(text.trim());

  return writeValue(
    field,
    {
      text,
      candidates: [text],
      // A checkbox has no option text to match against, so a yes/no answer has
      // to arrive as the boolean the strategy actually reads.
      ...(field.kind === 'checkbox' && (affirmative || negative) ? { boolean: affirmative } : {}),
    },
    options,
  );
}

function baseAttempt(
  instruction: FillInstruction,
  extra: { wrote?: string; error?: string },
): FillAttempt {
  return {
    fieldId: instruction.fieldId,
    key: instruction.key,
    intended: instruction.value.text,
    confidence: instruction.confidence,
    source: instruction.source,
    ...extra,
  };
}

const applyStrategy = (
  field: FieldDescriptor,
  instruction: FillInstruction,
  options: ExecuteOptions,
): Promise<StrategyOutcome> => writeValue(field, instruction.value, options);

/** The one place that decides how a value reaches a control. */
async function writeValue(
  field: FieldDescriptor,
  value: FillValue,
  options: ExecuteOptions,
): Promise<StrategyOutcome> {
  const el = field.el.deref();
  if (!el) return { ok: false, reason: 'element is gone' };

  switch (field.kind) {
    case 'select':
      return fillSelect(el, value);
    case 'checkbox':
      return fillCheckbox(el, value);
    case 'radio-group':
      return fillRadioGroup(field, value);
    case 'combobox':
      return fillCombobox(field, value, options);
    case 'file':
      return fillFile(el, value, options);
    case 'textarea':
      return fillTextarea(el, value);
    default:
      return fillTextLike(el, value);
  }
}
