import type { FrameworkHint } from '@/shared/types';

/**
 * Which framework owns this input.
 *
 * The fill executor needs this because React tracks the last value it set and
 * ignores a direct assignment (ARCHITECTURE.md §3.3). The native-setter path is
 * used unconditionally — it is correct everywhere — but the hint drives the
 * follow-up events and the extra keystroke burst some controlled inputs need.
 */

const REACT_PROP_PREFIXES = ['__reactFiber$', '__reactProps$', '__reactInternalInstance$'];

export function detectFramework(el: Element): FrameworkHint {
  if (hasReactInternals(el)) return 'react';
  if (hasVueInternals(el)) return 'vue';
  if (hasAngularInternals(el)) return 'angular';

  // Fall back to a document-level probe: frameworks leave root markers even when
  // an individual node is a plain host element.
  const doc = el.ownerDocument;
  if (doc.querySelector('[data-reactroot], #__next, [data-reactid]')) return 'react';
  if (doc.querySelector('[data-v-app], [data-server-rendered]')) return 'vue';
  if (doc.querySelector('[ng-version], [ng-app]')) return 'angular';
  return 'plain';
}

function hasReactInternals(el: Element): boolean {
  for (const key of Object.keys(el)) {
    if (REACT_PROP_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  }
  return false;
}

function hasVueInternals(el: Element): boolean {
  if ('__vue__' in el || '__vueParentComponent' in el) return true;
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-v-')) return true;
  }
  return false;
}

function hasAngularInternals(el: Element): boolean {
  if ('__ngContext__' in el) return true;
  for (const attr of el.attributes) {
    if (attr.name.startsWith('_ngcontent') || attr.name.startsWith('ng-reflect')) return true;
  }
  return false;
}
