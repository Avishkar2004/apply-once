import type { AtsAdapter } from './types';

/**
 * Oracle Taleo — "Hard: legacy, iframe-heavy, frequent full-page postbacks"
 * (ARCHITECTURE.md §5).
 *
 * Taleo generates ids like `requisitionDescriptionInterface.ID1234.row1`, which
 * are per-tenant and per-requisition — unusable as selectors. What it does have
 * is server-rendered `<label for>` markup, which Tier 1 handles well.
 *
 * Like the iCIMS adapter, this one exists to claim the page and record what is
 * true about it rather than to pretend at coverage it cannot deliver (§11).
 */
export const taleo: AtsAdapter = {
  name: 'taleo',

  matches(url, doc) {
    if (url.hostname.endsWith('taleo.net')) return true;
    return doc.querySelector('#requisitionDescriptionInterface, .taleo-form, [id^="taleo"]') !== null;
  },

  fieldMap: {
    // Suffix matching is the only shape that survives Taleo's id generation.
    'input[id$="firstName"], input[id$=".firstname"]': 'personal.firstName',
    'input[id$="lastName"], input[id$=".lastname"]': 'personal.lastName',
    'input[id$="email"], input[type="email"]': 'contact.email',
    'input[id$="phone"], input[type="tel"]': 'contact.phone',
    'input[type="file"]': 'documents.resume',
  },

  quirks: [
    'Ids embed the requisition, so they differ per posting — suffix selectors only.',
    'Frequent full-page postbacks; the re-scan observer keeps the registry current.',
    'Older tenants render the form in a frameset; each frame scans itself.',
  ],
};
