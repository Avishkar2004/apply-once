import { squashWhitespace, stableHash } from '@autofill/core';
import type { FieldDescriptor, FieldKind, FieldOption } from '@/shared/types';
import { detectFramework } from './framework';
import { queryRoot, resolveLabel, resolveSectionHeading } from './label-resolver';
import { isComboboxLike } from './traverse';

/**
 * Element → `FieldDescriptor` (ARCHITECTURE.md §3.1).
 *
 * `signature` = hash(tagName + type + name + labelBlob). It is independent of DOM
 * position, so a learned mapping survives a redesign that keeps field names.
 * `id` is the signature plus an ordinal, because two rows of a repeating section
 * legitimately share a signature and still need distinct identities within a scan.
 */

export function describeField(el: Element, ordinal: number): FieldDescriptor {
  const label = resolveLabel(el);
  const kind = detectKind(el);
  const inputType = el.getAttribute('type') ?? undefined;
  const name = el.getAttribute('name') ?? undefined;

  const signature = stableHash(
    [el.tagName.toLowerCase(), inputType ?? '', name ?? '', label.blob].join('|'),
  );

  const descriptor: FieldDescriptor = {
    id: `${signature}#${ordinal}`,
    el: new WeakRef(el),
    kind,
    labelBlob: label.blob,
    displayLabel: label.displayLabel,
    required: isRequired(el),
    signature,
  };

  const autocomplete = el.getAttribute('autocomplete');
  if (autocomplete && autocomplete !== 'off' && autocomplete !== 'on') {
    descriptor.autocomplete = autocomplete;
  }
  if (name) descriptor.name = name;
  if (inputType) descriptor.inputType = inputType;

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) descriptor.placeholder = placeholder;

  const pattern = el.getAttribute('pattern');
  if (pattern) descriptor.pattern = pattern;

  const maxLength = readMaxLength(el);
  if (maxLength !== undefined) descriptor.maxLength = maxLength;

  const options = readOptions(el, kind);
  if (options) descriptor.options = options;

  const heading = resolveSectionHeading(el);
  if (heading) descriptor.sectionHeading = heading;

  descriptor.frameworkHint = detectFramework(el);

  const container = el.closest('[class], [data-testid], fieldset, div');
  if (container) descriptor.container = new WeakRef(container);

  return descriptor;
}

/**
 * A radio group is one logical field, not N. Label and heading come from the
 * group's container so the blob reads "gender", not "male".
 */
export function describeRadioGroup(radios: HTMLInputElement[], ordinal: number): FieldDescriptor | null {
  const first = radios[0];
  if (!first) return null;

  const groupContainer = first.closest('fieldset, [role="radiogroup"]') ?? first.parentElement;
  const label = groupContainer ? resolveLabel(groupContainer) : resolveLabel(first);
  const name = first.getAttribute('name') ?? undefined;
  const signature = stableHash(['input', 'radio', name ?? '', label.blob].join('|'));

  const descriptor: FieldDescriptor = {
    id: `${signature}#${ordinal}`,
    el: new WeakRef(first),
    radios: radios.map((radio) => new WeakRef(radio)),
    kind: 'radio-group',
    labelBlob: label.blob,
    displayLabel: label.displayLabel,
    required: radios.some(isRequired),
    signature,
    options: radios.map((radio) => ({ value: radio.value, text: radioText(radio) })),
    inputType: 'radio',
  };

  if (name) descriptor.name = name;

  const heading = resolveSectionHeading(groupContainer ?? first);
  if (heading) descriptor.sectionHeading = heading;

  descriptor.frameworkHint = detectFramework(first);
  if (groupContainer) descriptor.container = new WeakRef(groupContainer);

  return descriptor;
}

function radioText(radio: HTMLInputElement): string {
  const label = resolveLabel(radio);
  return label.displayLabel || radio.value;
}

export function detectKind(el: Element): FieldKind {
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLTextAreaElement) return 'textarea';

  if (el instanceof HTMLInputElement) {
    if (isComboboxLike(el)) return 'combobox';
    switch (el.type) {
      case 'email':
        return 'email';
      case 'tel':
        return 'tel';
      case 'date':
      case 'month':
      case 'week':
        return 'date';
      case 'number':
      case 'range':
        return 'number';
      case 'file':
        return 'file';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio-group';
      default:
        return 'text';
    }
  }

  const role = el.getAttribute('role');
  if (role === 'combobox' || isComboboxLike(el)) return 'combobox';
  if (role === 'radiogroup') return 'radio-group';
  if (el.getAttribute('contenteditable') !== null) return 'textarea';
  return 'text';
}

function isRequired(el: Element): boolean {
  if (
    (el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement) &&
    el.required
  ) {
    return true;
  }
  if (el.getAttribute('aria-required') === 'true') return true;

  // Many sites mark required visually only — an asterisk in the label text.
  const label = el.closest('label') ?? el.parentElement;
  return /\*/.test(label?.textContent ?? '');
}

function readMaxLength(el: Element): number | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.maxLength > 0 ? el.maxLength : undefined;
  }
  const attr = el.getAttribute('maxlength');
  const parsed = attr ? Number(attr) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readOptions(el: Element, kind: FieldKind): FieldOption[] | undefined {
  if (el instanceof HTMLSelectElement) {
    return [...el.options]
      .filter((option) => option.value !== '' || option.text.trim() !== '')
      .map((option) => ({ value: option.value, text: squashWhitespace(option.text) }));
  }

  if (kind === 'combobox') {
    // The listbox usually does not exist until the trigger is clicked. If a site
    // renders it eagerly, harvest it — the mapper can use option text as a signal.
    const listboxId = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
    if (listboxId) {
      const listbox = queryRoot(el).querySelector(`#${listboxId}`);
      const items = listbox?.querySelectorAll('[role="option"], li, option');
      if (items?.length) {
        return [...items].map((item) => ({
          value: item.getAttribute('data-value') ?? squashWhitespace(item.textContent ?? ''),
          text: squashWhitespace(item.textContent ?? ''),
        }));
      }
    }
  }

  return undefined;
}
