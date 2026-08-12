import { squashWhitespace } from '@autofill/core';
import { createLogger } from '@/shared/logger';
import { RESCAN_DEBOUNCE_MS } from '@/core/scanner';
import type { AtsAdapter } from './types';

const log = createLogger('adapters/multi-step');

/**
 * Multi-step wizards (ARCHITECTURE.md §3.1: "re-scan on step change, keep a
 * per-page session").
 *
 * SmartRecruiters and Workday mount one step at a time, so a single scan sees a
 * fraction of the form. An adapter that declares `multiStep.stepIndicator`
 * points at the node whose text changes between steps — "Step 2 of 4", a
 * highlighted breadcrumb — and this watches it.
 *
 * Watching the indicator rather than the form body matters: the body mutates
 * constantly under React, while the indicator changes exactly when the step
 * does. That is the difference between one re-scan per step and a re-scan every
 * few hundred milliseconds.
 */

export interface WizardWatcher {
  /** Current step text, or undefined when there is no indicator on the page. */
  signature(): string | undefined;
  stop(): void;
}

export function watchWizardSteps(
  adapter: AtsAdapter | undefined,
  onStepChange: (signature: string) => void,
  doc: Document = document,
): WizardWatcher | undefined {
  const selector = adapter?.multiStep?.stepIndicator;
  if (!selector) return undefined;

  const read = (): string | undefined => {
    const node = doc.querySelector(selector);
    const text = node?.textContent ? squashWhitespace(node.textContent) : undefined;
    // An indicator that renders as an icon row has no text; fall back to which
    // child is marked current.
    if (text) return text;
    const active = node?.querySelector('[aria-current], [class*="active"], [class*="current"]');
    return active ? squashWhitespace(active.textContent ?? '') || active.className : undefined;
  };

  let last = read();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const current = read();
      if (!current || current === last) return;
      log.info(`wizard step changed: ${last ?? '(none)'} → ${current}`);
      last = current;
      onStepChange(current);
    }, RESCAN_DEBOUNCE_MS);
  });

  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-current', 'class', 'aria-selected'],
  });

  return {
    signature: read,
    stop: () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    },
  };
}
