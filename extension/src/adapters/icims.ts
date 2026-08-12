import type { AtsAdapter } from './types';

/**
 * iCIMS — "Hard: legacy, iframe-heavy, frequent full-page postbacks"
 * (ARCHITECTURE.md §5).
 *
 * The form lives inside `#icims_content_iframe`, which is itself on an
 * `*.icims.com` host — so the content script is injected into it directly
 * (`all_frames`) and the frame scans itself. No parent-side recursion needed.
 *
 * Field ids are generated per tenant (`#fields_1`, `#field_38`), so almost
 * nothing here is safe to map by selector. iCIMS does emit sane `<label for>`
 * markup, which is what Tier 1 needs, so this adapter is mostly a marker: it
 * claims the page, records the quirks, and lets the generic cascade work.
 *
 * §11: "Adapters are an optimization; the generic cascade is the floor. Never
 * let an adapter be load-bearing." This is that principle applied honestly —
 * a thin adapter beats a confident one built on selectors that rot.
 */
export const icims: AtsAdapter = {
  name: 'icims',

  matches(url, doc) {
    if (url.hostname.endsWith('icims.com')) return true;
    return doc.querySelector('#icims_content_iframe, .iCIMS_MainWrapper, #icims_content') !== null;
  },

  fieldMap: {
    // The only selectors stable across tenants are the autocomplete-backed ones.
    'input[autocomplete="given-name"]': 'personal.firstName',
    'input[autocomplete="family-name"]': 'personal.lastName',
    'input[type="email"][id*="email" i], input[autocomplete="email"]': 'contact.email',
    'input[type="file"][id*="resume" i], input[type="file"][name*="resume" i]': 'documents.resume',
  },

  quirks: [
    'The application form is inside #icims_content_iframe on an icims.com host; the content script runs inside that frame.',
    'Field ids are generated per tenant, so labels — not selectors — are what map reliably here.',
    'Full-page postbacks replace the DOM; the MutationObserver re-scan is what keeps the field registry current.',
  ],
};
