import { z } from 'zod';

/**
 * The canonical profile (ARCHITECTURE.md §4).
 *
 * Two deliberate properties of this schema:
 *
 * 1. **It is permissive about emptiness.** Milestone M0 is "you can enter and
 *    persist a full profile", and people fill a profile over several sittings.
 *    Empty strings validate; format is only checked once a value is present.
 *    Whether a profile is *good enough to apply with* is a separate question,
 *    answered by `profileCompleteness()` and surfaced in the editor.
 * 2. **Every EEO field defaults to declining** (ARCHITECTURE.md §4). Nothing in
 *    this system infers a demographic value; the only way one becomes anything
 *    other than `decline` is the user picking it in the editor.
 */

/** Empty string or a well-formed value — see note 1 above. */
const blankOr = <T extends z.ZodTypeAny>(inner: T) => z.union([z.literal(''), inner]);

const optionalText = z.string().trim().optional();
const emailish = blankOr(z.email()).optional();
const urlish = blankOr(z.url()).optional();

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` — see util/date.ts. */
const isoDateish = blankOr(z.string().regex(/^\d{4}(-\d{2})?(-\d{2})?$/, 'Expected YYYY, YYYY-MM or YYYY-MM-DD')).optional();

export const DOCUMENT_REF = z.object({
  blobId: z.string(),
  filename: z.string(),
  /** Extracted plain text, used to ground LLM answer drafts (ARCHITECTURE.md §3.6). */
  parsedText: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
});
export type DocumentRef = z.infer<typeof DOCUMENT_REF>;

export const EEO_DECLINE = 'decline' as const;

export const EEO_OPTIONS = {
  gender: ['male', 'female', 'non-binary', EEO_DECLINE],
  race: [
    'american-indian-or-alaska-native',
    'asian',
    'black-or-african-american',
    'hispanic-or-latino',
    'native-hawaiian-or-other-pacific-islander',
    'white',
    'two-or-more-races',
    EEO_DECLINE,
  ],
  ethnicity: ['hispanic-or-latino', 'not-hispanic-or-latino', EEO_DECLINE],
  veteranStatus: ['protected-veteran', 'not-a-protected-veteran', EEO_DECLINE],
  disabilityStatus: ['yes', 'no', EEO_DECLINE],
} as const;

export const EEO = z.object({
  gender: z.enum(EEO_OPTIONS.gender).default(EEO_DECLINE),
  race: z.enum(EEO_OPTIONS.race).default(EEO_DECLINE),
  ethnicity: z.enum(EEO_OPTIONS.ethnicity).default(EEO_DECLINE),
  veteranStatus: z.enum(EEO_OPTIONS.veteranStatus).default(EEO_DECLINE),
  disabilityStatus: z.enum(EEO_OPTIONS.disabilityStatus).default(EEO_DECLINE),
});
export type Eeo = z.infer<typeof EEO>;

export const ADDRESS = z.object({
  line1: z.string().trim().default(''),
  line2: optionalText,
  city: z.string().trim().default(''),
  state: z.string().trim().default(''),
  postalCode: z.string().trim().default(''),
  /** ISO 3166-1 alpha-2 where known, free text otherwise. */
  country: z.string().trim().default(''),
});

export const WORK_ENTRY = z.object({
  company: z.string().trim().default(''),
  title: z.string().trim().default(''),
  location: optionalText,
  employmentType: z
    .enum(['full-time', 'part-time', 'contract', 'internship', 'freelance', 'temporary'])
    .optional(),
  startDate: isoDateish,
  endDate: isoDateish,
  current: z.boolean().default(false),
  description: optionalText,
  achievements: z.array(z.string()).optional(),
});
export type WorkEntry = z.infer<typeof WORK_ENTRY>;

export const EDUCATION_ENTRY = z.object({
  school: z.string().trim().default(''),
  degree: z.string().trim().default(''),
  fieldOfStudy: z.string().trim().default(''),
  startDate: isoDateish,
  endDate: isoDateish,
  gpa: optionalText,
  honors: optionalText,
});
export type EducationEntry = z.infer<typeof EDUCATION_ENTRY>;

export const PROFILE = z.object({
  schemaVersion: z.number().int().positive(),

  personal: z.object({
    firstName: z.string().trim().default(''),
    middleName: optionalText,
    lastName: z.string().trim().default(''),
    preferredName: optionalText,
    pronouns: optionalText,
    dateOfBirth: isoDateish,
  }),

  contact: z.object({
    email: emailish,
    phone: z.string().trim().default(''),
    /** Stored separately because some forms split it out. E.164 prefix, e.g. "+1". */
    phoneCountryCode: optionalText,
    address: ADDRESS,
  }),

  links: z.object({
    linkedin: urlish,
    github: urlish,
    portfolio: urlish,
    website: urlish,
    twitter: urlish,
    other: z.array(z.string()).optional(),
  }),

  work: z.array(WORK_ENTRY).default([]),
  education: z.array(EDUCATION_ENTRY).default([]),

  skills: z.array(z.string()).default([]),
  languages: z
    .array(
      z.object({
        name: z.string(),
        proficiency: z.enum(['native', 'fluent', 'professional', 'conversational', 'basic']),
      }),
    )
    .optional(),
  certifications: z
    .array(
      z.object({
        name: z.string(),
        issuer: z.string().optional(),
        date: isoDateish,
        expiry: isoDateish,
        credentialId: optionalText,
      }),
    )
    .optional(),

  workAuth: z.object({
    /** ISO 3166-1 alpha-2 country codes. */
    authorizedIn: z.array(z.string()).default([]),
    requiresSponsorship: z.boolean().default(false),
    visaStatus: optionalText,
    needsRelocation: z.boolean().optional(),
  }),

  preferences: z.object({
    desiredSalary: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string().default('USD'),
        period: z.enum(['year', 'hour']).default('year'),
      })
      .optional(),
    // Kept apart from `desiredSalary`: forms outside the US ask for both, in
    // adjacent boxes, and filling the expected figure into the current one is a
    // materially bad answer rather than a cosmetic slip.
    currentSalary: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string().default('USD'),
      })
      .optional(),
    noticePeriod: optionalText,
    /**
     * The same answer as `noticePeriod`, as a number.
     *
     * Applications ask it both ways — a free-text box that wants "2 months" and
     * a required numeric one that wants "60" — so the resolver derives whichever
     * of the pair is missing rather than making the user answer twice.
     */
    noticePeriodDays: z.number().nonnegative().optional(),
    /** Cities the applicant wants to work in. Not where they live. */
    preferredLocations: z.array(z.string()).default([]),
    earliestStartDate: isoDateish,
    remotePreference: z.enum(['remote', 'hybrid', 'onsite', 'flexible']).optional(),
    willingToRelocate: z.boolean().optional(),
  }),

  eeo: EEO.optional(),

  documents: z
    .object({
      resume: DOCUMENT_REF.optional(),
      coverLetter: DOCUMENT_REF.optional(),
      transcript: DOCUMENT_REF.optional(),
      portfolio: DOCUMENT_REF.optional(),
    })
    .default({}),

  references: z
    .array(
      z.object({
        name: z.string(),
        title: optionalText,
        company: optionalText,
        email: emailish,
        phone: optionalText,
        relationship: optionalText,
      }),
    )
    .optional(),

  /** Set on every save. Read by `profileDrift` for the §11 review nudge. */
  updatedAt: z.string().optional(),
});

export type Profile = z.infer<typeof PROFILE>;
export type Address = z.infer<typeof ADDRESS>;

/** A brand-new profile at the current schema version. */
export function createEmptyProfile(schemaVersion: number): Profile {
  return PROFILE.parse({
    schemaVersion,
    personal: {},
    contact: { address: {} },
    links: {},
    workAuth: {},
    preferences: {},
    documents: {},
  });
}

/**
 * What is missing before this profile can carry a real application.
 * Advisory only — never blocks a save.
 */
export interface CompletenessReport {
  ready: boolean;
  missing: Array<{ field: string; label: string }>;
}

/**
 * Profile drift (ARCHITECTURE.md §11): "Stale applications — prompt for a
 * review after 90 days without an edit."
 *
 * A profile that has not been touched in three months is the failure mode this
 * guards: the fill still works perfectly and submits an old job title.
 */
export const PROFILE_REVIEW_INTERVAL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DriftReport {
  stale: boolean;
  /** Days since the last save, or `undefined` for a profile never saved. */
  daysSinceUpdate?: number;
}

export function profileDrift(profile: Profile, now: Date = new Date()): DriftReport {
  if (!profile.updatedAt) return { stale: false };

  const updated = Date.parse(profile.updatedAt);
  if (!Number.isFinite(updated)) return { stale: false };

  const daysSinceUpdate = Math.floor((now.getTime() - updated) / DAY_MS);
  return { stale: daysSinceUpdate >= PROFILE_REVIEW_INTERVAL_DAYS, daysSinceUpdate };
}

export function profileCompleteness(profile: Profile): CompletenessReport {
  const missing: CompletenessReport['missing'] = [];
  const require = (ok: boolean, field: string, label: string) => {
    if (!ok) missing.push({ field, label });
  };

  require(!!profile.personal.firstName, 'personal.firstName', 'First name');
  require(!!profile.personal.lastName, 'personal.lastName', 'Last name');
  require(!!profile.contact.email, 'contact.email', 'Email');
  require(!!profile.contact.phone, 'contact.phone', 'Phone');
  require(!!profile.contact.address.city, 'contact.address.city', 'City');
  require(!!profile.contact.address.country, 'contact.address.country', 'Country');
  require(!!profile.documents.resume, 'documents.resume', 'Résumé');
  require(profile.work.length > 0, 'work', 'At least one work entry');

  return { ready: missing.length === 0, missing };
}
