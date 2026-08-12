import type { AtsAdapter } from './types';

/**
 * Ashby — "Medium: React, custom comboboxes" (ARCHITECTURE.md §5).
 *
 * Ashby names its built-in fields `_systemfield_*`, which has been stable for
 * years. Everything a company adds itself is keyed by UUID and is deliberately
 * left to the generic cascade — a UUID selector would rot on the next edit.
 */
export const ashby: AtsAdapter = {
  name: 'ashby',

  matches(url, doc) {
    if (url.hostname.endsWith('ashbyhq.com')) return true;
    return doc.querySelector('[class*="ashby-application-form"], form[data-ashby]') !== null;
  },

  fieldMap: {
    'input[name="_systemfield_name"]': 'personal.fullName',
    'input[name="_systemfield_email"]': 'contact.email',
    'input[name="_systemfield_phone"]': 'contact.phone',
    'input[name="_systemfield_location"]': 'contact.address.full',
    'input[name="_systemfield_resume"][type="file"]': 'documents.resume',
    'input[name="_systemfield_linkedin"], input[name*="linkedin" i]': 'links.linkedin',
    'input[name="_systemfield_github"], input[name*="github" i]': 'links.github',
    'input[name*="website" i], input[name*="portfolio" i]': 'links.portfolio',
  },

  comboboxStrategy: {
    // Ashby renders its listbox into a portal at the end of <body>, not inside
    // the field's own container.
    listbox: '[class*="_dropdownContainer"], [class*="ashby-select__menu"], [role="listbox"]',
    option: '[class*="ashby-select__option"], [role="option"], li',
    typeToFilter: true,
  },

  quirks: [
    'Company-defined questions are keyed by UUID; only the `_systemfield_*` set is stable enough to map by selector.',
    'The location field is a typeahead whose menu portals to <body>.',
  ],
};
