import type { CanonicalKey } from '@autofill/core';
import type { FieldKind } from '@/shared/types';

/**
 * Tier 1 — deterministic rules (ARCHITECTURE.md §3.2).
 *
 * Two tables:
 *
 *  - `AUTOCOMPLETE_RULES`: the WHATWG `autocomplete` token, when the site sets an
 *    honest one. This is the highest-signal cheap match there is.
 *  - `LABEL_RULES`: ordered regexes over the normalised `labelBlob`. **First match
 *    wins**, so specific rules precede general ones, and `not` patterns exist to
 *    prevent the classic misfires — "Company Name" must never reach
 *    `personal.lastName`.
 *
 * The blob is lowercase, punctuation-free and space-separated, so `\b` anchors
 * behave predictably. Rules are matched against the blob only; the section
 * heading is applied separately as a disambiguator (see `tier1.ts`).
 */

export interface LabelRule {
  /** Stable identifier — referenced by tests and by the mapping debug view. */
  id: string;
  key: CanonicalKey;
  match: RegExp;
  /** Any hit here rejects the rule. */
  not?: RegExp;
  /** Restrict the rule to particular control kinds. */
  kinds?: FieldKind[];
}

/** `autocomplete` token → canonical key. Section/`shipping`/`billing` prefixes are stripped. */
export const AUTOCOMPLETE_RULES: Record<string, CanonicalKey> = {
  'given-name': 'personal.firstName',
  'additional-name': 'personal.middleName',
  'family-name': 'personal.lastName',
  name: 'personal.fullName',
  nickname: 'personal.preferredName',
  bday: 'personal.dateOfBirth',

  email: 'contact.email',
  username: 'contact.email',
  tel: 'contact.phone',
  'tel-national': 'contact.phone',
  'tel-country-code': 'contact.phoneCountryCode',

  'street-address': 'contact.address.full',
  'address-line1': 'contact.address.line1',
  'address-line2': 'contact.address.line2',
  'address-level2': 'contact.address.city',
  'address-level1': 'contact.address.state',
  'postal-code': 'contact.address.postalCode',
  country: 'contact.address.country',
  'country-name': 'contact.address.country',

  url: 'links.website',
  organization: 'work[].company',
  'organization-title': 'work[].title',
};

/** Words that mean the field is about somebody or something other than the applicant. */
const NOT_APPLICANT = /\b(company|employer|organisation|organization|school|university|college|institution|reference|referee|supervisor|manager|emergency|contact person|recruiter|friend)\b/;

export const LABEL_RULES: LabelRule[] = [
  // ─────────────── personal ───────────────
  { id: 'first-name', key: 'personal.firstName', match: /\b(first|given|fore)\s?name\b|\bfirstname\b|\bfname\b/, not: NOT_APPLICANT },
  { id: 'last-name', key: 'personal.lastName', match: /\b(last|family|sur)\s?name\b|\blastname\b|\bsurname\b|\blname\b/, not: NOT_APPLICANT },
  { id: 'middle-name', key: 'personal.middleName', match: /\bmiddle\s?(name|initial)\b|\bmname\b/ },
  { id: 'preferred-name', key: 'personal.preferredName', match: /\b(preferred|nick|chosen|display)\s?name\b|\bgoes by\b|\bwhat should we call you\b/ },
  { id: 'pronouns', key: 'personal.pronouns', match: /\bpronouns?\b/ },
  { id: 'date-of-birth', key: 'personal.dateOfBirth', match: /\b(date of birth|birth\s?date|dob|birthday)\b/ },
  { id: 'full-name', key: 'personal.fullName', match: /\b(full|legal|your|applicant|candidate)?\s?name\b/, not: new RegExp(`${NOT_APPLICANT.source}|\\b(first|last|middle|preferred|nick|file|user|domain|event|product|project|role|job|position|degree|award|certificat\\w*|language|skill)\\b`) },

  // ─────────────── contact ───────────────
  // The blob is punctuation-free, so "e-mail" arrives as "e mail".
  { id: 'email', key: 'contact.email', match: /\be ?mail\b/, not: /\b(confirm|verify|re enter|alternate|secondary|reference|employer)\b/ },
  { id: 'phone-country-code', key: 'contact.phoneCountryCode', match: /\b(country code|dial code|phone code|idd)\b/ },
  { id: 'phone', key: 'contact.phone', match: /\b(phone|mobile|cell|telephone|contact number|tel)\b/, not: /\b(country code|dial code|reference|employer|emergency|extension)\b/ },
  // Ahead of the whole address block on purpose. "Preferred Location" and
  // "Preferred City" are questions about the *job*, and every generic address
  // rule below would otherwise claim them and fill in where the applicant
  // happens to live. A preference by key, placed here by necessity.
  { id: 'preferred-location', key: 'preferences.preferredLocations', match: /\b(preferred|desired|interested in|willing to work in) (job |work )?(locations?|cit(y|ies))\b|\bpreferred work location\b|\bwhere would you like to work\b|\blocation applying for\b/ },
  { id: 'address-line1', key: 'contact.address.line1', match: /\b(address line 1|street address|address 1|addr1|street|house number)\b/ },
  { id: 'address-line2', key: 'contact.address.line2', match: /\b(address line 2|address 2|addr2|apt|apartment|suite|unit)\b/ },
  { id: 'city', key: 'contact.address.city', match: /\b(city|town|locality|municipality)\b/, not: /\b(country|birth)\b/ },
  { id: 'state', key: 'contact.address.state', match: /\b(state|province|region|county|prefecture)\b/, not: /\b(united states|visa|employment|marital|veteran|disability)\b/ },
  { id: 'postal-code', key: 'contact.address.postalCode', match: /\b(zip|postal|post ?code|pincode|postcode)\b/ },
  { id: 'country', key: 'contact.address.country', match: /\b(country|nation)\b/, not: /\b(code|citizenship|authorized|authorised|eligible|work in)\b/ },
  // "Current Location" or "What is your location?" asks where the applicant
  // lives, and the answer wanted is a city — "Pune", not a postal address. The
  // job-location rule above has already claimed the wording that means the
  // vacancy, so this only sees what it left.
  { id: 'current-location', key: 'contact.address.city', match: /\b(current|present|your) location\b|\blocation\b/, not: /\b(job|work|office|posting|preferred|desired)\b/ },
  { id: 'address-full', key: 'contact.address.full', match: /\b(address|residence|where do you live)\b/, not: /\b(email|line 1|line 2|ip)\b/ },

  // ─────────────── links ───────────────
  { id: 'linkedin', key: 'links.linkedin', match: /\blinked ?in\b/ },
  { id: 'github', key: 'links.github', match: /\bgit ?hub\b/ },
  { id: 'twitter', key: 'links.twitter', match: /\b(twitter|x com handle)\b/ },
  { id: 'portfolio', key: 'links.portfolio', match: /\b(portfolio|dribbble|behance|personal site)\b/ },
  { id: 'website', key: 'links.website', match: /\b(website|web site|blog|homepage|personal url|url)\b/, not: /\b(company|employer|school)\b/ },

  // ─────────────── documents ───────────────
  { id: 'resume', key: 'documents.resume', match: /\b(resume|résumé|cv|curriculum vitae)\b/, kinds: ['file'] },
  { id: 'cover-letter', key: 'documents.coverLetter', match: /\bcover letter\b/, kinds: ['file'] },
  // "Cover Letter / Message" is a textarea on most boards, and an uploaded PDF
  // is no use in one. Same question, different control, different profile field.
  { id: 'cover-letter-text', key: 'documents.coverLetterText', match: /\bcover letter\b|\b(message|note) to (the )?(recruiter|hiring manager|employer|hr)\b|\banything else you would like us to know\b/, kinds: ['textarea', 'text'] },
  { id: 'transcript', key: 'documents.transcript', match: /\btranscript\b/, kinds: ['file'] },
  { id: 'portfolio-file', key: 'documents.portfolio', match: /\b(portfolio|work sample|writing sample)\b/, kinds: ['file'] },
  // Last resort for a file input. Plenty of forms label the résumé slot
  // "Add attachment" or nothing at all, and every specific document rule above
  // has already had its turn, so an unclaimed upload box is the résumé.
  { id: 'attachment', key: 'documents.resume', match: /\b(attach|attachment|upload|browse|choose file|document)\b/, kinds: ['file'] },

  // ─────────────── work history ───────────────
  { id: 'work-company', key: 'work[].company', match: /\b(company|employer|organisation|organization)\s?(name)?\b/, not: /\b(school|university|reference|why|about|size|website|url)\b/ },
  { id: 'work-title', key: 'work[].title', match: /\b(job title|position title|current title|your title|role title|designation|title)\b/, not: /\b(reference|mr|mrs|ms|dr|degree|job you|position you are applying)\b/ },
  // "Experience" boxes, most specific first. Forms outside the US often split
  // the figure across two adjacent controls, so the months half has to be
  // claimed before anything can mistake it for the years half.
  { id: 'work-experience-months', key: 'work.totalMonths', match: /\bexperience\b[\w ]*\bmonths?\b|\bmonths?\b[\w ]*\bexperience\b/, kinds: ['number', 'select', 'combobox', 'text'] },
  { id: 'work-experience-years', key: 'work.totalYears', match: /\b(total|years of|overall|relevant) experience\b|\bexperience in years\b|\byears of exp\b|\bexperience\b[\w ]*\byears?\b/ },
  // A bare "Experience *" beside a number box means the same thing. Restricted
  // to short controls so "Tell us about your experience" stays a written answer.
  { id: 'work-experience', key: 'work.totalYears', match: /\bexperience\b/, not: /\b(describe|tell us|summar\w*|detail|previous|why|no experience|relevant to)\b/, kinds: ['number', 'select', 'combobox', 'text'] },
  { id: 'work-location', key: 'work[].location', match: /\b(job location|work location|office location)\b/ },
  { id: 'work-start', key: 'work[].startDate', match: /\b(employment )?start(ed|ing)? date\b|\bfrom date\b/, not: /\b(school|education|degree|available|earliest|study)\b/ },
  { id: 'work-end', key: 'work[].endDate', match: /\b(employment )?end(ed|ing)? date\b|\bto date\b/, not: /\b(school|education|degree|study)\b/ },
  { id: 'work-current', key: 'work[].current', match: /\b(currently work|current(ly)? employed|i currently work here|present)\b/, kinds: ['checkbox'] },
  { id: 'work-description', key: 'work[].description', match: /\b(role description|responsibilities|what did you do)\b/ },

  // ─────────────── education ───────────────
  { id: 'school', key: 'education[].school', match: /\b(school|university|college|institution|alma mater)\b/, not: /\b(high school graduation only|reference)\b/ },
  { id: 'degree', key: 'education[].degree', match: /\b(degree|qualification|education level|highest level)\b/ },
  { id: 'field-of-study', key: 'education[].fieldOfStudy', match: /\b(field of study|major|discipline|concentration|subject)\b/ },
  { id: 'gpa', key: 'education[].gpa', match: /\b(gpa|grade point|marks|percentage|cgpa)\b/ },
  { id: 'education-start', key: 'education[].startDate', match: /\b(education|school|study|degree) start\b|\bstart(ed)? (school|university|college)\b/ },
  { id: 'education-end', key: 'education[].endDate', match: /\b(graduation|grad|completion) (date|year)\b|\b(education|school|study|degree) end\b/ },
  { id: 'honors', key: 'education[].honors', match: /\b(honors|honours|distinction|cum laude)\b/ },

  // ─────────────── skills & languages ───────────────
  { id: 'skills', key: 'skills', match: /\b(skills|technologies|technical skills|competencies|tech stack)\b/ },
  { id: 'language', key: 'languages[].name', match: /\blanguages?\b/, not: /\bprogramming\b/ },
  { id: 'certification', key: 'certifications[].name', match: /\bcertificat(e|ion)s?\b/, not: /\bissuer\b/ },
  { id: 'certification-issuer', key: 'certifications[].issuer', match: /\b(certification|certificate) (issuer|authority|organisation|organization)\b/ },

  // ─────────────── work authorisation ───────────────
  { id: 'sponsorship', key: 'workAuth.requiresSponsorship', match: /\b(sponsor|sponsorship|require.*visa|visa support|h1b|h 1b)\b/, not: /\b(status|type)\b/ },
  { id: 'authorized-in', key: 'workAuth.authorizedIn', match: /\b(legally authoriz|legally authoris|authoriz(ed)? to work|eligible to work|right to work|work permit)\b/ },
  { id: 'visa-status', key: 'workAuth.visaStatus', match: /\b(visa status|immigration status|work permit type|citizenship status)\b/ },
  { id: 'needs-relocation', key: 'workAuth.needsRelocation', match: /\b(need.*relocat|require.*relocat)\b/ },

  // ─────────────── preferences ───────────────
  // Current before desired: an application that asks for both puts them side by
  // side, and answering "expected" into the "current" box is a lie rather than
  // a typo. First-match-wins does the rest.
  { id: 'current-salary', key: 'preferences.currentSalary.amount', match: /\b(current|present|existing|drawn) (salary|ctc|compensation|pay|package|remuneration)\b|\bcurrent annual\b/, not: /\b(currency|period)\b/ },
  { id: 'current-salary-currency', key: 'preferences.currentSalary.currency', match: /\bcurrent (salary )?currency\b/ },
  { id: 'desired-salary', key: 'preferences.desiredSalary.amount', match: /\b(salary|compensation|pay|rate) (expectation|requirement|desired|range)?\b|\bdesired (salary|compensation)\b|\bexpected (salary|ctc|package)\b/, not: /\b(currency|period|current (salary|ctc|compensation|package))\b/ },
  { id: 'salary-currency', key: 'preferences.desiredSalary.currency', match: /\b(salary )?currency\b/ },
  { id: 'salary-period', key: 'preferences.desiredSalary.period', match: /\b(per (year|hour)|salary period|pay period|annual or hourly)\b/ },
  // "Available to join" is how the same question is asked across Indian boards,
  // and it is usually a required *numeric* box. The days rule has to come first
  // so "(in days)" is not answered with the free-text "2 months".
  { id: 'notice-period-days', key: 'preferences.noticePeriodDays', match: /\b(notice period|available to join|joining time|join)\b[\w ]*\bdays\b|\bdays\b[\w ]*\b(to join|notice)\b/, kinds: ['number', 'text', 'select', 'combobox'] },
  { id: 'notice-period', key: 'preferences.noticePeriod', match: /\bnotice period\b|\bavailable to join\b|\bjoining (time|period|days)\b|\bhow soon can you join\b|\bdays to join\b/ },
  { id: 'start-date', key: 'preferences.earliestStartDate', match: /\b(earliest|available|availability|when can you) (start|start date|begin)\b|\bstart date\b/, not: /\b(employment|school|education|previous|current job)\b/ },
  { id: 'remote-preference', key: 'preferences.remotePreference', match: /\b(remote|hybrid|onsite|on site|work (location )?preference|work arrangement)\b/, not: /\b(job location|office location)\b/ },
  { id: 'willing-to-relocate', key: 'preferences.willingToRelocate', match: /\b(willing to relocate|open to relocation|relocat\w*)\b/, not: /\bneed\b/ },

  // ─────────────── voluntary self-identification ───────────────
  // Never inferred (ARCHITECTURE.md §4) — these only resolve if the user set them.
  { id: 'eeo-gender', key: 'eeo.gender', match: /\bgender\b|\bsex\b/ },
  { id: 'eeo-ethnicity', key: 'eeo.ethnicity', match: /\b(hispanic|latino|ethnicity)\b/ },
  { id: 'eeo-race', key: 'eeo.race', match: /\b(race|racial)\b/ },
  { id: 'eeo-veteran', key: 'eeo.veteranStatus', match: /\bveteran\b/ },
  { id: 'eeo-disability', key: 'eeo.disabilityStatus', match: /\bdisabilit(y|ies)\b/ },

  // ─────────────── references ───────────────
  { id: 'reference-name', key: 'references[].name', match: /\breference (name|full name)\b|\brefere(e|nce) name\b/ },
  { id: 'reference-email', key: 'references[].email', match: /\breference e ?mail\b/ },
  { id: 'reference-phone', key: 'references[].phone', match: /\breference (phone|number)\b/ },
  { id: 'reference-company', key: 'references[].company', match: /\breference (company|employer)\b/ },
  { id: 'reference-title', key: 'references[].title', match: /\breference (title|position)\b/ },
  { id: 'reference-relationship', key: 'references[].relationship', match: /\b(relationship to (you|reference)|how do you know)\b/ },
];

/**
 * Section headings that flip an otherwise-ambiguous rule onto a different
 * canonical key. Applied only when the rule matched but the heading disagrees
 * (ARCHITECTURE.md §11 — "Section heading as disambiguating context").
 */
export const SECTION_OVERRIDES: Array<{ heading: RegExp; from: CanonicalKey; to: CanonicalKey }> = [
  { heading: /\b(education|academic|school)\b/i, from: 'work[].startDate', to: 'education[].startDate' },
  { heading: /\b(education|academic|school)\b/i, from: 'work[].endDate', to: 'education[].endDate' },
  { heading: /\b(education|academic|school)\b/i, from: 'work[].company', to: 'education[].school' },
  { heading: /\b(education|academic|school)\b/i, from: 'work[].location', to: 'education[].school' },
  { heading: /\b(reference)\b/i, from: 'personal.fullName', to: 'references[].name' },
  { heading: /\b(reference)\b/i, from: 'contact.email', to: 'references[].email' },
  { heading: /\b(reference)\b/i, from: 'contact.phone', to: 'references[].phone' },
  { heading: /\b(reference)\b/i, from: 'work[].company', to: 'references[].company' },
  { heading: /\b(employment|work|experience|professional)\b/i, from: 'education[].startDate', to: 'work[].startDate' },
  { heading: /\b(employment|work|experience|professional)\b/i, from: 'education[].endDate', to: 'work[].endDate' },
];
