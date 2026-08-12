import { CANONICAL_KEYS, CANONICAL_KEY_META, type CanonicalKey } from '@autofill/core';

/**
 * The Tier 2 corpus — the phrasings each canonical key is embedded as
 * (ARCHITECTURE.md §3.2: "Canonical field labels are embedded once at install
 * and cached").
 *
 * Every key contributes at least its own label. The aliases below exist for
 * keys whose label alone embeds poorly against how forms actually word the
 * question — "Will you now or in the future require sponsorship?" is a long way
 * from "Requires visa sponsorship" in embedding space.
 *
 * A phrase here should be how a *form* words it, not how we word it. Adding a
 * phrasing is the cheapest fix for a Tier 2 miss found in the wild.
 */
const ALIASES: Partial<Record<CanonicalKey, string[]>> = {
  'personal.firstName': ['given name', 'forename'],
  'personal.lastName': ['surname', 'family name'],
  'personal.fullName': ['your name', 'legal name', 'name as it appears on your ID'],
  'personal.preferredName': ['what should we call you', 'nickname', 'goes by'],
  'personal.pronouns': ['what pronouns do you use'],

  'contact.email': ['email address', 'how can we reach you by email'],
  'contact.phone': ['mobile number', 'contact number', 'best number to reach you'],
  'contact.address.line1': ['street address', 'house number and street'],
  'contact.address.city': ['town', 'city of residence', 'where are you based'],
  'contact.address.state': ['province', 'region', 'county'],
  'contact.address.postalCode': ['zip code', 'postcode', 'pin code'],
  'contact.address.country': ['country of residence', 'which country do you live in'],
  'contact.address.full': ['where do you live', 'home address'],

  'links.linkedin': ['linkedin profile url'],
  'links.github': ['github profile', 'link to your code'],
  'links.portfolio': ['portfolio url', 'link to your work', 'dribbble or behance'],
  'links.website': ['personal website', 'blog url'],

  'work[].company': ['current employer', 'most recent company', 'where do you work now'],
  'work[].title': ['current job title', 'your role', 'position held'],
  'work[].startDate': ['when did you start this role'],
  'work[].endDate': ['when did you leave this role'],
  'work[].description': ['what did you do in this role', 'key responsibilities'],

  'education[].school': ['university attended', 'name of institution', 'where did you study'],
  'education[].degree': ['highest level of education', 'qualification obtained'],
  'education[].fieldOfStudy': ['major', 'area of study', 'discipline'],
  'education[].gpa': ['grade point average', 'final grade', 'marks obtained'],

  skills: ['technical skills', 'what technologies do you know', 'areas of expertise'],

  'workAuth.requiresSponsorship': [
    'will you now or in the future require sponsorship for an employment visa',
    'do you need visa sponsorship',
  ],
  'workAuth.authorizedIn': [
    'are you legally authorized to work in this country',
    'do you have the right to work here',
  ],
  'workAuth.visaStatus': ['what is your current work authorization status'],

  'preferences.desiredSalary.amount': [
    'what are your salary expectations',
    'expected compensation',
    'desired base salary',
  ],
  'preferences.noticePeriod': ['how much notice do you need to give'],
  'preferences.earliestStartDate': ['when could you start', 'availability to start'],
  'preferences.remotePreference': ['do you prefer remote or onsite', 'work arrangement preference'],
  'preferences.willingToRelocate': ['would you be willing to relocate for this role'],

  'eeo.gender': ['gender identity'],
  'eeo.ethnicity': ['are you hispanic or latino'],
  'eeo.race': ['racial background'],
  'eeo.veteranStatus': ['protected veteran status'],
  'eeo.disabilityStatus': ['do you have a disability'],

  'documents.resume': ['upload your cv', 'attach resume'],
  'documents.coverLetter': ['upload a cover letter'],
};

export interface CorpusEntry {
  key: CanonicalKey;
  phrase: string;
}

/** Flat list of `(key, phrase)` pairs — one embedding per entry. */
export function buildCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  for (const key of CANONICAL_KEYS) {
    entries.push({ key, phrase: CANONICAL_KEY_META[key].label.toLowerCase() });
    for (const phrase of ALIASES[key] ?? []) entries.push({ key, phrase });
  }
  return entries;
}

/**
 * Changing the corpus changes what the cached vectors mean, so the cache is
 * keyed by this. Bump it whenever `ALIASES` or the key list changes.
 */
export const CORPUS_VERSION = 1;
