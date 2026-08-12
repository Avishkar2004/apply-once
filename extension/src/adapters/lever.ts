import type { AtsAdapter } from './types';

/**
 * Lever — "Easy: predictable structure, honest `autocomplete`"
 * (ARCHITECTURE.md §5).
 *
 * Lever posts a single flat form with `name` attributes that have been stable
 * for years. The one non-trivial control is the location field, which is a
 * typeahead rather than a `select`.
 */
export const lever: AtsAdapter = {
  name: 'lever',

  matches(url, doc) {
    if (url.hostname.endsWith('lever.co')) return true;
    return doc.querySelector('form[action*="lever.co"], .application-form, #application-form') !== null;
  },

  fieldMap: {
    'input[name="name"]': 'personal.fullName',
    'input[name="email"]': 'contact.email',
    'input[name="phone"]': 'contact.phone',
    'input[name="org"]': 'work[].company',
    'input[name="location"], input[name="selectedLocation"]': 'contact.address.full',

    'input[name="urls[LinkedIn]"]': 'links.linkedin',
    'input[name="urls[GitHub]"]': 'links.github',
    'input[name="urls[Portfolio]"]': 'links.portfolio',
    'input[name="urls[Twitter]"]': 'links.twitter',
    'input[name="urls[Other]"]': 'links.website',

    'input[name="resume"][type="file"]': 'documents.resume',

    'select[name="eeo[gender]"], select[name*="gender" i]': 'eeo.gender',
    'select[name="eeo[race]"], select[name*="race" i]': 'eeo.race',
    'select[name="eeo[veteran]"], select[name*="veteran" i]': 'eeo.veteranStatus',
    'select[name="eeo[disability]"], select[name*="disability" i]': 'eeo.disabilityStatus',
  },

  comboboxStrategy: {
    listbox: '.dropdown-container, [role="listbox"], .location-dropdown',
    option: '.dropdown-location, [role="option"], li',
    typeToFilter: true,
  },

  quirks: [
    'Location is a Google-Places-backed typeahead; the visible input is `location` and the resolved value lands in a hidden `selectedLocation`.',
    'Custom questions use `cards[<uuid>][field<n>]` names and are left to the generic cascade.',
  ],
};
