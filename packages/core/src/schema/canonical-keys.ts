/**
 * The canonical key vocabulary — "the single vocabulary the whole system maps
 * into" (ARCHITECTURE.md §4).
 *
 * Every tier of the mapping cascade produces one of these, and only these. The
 * fill executor never sees a profile path that is not listed here, which is what
 * keeps the scanner, the rule table, the adapters and the LLM prompt in sync.
 *
 * Notation:
 *   `a.b.c`     — a single value at that path in the Profile
 *   `a[].b`     — a value inside a repeating section; the row index is supplied
 *                 at fill time by the repeating-section handler
 */

export const CANONICAL_KEYS = [
  // — personal —
  'personal.firstName',
  'personal.middleName',
  'personal.lastName',
  'personal.fullName',
  'personal.preferredName',
  'personal.pronouns',
  'personal.dateOfBirth',

  // — contact —
  'contact.email',
  'contact.phone',
  'contact.phoneCountryCode',
  'contact.address.line1',
  'contact.address.line2',
  'contact.address.city',
  'contact.address.state',
  'contact.address.postalCode',
  'contact.address.country',
  'contact.address.full',

  // — links —
  'links.linkedin',
  'links.github',
  'links.portfolio',
  'links.website',
  'links.twitter',

  // — work history (repeating) —
  'work[].company',
  'work[].title',
  'work[].location',
  'work[].employmentType',
  'work[].startDate',
  'work[].endDate',
  'work[].current',
  'work[].description',
  'work.totalYears',
  'work.totalMonths',

  // — education (repeating) —
  'education[].school',
  'education[].degree',
  'education[].fieldOfStudy',
  'education[].startDate',
  'education[].endDate',
  'education[].gpa',
  'education[].honors',

  // — skills & languages —
  'skills',
  'languages[].name',
  'languages[].proficiency',
  'certifications[].name',
  'certifications[].issuer',
  'certifications[].date',

  // — work authorisation —
  'workAuth.authorizedIn',
  'workAuth.requiresSponsorship',
  'workAuth.visaStatus',
  'workAuth.needsRelocation',

  // — preferences —
  'preferences.desiredSalary.amount',
  'preferences.desiredSalary.currency',
  'preferences.desiredSalary.period',
  'preferences.currentSalary.amount',
  'preferences.currentSalary.currency',
  'preferences.noticePeriod',
  'preferences.noticePeriodDays',
  'preferences.preferredLocations',
  'preferences.earliestStartDate',
  'preferences.remotePreference',
  'preferences.willingToRelocate',

  // — voluntary self-identification (see PROFILE §eeo; never inferred) —
  'eeo.gender',
  'eeo.race',
  'eeo.ethnicity',
  'eeo.veteranStatus',
  'eeo.disabilityStatus',

  // — documents —
  'documents.resume',
  'documents.coverLetter',
  'documents.transcript',
  'documents.portfolio',

  // — references (repeating) —
  'references[].name',
  'references[].title',
  'references[].company',
  'references[].email',
  'references[].phone',
  'references[].relationship',
] as const;

export type CanonicalKey = (typeof CANONICAL_KEYS)[number];

const CANONICAL_KEY_SET: ReadonlySet<string> = new Set<string>(CANONICAL_KEYS);

export function isCanonicalKey(value: unknown): value is CanonicalKey {
  return typeof value === 'string' && CANONICAL_KEY_SET.has(value);
}

/**
 * Sentinels the mapping cascade can produce instead of a key.
 * `FREE_TEXT` routes to the Answer Generator (ARCHITECTURE.md §3.6);
 * `UNMAPPABLE` surfaces as a ⬜ skipped row in the review overlay.
 */
export const FREE_TEXT = 'FREE_TEXT' as const;
export const UNMAPPABLE = 'UNMAPPABLE' as const;
export type MappingTarget = CanonicalKey | typeof FREE_TEXT | typeof UNMAPPABLE;

/** How a filled value should be shaped and which control kinds it fits. */
export type ValueType =
  | 'text'
  | 'longtext'
  | 'email'
  | 'tel'
  | 'url'
  | 'date'
  | 'number'
  | 'boolean'
  | 'choice'
  | 'list'
  | 'file';

/** Profile arrays that a repeating form section can iterate. */
export type RepeatingArrayName = 'work' | 'education' | 'languages' | 'certifications' | 'references';

export interface CanonicalKeyMeta {
  /** Human label — shown in the overlay's "pick a field" dropdown. */
  label: string;
  type: ValueType;
  /** Profile array this key repeats over, for repeating-section fills. */
  repeatsOver?: RepeatingArrayName;
  /** Computed from other profile fields rather than stored directly. */
  derived?: true;
  /** Grouping for the overlay dropdown and the options-page editor. */
  group: 'Personal' | 'Contact' | 'Links' | 'Work' | 'Education' | 'Skills' | 'Eligibility' | 'Preferences' | 'Voluntary' | 'Documents' | 'References';
}

export const CANONICAL_KEY_META: Record<CanonicalKey, CanonicalKeyMeta> = {
  'personal.firstName': { label: 'First name', type: 'text', group: 'Personal' },
  'personal.middleName': { label: 'Middle name', type: 'text', group: 'Personal' },
  'personal.lastName': { label: 'Last name', type: 'text', group: 'Personal' },
  'personal.fullName': { label: 'Full name', type: 'text', group: 'Personal', derived: true },
  'personal.preferredName': { label: 'Preferred name', type: 'text', group: 'Personal' },
  'personal.pronouns': { label: 'Pronouns', type: 'text', group: 'Personal' },
  'personal.dateOfBirth': { label: 'Date of birth', type: 'date', group: 'Personal' },

  'contact.email': { label: 'Email', type: 'email', group: 'Contact' },
  'contact.phone': { label: 'Phone', type: 'tel', group: 'Contact' },
  'contact.phoneCountryCode': { label: 'Phone country code', type: 'text', group: 'Contact' },
  'contact.address.line1': { label: 'Address line 1', type: 'text', group: 'Contact' },
  'contact.address.line2': { label: 'Address line 2', type: 'text', group: 'Contact' },
  'contact.address.city': { label: 'City', type: 'text', group: 'Contact' },
  'contact.address.state': { label: 'State / province', type: 'choice', group: 'Contact' },
  'contact.address.postalCode': { label: 'Postal code', type: 'text', group: 'Contact' },
  'contact.address.country': { label: 'Country', type: 'choice', group: 'Contact' },
  'contact.address.full': { label: 'Full address (one line)', type: 'text', group: 'Contact', derived: true },

  'links.linkedin': { label: 'LinkedIn', type: 'url', group: 'Links' },
  'links.github': { label: 'GitHub', type: 'url', group: 'Links' },
  'links.portfolio': { label: 'Portfolio', type: 'url', group: 'Links' },
  'links.website': { label: 'Website', type: 'url', group: 'Links' },
  'links.twitter': { label: 'Twitter / X', type: 'url', group: 'Links' },

  'work[].company': { label: 'Employer', type: 'text', group: 'Work', repeatsOver: 'work' },
  'work[].title': { label: 'Job title', type: 'text', group: 'Work', repeatsOver: 'work' },
  'work[].location': { label: 'Job location', type: 'text', group: 'Work', repeatsOver: 'work' },
  'work[].employmentType': { label: 'Employment type', type: 'choice', group: 'Work', repeatsOver: 'work' },
  'work[].startDate': { label: 'Employment start date', type: 'date', group: 'Work', repeatsOver: 'work' },
  'work[].endDate': { label: 'Employment end date', type: 'date', group: 'Work', repeatsOver: 'work' },
  'work[].current': { label: 'Currently employed here', type: 'boolean', group: 'Work', repeatsOver: 'work' },
  'work[].description': { label: 'Role description', type: 'longtext', group: 'Work', repeatsOver: 'work' },
  // Ubiquitous on ATS forms outside the US ("Total Experience (Years)").
  // Derived from the work history rather than asked for twice.
  'work.totalYears': { label: 'Total years of experience', type: 'number', group: 'Work', derived: true },
  // The months half of the "[n] years [n] months" pair those same forms use.
  'work.totalMonths': { label: 'Experience — extra months', type: 'number', group: 'Work', derived: true },

  'education[].school': { label: 'School', type: 'text', group: 'Education', repeatsOver: 'education' },
  'education[].degree': { label: 'Degree', type: 'choice', group: 'Education', repeatsOver: 'education' },
  'education[].fieldOfStudy': { label: 'Field of study', type: 'text', group: 'Education', repeatsOver: 'education' },
  'education[].startDate': { label: 'Education start date', type: 'date', group: 'Education', repeatsOver: 'education' },
  'education[].endDate': { label: 'Education end date', type: 'date', group: 'Education', repeatsOver: 'education' },
  'education[].gpa': { label: 'GPA', type: 'text', group: 'Education', repeatsOver: 'education' },
  'education[].honors': { label: 'Honours', type: 'text', group: 'Education', repeatsOver: 'education' },

  skills: { label: 'Skills', type: 'list', group: 'Skills' },
  'languages[].name': { label: 'Language', type: 'text', group: 'Skills', repeatsOver: 'languages' },
  'languages[].proficiency': { label: 'Language proficiency', type: 'choice', group: 'Skills', repeatsOver: 'languages' },
  'certifications[].name': { label: 'Certification', type: 'text', group: 'Skills', repeatsOver: 'certifications' },
  'certifications[].issuer': { label: 'Certification issuer', type: 'text', group: 'Skills', repeatsOver: 'certifications' },
  'certifications[].date': { label: 'Certification date', type: 'date', group: 'Skills', repeatsOver: 'certifications' },

  'workAuth.authorizedIn': { label: 'Authorised to work in', type: 'list', group: 'Eligibility' },
  'workAuth.requiresSponsorship': { label: 'Requires visa sponsorship', type: 'boolean', group: 'Eligibility' },
  'workAuth.visaStatus': { label: 'Visa status', type: 'text', group: 'Eligibility' },
  'workAuth.needsRelocation': { label: 'Needs relocation', type: 'boolean', group: 'Eligibility' },

  'preferences.desiredSalary.amount': { label: 'Desired salary', type: 'number', group: 'Preferences' },
  'preferences.desiredSalary.currency': { label: 'Salary currency', type: 'choice', group: 'Preferences' },
  'preferences.desiredSalary.period': { label: 'Salary period', type: 'choice', group: 'Preferences' },
  // Asked on virtually every Indian application ("Current CTC"), and separately
  // from the expected figure — the two are never the same number.
  'preferences.currentSalary.amount': { label: 'Current salary / CTC', type: 'number', group: 'Preferences' },
  'preferences.currentSalary.currency': { label: 'Current salary currency', type: 'choice', group: 'Preferences' },
  'preferences.noticePeriod': { label: 'Notice period', type: 'text', group: 'Preferences' },
  // "Available to join (in days)" is a required numeric field on most Indian
  // applications; the free-text answer above cannot satisfy it.
  'preferences.noticePeriodDays': { label: 'Notice period (days)', type: 'number', group: 'Preferences' },
  // Where the applicant wants to work — never confuse this with where they live.
  'preferences.preferredLocations': { label: 'Preferred work locations', type: 'list', group: 'Preferences' },
  'preferences.earliestStartDate': { label: 'Earliest start date', type: 'date', group: 'Preferences' },
  'preferences.remotePreference': { label: 'Remote preference', type: 'choice', group: 'Preferences' },
  'preferences.willingToRelocate': { label: 'Willing to relocate', type: 'boolean', group: 'Preferences' },

  'eeo.gender': { label: 'Gender (voluntary)', type: 'choice', group: 'Voluntary' },
  'eeo.race': { label: 'Race (voluntary)', type: 'choice', group: 'Voluntary' },
  'eeo.ethnicity': { label: 'Ethnicity (voluntary)', type: 'choice', group: 'Voluntary' },
  'eeo.veteranStatus': { label: 'Veteran status (voluntary)', type: 'choice', group: 'Voluntary' },
  'eeo.disabilityStatus': { label: 'Disability status (voluntary)', type: 'choice', group: 'Voluntary' },

  'documents.resume': { label: 'Résumé / CV', type: 'file', group: 'Documents' },
  'documents.coverLetter': { label: 'Cover letter', type: 'file', group: 'Documents' },
  'documents.transcript': { label: 'Transcript', type: 'file', group: 'Documents' },
  'documents.portfolio': { label: 'Portfolio file', type: 'file', group: 'Documents' },

  'references[].name': { label: 'Reference name', type: 'text', group: 'References', repeatsOver: 'references' },
  'references[].title': { label: 'Reference title', type: 'text', group: 'References', repeatsOver: 'references' },
  'references[].company': { label: 'Reference company', type: 'text', group: 'References', repeatsOver: 'references' },
  'references[].email': { label: 'Reference email', type: 'email', group: 'References', repeatsOver: 'references' },
  'references[].phone': { label: 'Reference phone', type: 'tel', group: 'References', repeatsOver: 'references' },
  'references[].relationship': { label: 'Reference relationship', type: 'text', group: 'References', repeatsOver: 'references' },
};

/** Keys that never resolve from the profile alone — they need a file blob. */
export function isFileKey(key: CanonicalKey): boolean {
  return CANONICAL_KEY_META[key].type === 'file';
}

/** Keys belonging to a repeating profile array, with the array they repeat over. */
export function repeatsOver(key: CanonicalKey): CanonicalKeyMeta['repeatsOver'] {
  return CANONICAL_KEY_META[key].repeatsOver;
}
