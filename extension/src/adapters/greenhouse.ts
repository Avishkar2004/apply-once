import type { AtsAdapter } from './types';

/**
 * Greenhouse — "Easy: clean semantic HTML, stable `name` attributes"
 * (ARCHITECTURE.md §5).
 *
 * Covers both the classic `boards.greenhouse.io` markup (stable element ids) and
 * the newer `job-boards.greenhouse.io` React board (`name` attributes), plus
 * boards embedded in a company site via iframe — the content script runs inside
 * that frame, so `matches` is written against the document, not the top URL.
 */
export const greenhouse: AtsAdapter = {
  name: 'greenhouse',

  matches(url, doc) {
    if (url.hostname.endsWith('greenhouse.io')) return true;
    return doc.querySelector('#application_form, form[action*="greenhouse.io"], #grnhse_app') !== null;
  },

  fieldMap: {
    '#first_name, input[name="first_name"]': 'personal.firstName',
    '#last_name, input[name="last_name"]': 'personal.lastName',
    '#email, input[name="email"]': 'contact.email',
    '#phone, input[name="phone"]': 'contact.phone',

    '#job_application_location, input[name="job_application[location]"], input[id*="location"]':
      'contact.address.full',

    'input[type="file"]#resume, input[name="resume"], input[name*="resume" i][type="file"]':
      'documents.resume',
    'input[type="file"]#cover_letter, input[name="cover_letter"], input[name*="cover_letter" i][type="file"]':
      'documents.coverLetter',

    'input[name*="LinkedIn"], input[id*="linkedin" i]': 'links.linkedin',
    'input[name*="GitHub"], input[id*="github" i]': 'links.github',
    'input[name*="Portfolio"], input[id*="portfolio" i]': 'links.portfolio',
    'input[name*="Website"], input[id*="website" i]': 'links.website',

    // Voluntary self-identification. Mapped so the fields are *recognised*; they
    // are only filled when the user turns the setting on (§4, mapping/plan.ts).
    '#gender, select[name*="gender" i]': 'eeo.gender',
    '#hispanic_ethnicity, select[name*="hispanic" i]': 'eeo.ethnicity',
    '#race, select[name*="race" i]': 'eeo.race',
    '#veteran_status, select[name*="veteran" i]': 'eeo.veteranStatus',
    '#disability_status, select[name*="disability" i]': 'eeo.disabilityStatus',
  },

  quirks: [
    'The classic board renders inside an iframe on company career sites; the content script runs in that frame.',
    'Custom questions use generated names (job_application_answers_attributes_N_…) and are left to the generic cascade.',
  ],
};
