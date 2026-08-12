/**
 * Date normalisation.
 *
 * Profile dates are stored ISO-ish: `YYYY-MM-DD`, or `YYYY-MM` where only month
 * precision is known (work/education ranges). Forms want almost anything else.
 *
 * ARCHITECTURE.md §3.3: "Normalize to the field's format — sniff from
 * `placeholder`, `min`/`max`, or locale. Fall back to `YYYY-MM-DD`."
 */

export type DateFormat = 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'MM/YYYY' | 'YYYY-MM' | 'YYYY';

export interface DateParts {
  year: number;
  /** 1-12, or undefined when only a year is known. */
  month?: number;
  /** 1-31, or undefined when only year/month are known. */
  day?: number;
}

const ISO_DATE = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;

/** Parse the stored profile representation. Returns null for anything unparseable. */
export function parseProfileDate(value: string): DateParts | null {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : undefined;
  const day = match[3] ? Number(match[3]) : undefined;
  if (!Number.isFinite(year)) return null;
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && (day < 1 || day > 31)) return null;
  return { year, ...(month !== undefined ? { month } : {}), ...(day !== undefined ? { day } : {}) };
}

/**
 * Work out which format a field wants.
 *
 * `<input type="date">` is unambiguous — the DOM value protocol is always
 * `YYYY-MM-DD` regardless of what the user sees. Everything else is a guess from
 * the placeholder, then the locale.
 */
export function sniffDateFormat(hints: {
  inputType?: string | undefined;
  placeholder?: string | undefined;
  pattern?: string | undefined;
  locale?: string | undefined;
}): DateFormat {
  if (hints.inputType === 'date') return 'YYYY-MM-DD';
  if (hints.inputType === 'month') return 'YYYY-MM';

  const hint = `${hints.placeholder ?? ''} ${hints.pattern ?? ''}`.toLowerCase();
  if (hint) {
    if (/y{4}[^a-z0-9]?m{2}[^a-z0-9]?d{2}/.test(hint)) return 'YYYY-MM-DD';
    if (/d{1,2}[^a-z0-9]?m{1,2}[^a-z0-9]?y{2,4}/.test(hint)) return 'DD/MM/YYYY';
    if (/m{1,2}[^a-z0-9]?d{1,2}[^a-z0-9]?y{2,4}/.test(hint)) return 'MM/DD/YYYY';
    if (/m{1,2}[^a-z0-9]?y{2,4}/.test(hint)) return 'MM/YYYY';
    if (/^\s*y{4}\s*$/.test(hint)) return 'YYYY';
  }

  // Locale fallback: the US is the only major market on month-first.
  const locale = (hints.locale ?? 'en-US').toLowerCase();
  if (locale.endsWith('-us') || locale === 'en') return 'MM/DD/YYYY';
  return 'DD/MM/YYYY';
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Render parts in the requested format. Missing month/day default to 01. */
export function formatDate(parts: DateParts, format: DateFormat): string {
  const year = pad(parts.year, 4);
  const month = pad(parts.month ?? 1);
  const day = pad(parts.day ?? 1);
  switch (format) {
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    case 'MM/DD/YYYY':
      return `${month}/${day}/${year}`;
    case 'DD/MM/YYYY':
      return `${day}/${month}/${year}`;
    case 'MM/YYYY':
      return `${month}/${year}`;
    case 'YYYY-MM':
      return `${year}-${month}`;
    case 'YYYY':
      return year;
  }
}

/** Convenience: profile string → field string in one step. Returns the input unchanged if unparseable. */
export function reformatProfileDate(value: string, format: DateFormat): string {
  const parts = parseProfileDate(value);
  return parts ? formatDate(parts, format) : value;
}

/** Long month names, for sites whose month dropdown reads "January". */
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
