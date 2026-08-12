import { buildLabelBlob, humanizeAttribute, squashWhitespace } from '@autofill/core';

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

/** Text content of `container` that appears before `stopAt` in document order. */
function lastTextBefore(container: Element, stopAt: Element): string | undefined {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent && node.textContent.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });

  let best: string | undefined;
  let current = walker.nextNode();
  while (current) {
    const position = stopAt.compareDocumentPosition(current);
    // The text node must come before the field and not be inside it.
    if (position & Node.DOCUMENT_POSITION_PRECEDING && !(position & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
      best = squashWhitespace(current.textContent ?? '');
    } else if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      break;
    }
    current = walker.nextNode();
  }
  return best;
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
