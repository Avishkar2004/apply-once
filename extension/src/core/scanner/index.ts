import type { FieldDescriptor } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { describeField, describeRadioGroup } from './descriptors';
import { collectControls } from './traverse';

export * from './descriptors';
export * from './label-resolver';
export * from './traverse';
export { detectFramework } from './framework';

const log = createLogger('scanner');

/** Debounce for the lazy-content re-scan (ARCHITECTURE.md §3.1). */
export const RESCAN_DEBOUNCE_MS = 300;

export interface ScanResult {
  fields: FieldDescriptor[];
  /** Cross-origin frames we cannot see into. Reported as a caveat in the overlay. */
  unreachableFrames: number;
  closedShadowRoots: number;
  scannedAt: number;
}

/**
 * Walk the document (plus open shadow roots and same-origin frames) and emit one
 * descriptor per logical field. Radio inputs collapse into a single
 * `radio-group` descriptor per `name`.
 */
export function scanRoot(root: Document | ShadowRoot = document): ScanResult {
  const { elements, unreachableFrames, closedShadowRoots } = collectControls(root);

  const radioGroups = new Map<string, HTMLInputElement[]>();
  const singles: Element[] = [];

  for (const el of elements) {
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const key = radioGroupKey(el);
      const group = radioGroups.get(key);
      if (group) group.push(el);
      else radioGroups.set(key, [el]);
    } else {
      singles.push(el);
    }
  }

  const ordinals = new Map<string, number>();
  const fields: FieldDescriptor[] = [];

  const nextOrdinal = (signature: string): number => {
    const used = ordinals.get(signature) ?? 0;
    ordinals.set(signature, used + 1);
    return used;
  };

  for (const el of singles) {
    // Describe once to learn the signature, then assign the ordinal.
    const provisional = describeField(el, 0);
    fields.push({ ...provisional, id: `${provisional.signature}#${nextOrdinal(provisional.signature)}` });
  }

  for (const radios of radioGroups.values()) {
    const provisional = describeRadioGroup(radios, 0);
    if (!provisional) continue;
    fields.push({ ...provisional, id: `${provisional.signature}#${nextOrdinal(provisional.signature)}` });
  }

  log.debug(`scanned ${fields.length} fields`, { unreachableFrames, closedShadowRoots });
  return { fields, unreachableFrames, closedShadowRoots, scannedAt: Date.now() };
}

/**
 * Radio inputs are grouped by `name` within their owning form. Unnamed radios
 * (rare, but React component libraries do it) fall back to their fieldset.
 */
function radioGroupKey(radio: HTMLInputElement): string {
  const formId = radio.form?.getAttribute('id') ?? radio.form?.getAttribute('name') ?? 'noform';
  if (radio.name) return `${formId}::${radio.name}`;
  const group = radio.closest('fieldset, [role="radiogroup"]');
  return `${formId}::anon::${group ? indexOfElement(group) : 'root'}`;
}

function indexOfElement(el: Element): number {
  return el.parentElement ? [...el.parentElement.children].indexOf(el) : 0;
}

/**
 * Re-scan on subtree changes, debounced (ARCHITECTURE.md §3.1). Multi-step
 * wizards and lazily-mounted sections both surface through this.
 *
 * Returns a disposer; callers must call it when the page session ends.
 */
export function observeChanges(
  target: Document | Element,
  onChange: () => void,
  debounceMs = RESCAN_DEBOUNCE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const observer = new MutationObserver((records) => {
    // Ignore mutations caused by our own overlay.
    const relevant = records.some((record) => !isOwnMutation(record));
    if (!relevant) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });

  // A MutationObserver cannot observe a Document itself — watch its root element.
  const node = (target as Document).documentElement ?? (target as Node);
  observer.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'disabled', 'aria-hidden'],
  });

  return () => {
    if (timer) clearTimeout(timer);
    observer.disconnect();
  };
}

export const OVERLAY_HOST_ATTRIBUTE = 'data-autofill-overlay';

function isOwnMutation(record: MutationRecord): boolean {
  const target = record.target;
  return target instanceof Element && target.closest(`[${OVERLAY_HOST_ATTRIBUTE}]`) !== null;
}
