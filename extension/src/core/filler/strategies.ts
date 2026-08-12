import type { DocumentRef, ResolvedValue } from '@autofill/core';
import type { FieldDescriptor, FieldOption } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { queryRoot } from '@/core/scanner/label-resolver';
import { safeClick } from './guards';
import {
  dispatchInputEvents,
  setNativeValue,
  simulateKeystrokes,
  writeValue,
} from './native-setter';
import { matchOption } from './option-matcher';
import { pause, waitForElement, WIDGET_TIMEOUT_MS } from './pacing';

const log = createLogger('filler/strategies');

/** Per-ATS combobox behaviour (ARCHITECTURE.md §3.3, §5). */
export interface ComboboxStrategy {
  /** Selector for the element that opens the listbox, relative to the container. */
  trigger?: string;
  /** Selector for the listbox, searched from the document root once open. */
  listbox?: string;
  /** Selector for options inside the listbox. */
  option?: string;
  /** Type the value into the trigger to filter before selecting. */
  typeToFilter?: boolean;
}

export const DEFAULT_COMBOBOX_STRATEGY: Required<ComboboxStrategy> = {
  trigger: '',
  listbox: '[role="listbox"], [role="menu"], ul[class*="menu"], div[class*="dropdown"][class*="open"]',
  option: '[role="option"], li[role="option"], li, [data-option]',
  typeToFilter: true,
};

export interface FillContext {
  strategy?: ComboboxStrategy;
  /** Resolves a stored document to bytes. Injected so the filler stays testable. */
  fetchDocument?: (blobId: string) => Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
}

export type StrategyOutcome =
  | { ok: true; wrote: string }
  | { ok: false; reason: string };

/**
 * What a strategy actually needs in order to write.
 *
 * A structural subset of `ResolvedValue`, so every profile-derived value
 * satisfies it — but an Answer Generator draft (§3.6), which has no canonical
 * key behind it, can be written through the same strategies without inventing
 * one.
 */
export interface FillValue {
  text: string;
  candidates: string[];
  boolean?: boolean;
  file?: DocumentRef;
}

/** `ResolvedValue` is assignable to `FillValue`; this asserts it at compile time. */
const _resolvedIsFillable: (value: ResolvedValue) => FillValue = (value) => value;
void _resolvedIsFillable;

/** Text, email, tel, number, date — the native-setter path (ARCHITECTURE.md §3.3). */
export function fillTextLike(el: Element, value: FillValue): StrategyOutcome {
  if (
    !(el instanceof HTMLInputElement) &&
    !(el instanceof HTMLTextAreaElement)
  ) {
    if (el.getAttribute('contenteditable') !== null) return fillContentEditable(el, value.text);
    return { ok: false, reason: 'not a text control' };
  }

  writeValue(el, value.text);
  return { ok: true, wrote: value.text };
}

/** Textarea: native setter plus a keystroke burst when a character counter is watching. */
export function fillTextarea(el: Element, value: FillValue): StrategyOutcome {
  const outcome = fillTextLike(el, value);
  if (outcome.ok && hasCharacterCounter(el)) simulateKeystrokes(el, value.text);
  return outcome;
}

function fillContentEditable(el: Element, text: string): StrategyOutcome {
  (el as HTMLElement).focus();
  el.textContent = text;
  dispatchInputEvents(el);
  (el as HTMLElement).blur();
  return { ok: true, wrote: text };
}

function hasCharacterCounter(el: Element): boolean {
  const container = el.parentElement;
  if (!container) return false;
  if (container.querySelector('[class*="count"], [class*="remaining"], [data-counter]')) return true;
  return /\d+\s*\/\s*\d+/.test(container.textContent ?? '');
}

/** `select`: match an option, set `selectedIndex`, dispatch `change`. */
export function fillSelect(el: Element, value: FillValue): StrategyOutcome {
  if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: 'not a select' };

  const options: FieldOption[] = [...el.options].map((option) => ({
    value: option.value,
    text: option.text,
  }));
  const match = matchOption(options, value.candidates);
  if (!match) return { ok: false, reason: 'no matching option' };

  el.focus();
  el.selectedIndex = match.index;
  // Some frameworks listen on `value` rather than `selectedIndex`.
  setNativeValue(el, match.option.value);
  dispatchInputEvents(el);
  el.blur();
  return { ok: true, wrote: match.option.text };
}

/**
 * Checkbox: `el.click()`, never `el.checked = true` — assignment skips the
 * framework's handler (ARCHITECTURE.md §3.3).
 */
export function fillCheckbox(el: Element, value: FillValue): StrategyOutcome {
  if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') {
    return { ok: false, reason: 'not a checkbox' };
  }
  const desired = value.boolean ?? true;
  if (el.checked !== desired) safeClick(el);
  return { ok: true, wrote: desired ? 'checked' : 'unchecked' };
}

/** Radio group: pick the matching input and click it. */
export function fillRadioGroup(field: FieldDescriptor, value: FillValue): StrategyOutcome {
  const radios = (field.radios ?? [])
    .map((ref) => ref.deref())
    .filter((radio): radio is HTMLInputElement => !!radio);
  if (radios.length === 0) return { ok: false, reason: 'radio group is gone' };

  const options: FieldOption[] = radios.map((radio, index) => ({
    value: radio.value,
    text: field.options?.[index]?.text ?? radio.value,
  }));
  const match = matchOption(options, value.candidates);
  if (!match) return { ok: false, reason: 'no matching radio' };

  const target = radios[match.index];
  if (!target) return { ok: false, reason: 'no matching radio' };
  safeClick(target);
  return { ok: true, wrote: match.option.text };
}

/**
 * Combobox: click the trigger, wait for the listbox, type to filter, click the
 * option. Per-ATS variants come from the adapter (ARCHITECTURE.md §3.3).
 */
export async function fillCombobox(
  field: FieldDescriptor,
  value: FillValue,
  context: FillContext = {},
): Promise<StrategyOutcome> {
  const el = field.el.deref();
  if (!el) return { ok: false, reason: 'element is gone' };

  const strategy = { ...DEFAULT_COMBOBOX_STRATEGY, ...context.strategy };
  const container = field.container?.deref() ?? el;
  const trigger = strategy.trigger ? (container.querySelector(strategy.trigger) ?? el) : el;

  safeClick(trigger);

  if (strategy.typeToFilter && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    setNativeValue(el, value.text);
    dispatchInputEvents(el);
    simulateKeystrokes(el, value.text);
  }

  // Search the field's own root: a widget inside a shadow tree renders its
  // listbox there, not in the light DOM.
  const listbox = await waitForElement(queryRoot(el), strategy.listbox, WIDGET_TIMEOUT_MS);
  if (!listbox) return { ok: false, reason: 'listbox never appeared' };

  // Give a virtualised list a frame to render its rows.
  await pause();

  const optionEls = [...listbox.querySelectorAll(strategy.option)];
  if (optionEls.length === 0) return { ok: false, reason: 'listbox had no options' };

  const options: FieldOption[] = optionEls.map((option) => ({
    value: option.getAttribute('data-value') ?? option.textContent?.trim() ?? '',
    text: option.textContent?.trim() ?? '',
  }));
  const match = matchOption(options, value.candidates);
  if (!match) {
    // Close the listbox again so the page is left as we found it.
    (el as HTMLElement).blur?.();
    return { ok: false, reason: 'no matching option in listbox' };
  }

  const optionEl = optionEls[match.index];
  if (!optionEl) return { ok: false, reason: 'no matching option in listbox' };
  safeClick(optionEl);
  return { ok: true, wrote: match.option.text };
}

/**
 * File input: rebuild a `File` from the stored blob and attach it through a
 * `DataTransfer` — the only way to populate `input.files` programmatically.
 */
export async function fillFile(
  el: Element,
  value: FillValue,
  context: FillContext = {},
): Promise<StrategyOutcome> {
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    return { ok: false, reason: 'not a file input' };
  }
  if (!value.file) return { ok: false, reason: 'no stored document' };
  if (!context.fetchDocument) return { ok: false, reason: 'no document loader' };

  let payload: { bytes: Uint8Array; filename: string; mimeType: string };
  try {
    payload = await context.fetchDocument(value.file.blobId);
  } catch (error) {
    log.warn('document fetch failed', error);
    return { ok: false, reason: 'could not read the stored document' };
  }

  const file = new File([payload.bytes as BlobPart], payload.filename, { type: payload.mimeType });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  el.files = transfer.files;
  dispatchInputEvents(el);
  return { ok: true, wrote: payload.filename };
}
