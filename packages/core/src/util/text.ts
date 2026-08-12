/**
 * Text normalisation shared by the scanner (label blobs), the mapping rules and
 * the fill executor's option matcher.
 *
 * ARCHITECTURE.md §3.1: "All signals concatenate into a normalized `labelBlob` —
 * lowercased, punctuation stripped, `*` and '(required)' removed."
 */

/** Markers sites append to a label to denote a required field. */
const REQUIRED_MARKERS = [
  /\(\s*required\s*\)/gi,
  /\(\s*optional\s*\)/gi,
  /\brequired\b\s*$/gi,
  /\*/g,
];

/** Combining diacritical marks, left behind by NFKD decomposition. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Any whitespace, including the non-breaking space sites love to emit. */
const ANY_WHITESPACE = new RegExp('[\\s\\u00a0]+', 'g');

/**
 * Lowercase, drop required-markers and punctuation, collapse whitespace.
 * Digits are preserved — "line 2", "phone 2" and "grade 12" carry meaning.
 */
export function normalizeLabel(input: string): string {
  let out = ` ${input.toLowerCase()} `;
  for (const marker of REQUIRED_MARKERS) out = out.replace(marker, ' ');
  return out
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Join label signals into a single blob, de-duplicating repeated signals. */
export function buildLabelBlob(signals: Array<string | undefined | null>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of signals) {
    if (!raw) continue;
    const normalized = normalizeLabel(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    parts.push(normalized);
  }
  return parts.join(' ');
}

/**
 * `first_name` / `firstName` / `first-name` / `applicant[first_name]` → "first name".
 * Numeric and hex-ish segments are dropped — generated ids like `field_0_1a2b3c`
 * carry no label information and would only pollute the blob.
 */
export function humanizeAttribute(attr: string): string {
  return attr
    .replace(/\[|\]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:]+/g, ' ')
    .split(/\s+/)
    .filter((part) => part.length > 0 && !/^[0-9a-f]{6,}$/i.test(part) && !/^\d+$/.test(part))
    .join(' ')
    .toLowerCase()
    .trim();
}

/** Lowercase alphanumerics only — the strictest comparison key. */
export function compactKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Collapse runs of whitespace (including NBSP) and trim. */
export function squashWhitespace(input: string): string {
  return input.replace(ANY_WHITESPACE, ' ').trim();
}

/**
 * Levenshtein distance with an early-exit ceiling.
 * Used by the select/combobox option matcher (ARCHITECTURE.md §3.3).
 */
export function levenshtein(a: string, b: string, ceiling = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > ceiling) return ceiling + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Truncate on a word boundary where possible, hard-cut otherwise. */
export function truncate(input: string, maxLength: number): string {
  if (maxLength <= 0 || input.length <= maxLength) return input;
  const hard = input.slice(0, maxLength);
  const lastBreak = hard.lastIndexOf(' ');
  return lastBreak > maxLength * 0.6 ? hard.slice(0, lastBreak) : hard;
}
