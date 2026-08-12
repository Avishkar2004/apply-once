import type { AtsAdapter } from './types';

/**
 * Workday — the hard one (ARCHITECTURE.md §5).
 *
 * "Nested shadow DOM, custom everything, aggressive re-render, per-tenant
 * subdomains. Workday alone justifies the adapter layer. Treat it as its own
 * milestone and budget accordingly — expect a week of iteration on its combobox
 * and date widgets."
 *
 * What makes it tractable is `data-automation-id`: Workday sets it on
 * essentially every control, it is part of their own test tooling, and it is
 * consistent across tenants in a way that class names and ids are not. The
 * shadow-DOM problem is already handled upstream — `scanner/traverse.ts`
 * recurses into every open shadow root.
 *
 * This adapter is deliberately selector-only. Workday's re-render behaviour is
 * handled by the executor's pacing and the verifier, not by special-casing here.
 */
export const workday: AtsAdapter = {
  name: 'workday',

  matches(url, doc) {
    if (url.hostname.endsWith('myworkdayjobs.com') || url.hostname.endsWith('myworkdaysite.com')) {
      return true;
    }
    return doc.querySelector('[data-automation-id="jobPostingPage"], [data-automation-id="applyFlow"]') !== null;
  },

  fieldMap: {
    '[data-automation-id="legalNameSection_firstName"]': 'personal.firstName',
    '[data-automation-id="legalNameSection_lastName"]': 'personal.lastName',
    '[data-automation-id="legalNameSection_middleName"]': 'personal.middleName',
    '[data-automation-id="preferredNameSection_firstName"]': 'personal.preferredName',

    '[data-automation-id="email"], [data-automation-id="contactInformation_email"]':
      'contact.email',
    '[data-automation-id="phone-number"], [data-automation-id="phoneNumber"]': 'contact.phone',
    '[data-automation-id="phone-device-type"]': 'contact.phoneCountryCode',

    '[data-automation-id="addressSection_addressLine1"]': 'contact.address.line1',
    '[data-automation-id="addressSection_addressLine2"]': 'contact.address.line2',
    '[data-automation-id="addressSection_city"]': 'contact.address.city',
    '[data-automation-id="addressSection_countryRegion"]': 'contact.address.state',
    '[data-automation-id="addressSection_postalCode"]': 'contact.address.postalCode',
    '[data-automation-id="countryDropdown"], [data-automation-id="country"]':
      'contact.address.country',

    '[data-automation-id="file-upload-input-ref"], [data-automation-id="resumeUpload"] input[type="file"]':
      'documents.resume',

    '[data-automation-id="linkedinQuestion"], [data-automation-id*="linkedin" i]': 'links.linkedin',
    '[data-automation-id="websiteQuestion"], [data-automation-id*="website" i]': 'links.website',

    // "How did you hear about us?" is deliberately absent — it is not a profile
    // field, and guessing at it would put the wrong answer in a real application.

    '[data-automation-id="gender"]': 'eeo.gender',
    '[data-automation-id="ethnicity"], [data-automation-id="hispanicOrLatino"]': 'eeo.ethnicity',
    '[data-automation-id="veteranStatus"]': 'eeo.veteranStatus',
    '[data-automation-id="disabilityStatus"], [data-automation-id="selfIdentifiedDisabilityData"]':
      'eeo.disabilityStatus',
  },

  comboboxStrategy: {
    // Workday's "dropdown" is a button that opens a portalled listbox; the
    // trigger is not the element that holds the value.
    trigger: '[data-automation-id="dropdownButton"], button[aria-haspopup="listbox"]',
    listbox: '[data-automation-id="activeListContainer"], ul[role="listbox"], [role="listbox"]',
    option: '[data-automation-id="promptOption"], li[role="option"], [role="option"]',
    // Typing into a Workday prompt is unreliable; it filters on click-open alone.
    typeToFilter: false,
  },

  repeatingSections: [
    {
      source: 'work',
      container: '[data-automation-id="workExperienceSection"]',
      addButton: '[data-automation-id="Add"], [aria-label="Add Work Experience"]',
      rowSelector: '[data-automation-id^="workExperience-"]',
    },
    {
      source: 'education',
      container: '[data-automation-id="educationSection"]',
      addButton: '[data-automation-id="Add"], [aria-label="Add Education"]',
      rowSelector: '[data-automation-id^="education-"]',
    },
  ],

  multiStep: {
    nextButton: '[data-automation-id="bottom-navigation-next-button"]',
    stepIndicator: '[data-automation-id="progressBar"], [data-automation-id="progressBarActiveStep"]',
  },

  quirks: [
    'Per-tenant subdomains: every customer gets their own host under myworkdayjobs.com.',
    'Controls live in nested open shadow roots; the scanner recurses into them.',
    'Dropdowns are buttons over a portalled listbox — the trigger is not the value holder.',
    'Aggressive re-render: the verifier is what catches a value the page throws away.',
    'ARCHITECTURE.md §5 budgets a week of iteration here. This adapter is a starting point, not a finished one.',
  ],
};
