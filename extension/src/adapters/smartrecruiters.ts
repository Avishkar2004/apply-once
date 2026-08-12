import type { AtsAdapter } from './types';

/**
 * SmartRecruiters — "Medium: multi-step wizard" (ARCHITECTURE.md §5).
 *
 * The fields themselves are ordinary; the difficulty is that only one step is
 * mounted at a time, so a single scan sees a fraction of the form. `multiStep`
 * tells the session which node to watch so it can re-scan when the step changes
 * (§3.1).
 */
export const smartRecruiters: AtsAdapter = {
  name: 'smartrecruiters',

  matches(url, doc) {
    if (url.hostname.endsWith('smartrecruiters.com')) return true;
    return doc.querySelector('[data-test="application-form"], .sr-application') !== null;
  },

  fieldMap: {
    'input[name="firstName"], input[data-test="firstName"]': 'personal.firstName',
    'input[name="lastName"], input[data-test="lastName"]': 'personal.lastName',
    'input[name="email"], input[data-test="email"]': 'contact.email',
    'input[name="phoneNumber"], input[data-test="phoneNumber"]': 'contact.phone',
    'input[name="location.city"], input[data-test="city"]': 'contact.address.city',
    'input[name="location.country"], select[name="location.country"]': 'contact.address.country',
    'input[name="location.postalCode"]': 'contact.address.postalCode',
    'input[type="file"][name*="resume" i], input[data-test="resume-upload-input"]':
      'documents.resume',
    'input[name*="linkedin" i]': 'links.linkedin',
    'input[name*="web" i][name*="site" i]': 'links.website',
  },

  multiStep: {
    nextButton: '[data-test="next-button"], button[type="submit"].next, .wizard-next',
    stepIndicator: '[data-test="step-indicator"], .wizard-steps, [class*="progress"][role="list"]',
  },

  quirks: [
    'Only the active wizard step is in the DOM; the session re-scans when the step indicator changes.',
    'Consent checkboxes on the final step are intentionally left unmapped — they are the applicant’s to give.',
  ],
};
