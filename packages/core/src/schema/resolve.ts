import type { CanonicalKey, RepeatingArrayName, ValueType } from './canonical-keys';
import { CANONICAL_KEY_META } from './canonical-keys';
import type { DocumentRef, Profile } from './profile';
import { formatDate, parseProfileDate, type DateFormat } from '../util/date';
import { truncate } from '../util/text';

/**
 * Canonical key + profile → something the fill executor can actually write.
 *
 * This is the last purely-logical step before the DOM. It lives in `core` (not in
 * the extension) because it is a property of the profile vocabulary, it needs no
 * DOM, and both the extension and any future client must agree on it exactly.
 */

export interface ResolveContext {
  /** Row index for `foo[].bar` keys — supplied by the repeating-section handler. */
  rowIndex?: number;
  /** The control's `maxLength`, if it declares one. */
  maxLength?: number;
  /** Format the target date control wants. Defaults to ISO. */
  dateFormat?: DateFormat;
}

export interface ResolvedValue {
  key: CanonicalKey;
  type: ValueType;
  /** What to type into a text-like control. */
  text: string;
  /**
   * Ordered candidates to match against `select` / radio / combobox options,
   * best first. Always includes `text`.
   */
  candidates: string[];
  /** Intended state for a checkbox control. */
  boolean?: boolean;
  /** Blob reference for a file control. */
  file?: DocumentRef;
}

/** Human phrasings sites use for the "prefer not to say" option. */
const DECLINE_CANDIDATES = [
  'Decline to self identify',
  'I do not wish to answer',
  "I don't wish to answer",
  'Prefer not to say',
  'Prefer not to disclose',
  'Decline to answer',
  'Do not wish to disclose',
];

const EEO_LABELS: Record<string, string[]> = {
  decline: DECLINE_CANDIDATES,
  male: ['Male', 'Man'],
  female: ['Female', 'Woman'],
  'non-binary': ['Non-binary', 'Nonbinary', 'Non binary'],
  'american-indian-or-alaska-native': ['American Indian or Alaska Native'],
  asian: ['Asian'],
  'black-or-african-american': ['Black or African American', 'Black'],
  'hispanic-or-latino': ['Hispanic or Latino', 'Hispanic/Latino', 'Yes'],
  'not-hispanic-or-latino': ['Not Hispanic or Latino', 'No'],
  'native-hawaiian-or-other-pacific-islander': [
    'Native Hawaiian or Other Pacific Islander',
    'Native Hawaiian or Pacific Islander',
  ],
  white: ['White', 'White (Not Hispanic or Latino)'],
  'two-or-more-races': ['Two or More Races', 'Two or more races (Not Hispanic or Latino)'],
  'protected-veteran': [
    'I identify as one or more of the classifications of a protected veteran',
    'Yes, I am a protected veteran',
    'Protected veteran',
    'Yes',
  ],
  'not-a-protected-veteran': [
    'I am not a protected veteran',
    'No, I am not a protected veteran',
    'No',
  ],
  yes: ['Yes, I have a disability, or have had one in the past', 'Yes'],
  no: ['No, I do not have a disability and have not had one in the past', 'No'],
};

const BOOLEAN_CANDIDATES = {
  true: ['Yes', 'yes', 'Y', 'True', 'true', '1'],
  false: ['No', 'no', 'N', 'False', 'false', '0'],
} as const;

const CHOICE_SYNONYMS: Record<string, string[]> = {
  'full-time': ['Full-time', 'Full time', 'Fulltime', 'Permanent'],
  'part-time': ['Part-time', 'Part time', 'Parttime'],
  contract: ['Contract', 'Contractor', 'Contract / Freelance'],
  internship: ['Internship', 'Intern'],
  freelance: ['Freelance', 'Self-employed'],
  temporary: ['Temporary', 'Temp'],
  remote: ['Remote', 'Fully remote', 'Remote (work from home)'],
  hybrid: ['Hybrid', 'Hybrid remote'],
  onsite: ['On-site', 'Onsite', 'In office', 'In-person'],
  flexible: ['Flexible', 'No preference', 'Open to any'],
  native: ['Native', 'Native or bilingual'],
  fluent: ['Fluent', 'Full professional'],
  professional: ['Professional working', 'Professional'],
  conversational: ['Conversational', 'Limited working'],
  basic: ['Basic', 'Elementary'],
  year: ['Per year', 'Annual', 'Yearly', 'year'],
  hour: ['Per hour', 'Hourly', 'hour'],
};

function dedupe(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return '';
}

/** Walk a dotted path, resolving `[]` segments with `rowIndex`. */
function readPath(profile: Profile, key: CanonicalKey, rowIndex: number): unknown {
  let node: unknown = profile;
  for (const rawSegment of key.split('.')) {
    if (node === undefined || node === null) return undefined;
    const isArraySegment = rawSegment.endsWith('[]');
    const segment = isArraySegment ? rawSegment.slice(0, -2) : rawSegment;
    node = (node as Record<string, unknown>)[segment];
    if (isArraySegment) {
      if (!Array.isArray(node)) return undefined;
      node = node[rowIndex];
    }
  }
  return node;
}

function fullName(profile: Profile): string {
  const { firstName, middleName, lastName, preferredName } = profile.personal;
  return dedupe([preferredName || firstName, middleName, lastName]).join(' ');
}

/**
 * Total professional experience, in whole months.
 *
 * Earliest start to the latest end (or today, for a current role) — not the sum
 * of each role's length, which double-counts anyone who has ever held two jobs
 * at once and is the number people actually mean.
 *
 * Months rather than years because forms outside the US routinely ask for both
 * halves in adjacent boxes ("Experience: [5] years [3] months"), and deriving
 * the pair from one span keeps them consistent.
 *
 * Returns `undefined` when the work history carries no usable dates, so the
 * field is reported as ⬜ skipped rather than filled with a confident zero.
 */
function experienceMonths(profile: Profile, now: Date = new Date()): number | undefined {
  let earliest: number | undefined;
  let latest: number | undefined;

  for (const role of profile.work) {
    const start = parseProfileDate(role.startDate ?? '');
    if (!start) continue;

    const startMs = Date.UTC(start.year, (start.month ?? 1) - 1, start.day ?? 1);
    earliest = earliest === undefined ? startMs : Math.min(earliest, startMs);

    const end = role.current ? undefined : parseProfileDate(role.endDate ?? '');
    const endMs = role.current
      ? now.getTime()
      : end
        ? Date.UTC(end.year, (end.month ?? 12) - 1, end.day ?? 28)
        : undefined;
    if (endMs !== undefined) latest = latest === undefined ? endMs : Math.max(latest, endMs);
  }

  if (earliest === undefined) return undefined;
  const end = latest ?? now.getTime();
  const months = Math.floor((end - earliest) / ((365.25 / 12) * 24 * 60 * 60 * 1000));
  return months >= 0 ? months : undefined;
}

/**
 * "2 months" → 60, "30 days" → 30, "immediate" → 0.
 *
 * Deliberately forgiving: this reads whatever the user typed into a free-text
 * box in their own words, and a notice period is never expressed precisely
 * enough for the month length to matter.
 */
function parseDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  if (/\b(immediate|asap|right away|now)\b/.test(lower)) return 0;

  const match = /(\d+(?:\.\d+)?)\s*(day|week|month|year)?/.exec(lower);
  if (!match?.[1]) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;

  const perUnit: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
  return Math.round(amount * (perUnit[match[2] ?? 'day'] ?? 1));
}

/**
 * The ways a notice period gets written, best first.
 *
 * These become option candidates, which is what lets a number answer a dropdown
 * offering "Immediate / 15 Days / 30 Days / 2 Months".
 */
function noticePeriodCandidates(days: number | undefined): string[] {
  if (days === undefined) return [];
  if (days <= 0) return ['Immediate', '0', 'Immediate joiner', 'Available immediately'];

  const candidates = [`${days} days`, String(days)];
  if (days % 30 === 0) {
    const months = days / 30;
    candidates.push(`${months} month${months === 1 ? '' : 's'}`);
  }
  return candidates;
}

function fullAddress(profile: Profile): string {
  const a = profile.contact.address;
  const street = dedupe([a.line1, a.line2]).join(', ');
  const region = dedupe([a.city, a.state, a.postalCode]).join(' ');
  return dedupe([street, region, a.country]).join(', ');
}

/**
 * Resolve one canonical key. Returns `null` when the profile holds no data for
 * it — the caller reports that as ⬜ skipped rather than filling an empty string.
 */
export function resolveValue(
  profile: Profile,
  key: CanonicalKey,
  ctx: ResolveContext = {},
): ResolvedValue | null {
  const meta = CANONICAL_KEY_META[key];
  const rowIndex = ctx.rowIndex ?? 0;
  const base = { key, type: meta.type } as const;

  const finish = (text: string, candidates: string[], extra?: Partial<ResolvedValue>): ResolvedValue | null => {
    const capped = ctx.maxLength ? truncate(text, ctx.maxLength) : text;
    if (!capped && extra?.file === undefined && extra?.boolean === undefined) return null;
    return { ...base, text: capped, candidates: dedupe([capped, ...candidates]), ...extra };
  };

  // Derived keys first — they have no storage location to read.
  if (key === 'personal.fullName') return finish(fullName(profile), []);
  if (key === 'contact.address.full') return finish(fullAddress(profile), []);
  if (key === 'work.totalYears') {
    const months = experienceMonths(profile);
    if (months === undefined) return null;
    const years = Math.floor(months / 12);
    return finish(String(years), [`${years} years`, `${years}+`]);
  }
  // The remainder, not the total — this key only ever sits beside `totalYears`
  // in a "[n] years [n] months" pair, where the whole years are already spoken
  // for by the box next door.
  if (key === 'work.totalMonths') {
    const months = experienceMonths(profile);
    if (months === undefined) return null;
    return finish(String(months % 12), []);
  }

  // Notice period is asked two ways on the same form: a free-text box that
  // wants "2 months" and a required numeric one labelled "Available to join (in
  // days)". Each key falls back to the other so one answer satisfies both, and
  // whichever box the user filled in the editor is the one that wins.
  if (key === 'preferences.noticePeriod') {
    const written = profile.preferences.noticePeriod?.trim();
    if (written) return finish(written, noticePeriodCandidates(parseDuration(written)));
    const days = profile.preferences.noticePeriodDays;
    if (days === undefined) return null;
    const [first, ...rest] = noticePeriodCandidates(days);
    return finish(first ?? String(days), rest);
  }
  if (key === 'preferences.noticePeriodDays') {
    const days = profile.preferences.noticePeriodDays ?? parseDuration(profile.preferences.noticePeriod);
    if (days === undefined) return null;
    return finish(String(days), noticePeriodCandidates(days));
  }

  const raw = readPath(profile, key, rowIndex);

  switch (meta.type) {
    case 'file': {
      const doc = raw as DocumentRef | undefined;
      if (!doc?.blobId) return null;
      return finish(doc.filename, [], { file: doc });
    }

    case 'boolean': {
      if (typeof raw !== 'boolean') return null;
      const candidates = raw ? BOOLEAN_CANDIDATES.true : BOOLEAN_CANDIDATES.false;
      return finish(candidates[0], [...candidates], { boolean: raw });
    }

    case 'list': {
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const items = raw.map(stringify).filter(Boolean);
      if (items.length === 0) return null;
      return finish(items.join(', '), items);
    }

    case 'date': {
      const text = stringify(raw);
      if (!text) return null;
      const parts = parseProfileDate(text);
      if (!parts) return finish(text, []);
      const formatted = formatDate(parts, ctx.dateFormat ?? 'YYYY-MM-DD');
      // Offer the other common renderings as option candidates, for month/year dropdowns.
      return finish(formatted, [
        formatDate(parts, 'YYYY-MM-DD'),
        formatDate(parts, 'MM/DD/YYYY'),
        formatDate(parts, 'MM/YYYY'),
        formatDate(parts, 'YYYY'),
      ]);
    }

    case 'choice': {
      const text = stringify(raw);
      if (!text) return null;
      const synonyms = key.startsWith('eeo.') ? EEO_LABELS[text] : CHOICE_SYNONYMS[text];
      if (synonyms && synonyms.length > 0) {
        return finish(synonyms[0]!, synonyms.slice(1));
      }
      return finish(text, []);
    }

    default: {
      const text = stringify(raw);
      if (!text) return null;

      if (key === 'contact.phone') {
        const cc = profile.contact.phoneCountryCode?.trim();
        const withCc = cc && !text.startsWith('+') ? `${cc} ${text}` : undefined;
        return finish(text, withCc ? [withCc] : []);
      }
      return finish(text, []);
    }
  }
}

/**
 * How many rows the profile can supply for a repeating section — used by the
 * executor to decide how many times to press "add another"
 * (ARCHITECTURE.md §3.3).
 */
export function repeatingRowCount(profile: Profile, arrayName: RepeatingArrayName): number {
  const value = (profile as unknown as Record<string, unknown>)[arrayName];
  return Array.isArray(value) ? value.length : 0;
}
