import type { CanonicalKey } from '@autofill/core';
import type { FieldDescriptor } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { ashby } from './ashby';
import { greenhouse } from './greenhouse';
import { icims } from './icims';
import { lever } from './lever';
import { smartRecruiters } from './smartrecruiters';
import { taleo } from './taleo';
import { workday } from './workday';
import type { AtsAdapter } from './types';

export * from './types';
export { ashby } from './ashby';
export { greenhouse } from './greenhouse';
export { icims } from './icims';
export { lever } from './lever';
export { smartRecruiters } from './smartrecruiters';
export { taleo } from './taleo';
export { workday } from './workday';
export * from './repeating';
export * from './multi-step';

const log = createLogger('adapters');

/**
 * The adapter registry — the six platforms ARCHITECTURE.md §5 ships with v1.
 *
 * Order matters only for pages that could plausibly match two adapters, so the
 * specific-host ones come before the marker-based legacy ones.
 *
 * Coverage is deliberately uneven, and that is the design: Greenhouse, Lever,
 * Ashby, SmartRecruiters and Workday map real selectors; iCIMS and Taleo
 * generate their ids per tenant, so their adapters claim the page and let the
 * generic cascade do the work. §11 — "never let an adapter be load-bearing".
 */
export const ADAPTERS: readonly AtsAdapter[] = [
  greenhouse,
  lever,
  ashby,
  smartRecruiters,
  workday,
  icims,
  taleo,
];

/** First adapter that claims the page, or `undefined` for the generic pipeline. */
export function findAdapter(
  url: URL,
  doc: Document,
  adapters: readonly AtsAdapter[] = ADAPTERS,
): AtsAdapter | undefined {
  for (const adapter of adapters) {
    try {
      if (adapter.matches(url, doc)) return adapter;
    } catch (error) {
      // An adapter must never be able to break the page (§11).
      log.warn(`adapter ${adapter.name} threw during matches()`, error);
    }
  }
  return undefined;
}

/**
 * Tier 0, adapter half: resolve the adapter's selector map against the live DOM
 * and express it as `fieldId → canonicalKey`.
 *
 * A selector that matches nothing is not an error — it is an adapter that has
 * aged, and the generic cascade covers the field instead.
 */
export function resolveAdapterMappings(
  adapter: AtsAdapter,
  fields: readonly FieldDescriptor[],
  doc: Document = document,
): Record<string, CanonicalKey> {
  if (!adapter.fieldMap) return {};

  const byElement = new Map<Element, string>();
  for (const field of fields) {
    const el = field.el.deref();
    if (el) byElement.set(el, field.id);
  }

  const mappings: Record<string, CanonicalKey> = {};
  for (const [selector, key] of Object.entries(adapter.fieldMap)) {
    let matches: Element[];
    try {
      matches = [...doc.querySelectorAll(selector)];
    } catch (error) {
      log.warn(`adapter ${adapter.name} has an invalid selector: ${selector}`, error);
      continue;
    }
    for (const el of matches) {
      const fieldId = byElement.get(el);
      // First selector wins, so more specific entries can precede general ones.
      if (fieldId && !(fieldId in mappings)) mappings[fieldId] = key;
    }
  }

  log.debug(`adapter ${adapter.name} resolved ${Object.keys(mappings).length} tier-0 mappings`);
  return mappings;
}
