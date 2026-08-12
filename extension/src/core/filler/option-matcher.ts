import { compactKey, levenshtein, normalizeLabel } from '@autofill/core';
import type { FieldOption } from '@/shared/types';

/**
 * Option matching for `select`, radio groups and comboboxes
 * (ARCHITECTURE.md §3.3): exact value → exact text → normalised text → fuzzy
 * (Levenshtein ≤ 2).
 *
 * Candidates arrive best-first from `resolveValue`, so "Yes" is tried before
 * "true" and "Full-time" before "Full time".
 */

export const FUZZY_CEILING = 2;

export interface OptionMatch {
  index: number;
  option: FieldOption;
  /** Which strategy found it — asserted in tests, shown in the debug view. */
  how: 'value' | 'text' | 'normalized' | 'prefix' | 'contains' | 'fuzzy';
}

/** Placeholder rows a form uses for "nothing selected". Never a valid match. */
const PLACEHOLDER = /^(|-+|select\.*|choose\.*|please select.*|--.*--)$/i;

function isPlaceholder(option: FieldOption): boolean {
  return option.value === '' && PLACEHOLDER.test(option.text.trim());
}

export function matchOption(options: FieldOption[], candidates: string[]): OptionMatch | null {
  const usable = options.map((option, index) => ({ option, index })).filter(({ option }) => !isPlaceholder(option));
  if (usable.length === 0) return null;

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    const exactValue = usable.find(({ option }) => option.value === trimmed);
    if (exactValue) return { ...exactValue, how: 'value' };

    const exactText = usable.find(({ option }) => option.text.trim() === trimmed);
    if (exactText) return { ...exactText, how: 'text' };

    const wanted = normalizeLabel(trimmed);
    if (!wanted) continue;

    const normalized = usable.find(
      ({ option }) => normalizeLabel(option.text) === wanted || normalizeLabel(option.value) === wanted,
    );
    if (normalized) return { ...normalized, how: 'normalized' };
  }

  // Second pass: looser matches, only after every candidate failed exactly.
  for (const candidate of candidates) {
    const wanted = normalizeLabel(candidate);
    if (wanted.length < 2) continue;

    const prefix = usable.find(({ option }) => normalizeLabel(option.text).startsWith(wanted));
    if (prefix) return { ...prefix, how: 'prefix' };

    const contains = usable.find(({ option }) => normalizeLabel(option.text).includes(wanted));
    if (contains) return { ...contains, how: 'contains' };

    const target = compactKey(candidate);
    let best: (OptionMatch & { distance: number }) | null = null;
    for (const { option, index } of usable) {
      const distance = levenshtein(target, compactKey(option.text), FUZZY_CEILING);
      if (distance <= FUZZY_CEILING && (!best || distance < best.distance)) {
        best = { index, option, how: 'fuzzy', distance };
      }
    }
    if (best) {
      const { distance: _distance, ...match } = best;
      return match;
    }
  }

  return null;
}
