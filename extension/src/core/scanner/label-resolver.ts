import { buildLabelBlob, humanizeAttribute, normalizeLabel, squashWhitespace } from '@autofill/core';

/**
 * Label resolution, in the priority order of ARCHITECTURE.md §3.1:
 *
 *   1. `<label for="id">` text
 *   2. ancestor `<label>` text
 *   3. `aria-labelledby` → resolved element text
 *   4. `aria-label`
 *   5. nearest preceding text within the container (walk up max 3 levels)
 *   6. `placeholder`
 *   7. humanised `name` / `id`
 *
 * Every signal that resolves contributes to the blob — the priority governs the
 * order, not an exclusive choice, because a weak signal often disambiguates a
 * strong one ("Name" + placeholder "e.g. Jane Doe").
 */

/** How many ancestors signal 5 is allowed to climb. */
const MAX_CONTAINER_CLIMB = 3;

/** Ignore boilerplate that would swamp the blob. */
const MAX_SIGNAL_LENGTH = 160;

export interface LabelSignals {
  /** In priority order, already de-noised but not yet normalised. */
  signals: string[];
  /** Normalised, concatenated, de-duplicated — what the matcher sees. */
  blob: string;
  /** The single best human-readable label, for the review overlay. */
  displayLabel: string;
}

export function resolveLabel(el: Element): LabelSignals {
  const signals: string[] = [];
  const push = (value: string | null | undefined) => {
    const text = value ? squashWhitespace(value) : '';
    if (text && text.length <= MAX_SIGNAL_LENGTH) signals.push(text);
  };

  push(explicitLabel(el));
  push(ancestorLabel(el));
  push(ariaLabelledBy(el));
  push(el.getAttribute('aria-label'));
  push(precedingText(el));
  push(el.getAttribute('placeholder'));
  push(humanizedAttributes(el));

  return {
    signals,
    blob: buildLabelBlob(signals),
    displayLabel: signals[0] ?? el.getAttribute('name') ?? el.tagName.toLowerCase(),
  };
}

/**
 * The nearest queryable root — the shadow root when the field lives in one, the
 * document otherwise. Duck-typed rather than `instanceof`-checked: an element
 * can belong to another realm (an iframe, a test DOM), where the constructor
 * identity differs but the interface does not.
 */
export function queryRoot(el: Element): ParentNode {
  const root = el.getRootNode() as ParentNode;
  return typeof (root as Partial<ParentNode>).querySelector === 'function' ? root : el.ownerDocument;
}

/** 1. `<label for="…">`, resolved inside the element's own root (shadow-safe). */
function explicitLabel(el: Element): string | undefined {
  const id = el.getAttribute('id');
  if (!id) return undefined;
  const label = queryRoot(el).querySelector(`label[for="${cssEscape(id)}"]`);
  return label ? labelTextWithoutControls(label) : undefined;
}

/** 2. An ancestor `<label>` wrapping the control. */
function ancestorLabel(el: Element): string | undefined {
  const label = el.closest('label');
  return label ? labelTextWithoutControls(label) : undefined;
}

/** 3. `aria-labelledby`, which may point at several ids. */
function ariaLabelledBy(el: Element): string | undefined {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return undefined;
  const root = queryRoot(el);

  const texts = ids
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => root.querySelector(`#${cssEscape(id)}`)?.textContent ?? '')
    .filter(Boolean);
  return texts.length ? texts.join(' ') : undefined;
}

/**
 * 5. The nearest text that precedes the field inside its container, climbing at
 * most three levels. This is what catches the very common `<div><span>City</span>
 * <input/></div>` with no label element at all.
 */
function precedingText(el: Element): string | undefined {
  let node: Element | null = el;
  for (let level = 0; level < MAX_CONTAINER_CLIMB && node?.parentElement; level += 1) {
    const parent: HTMLElement | Element = node.parentElement;
    const text = lastTextBefore(parent, el);
    if (text) return text;
    node = node.parentElement;
  }
  return undefined;
}

/**
 * The text immediately before `stopAt` inside `container`.
 *
 * Whole elements, not individual text nodes. A label is routinely split across
 * nodes by required-field decoration:
 *
 *     <span class="field-label">First Name<em>*</em></span><input>
 *
 * Taking the last *text node* yields `"*"` and loses the label entirely — which
 * silently breaks precisely the fields a form marks as required, i.e. name,
 * email and phone. Taking the last *element* yields `"First Name*"`, and
 * `normalizeLabel` drops the asterisk.
 *
 * Anything that normalises to nothing (a lone `*`, a colon, an icon) is skipped
 * rather than returned, so decoration between the label and the input does not
 * mask it either.
 */
function lastTextBefore(container: Element, stopAt: Element): string | undefined {
  const meaningful = (text: string | null | undefined): string | undefined => {
    const squashed = squashWhitespace(text ?? '');
    // `normalizeLabel` strips `*`, `(required)` and punctuation; if nothing
    // survives, this was decoration rather than a label.
    return squashed && normalizeLabel(squashed) ? squashed : undefined;
  };

  // Walk backwards from the field through its preceding siblings at this level.
  let cursor: Node | null = stopAt.previousSibling;
  while (cursor) {
    const text = meaningful(cursor.textContent);
    if (text) return text;
    cursor = cursor.previousSibling;
  }

  // Nothing beside it — the label may wrap both, as in
  // `<div>Email <input></div>`. Take the container's own text minus the
  // field's, which is what a person reading the page would call this input.
  if (container !== stopAt && container.contains(stopAt)) {
    const clone = container.cloneNode(true) as Element;
    for (const control of clone.querySelectorAll('input, select, textarea, option, button')) {
      control.remove();
    }
    return meaningful(clone.textContent);
  }

  return undefined;
}

/** 7. `name` and `id`, humanised. Two separate signals; often only one is honest. */
function humanizedAttributes(el: Element): string | undefined {
  const parts = [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('data-testid')]
    .filter((value): value is string => !!value)
    .map(humanizeAttribute)
    .filter((value) => value.length > 1);
  return parts.length ? [...new Set(parts)].join(' ') : undefined;
}

/**
 * A `<label>` that wraps its control also contains the control's own text
 * (a select's options, for instance). Strip those before reading the label.
 */
function labelTextWithoutControls(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  for (const control of clone.querySelectorAll('input, select, textarea, option, button')) {
    control.remove();
  }
  return squashWhitespace(clone.textContent ?? '');
}

/**
 * The nearest section heading above the field — the context that disambiguates
 * "Name" and "Date" (ARCHITECTURE.md §11).
 */
export function resolveSectionHeading(el: Element): string | undefined {
  const legend = el.closest('fieldset')?.querySelector('legend');
  if (legend?.textContent) return squashWhitespace(legend.textContent);

  const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  let node: Element | null = el;
  while (node) {
    let sibling: Element | null = node.previousElementSibling;
    while (sibling) {
      if (sibling.matches(HEADINGS)) return squashWhitespace(sibling.textContent ?? '');
      const nested = sibling.querySelectorAll(HEADINGS);
      const last = nested[nested.length - 1];
      if (last?.textContent) return squashWhitespace(last.textContent);
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return undefined;
}

/** `CSS.escape` is unavailable in some test environments. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[[\]"\\#.:>+~*^$|()=]/g, '\\$&');
}
