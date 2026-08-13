/**
 * Where AutoFill runs.
 *
 * **Every site.** The user's requirement is that this works on any job
 * application, registration or contact form, not on a curated list — and the
 * long tail of employer career pages (Keka, Zoho Recruit, Darwinbox, Freshteam
 * and thousands of in-house forms) is exactly where a curated list fails.
 *
 * This is a deliberate departure from ARCHITECTURE.md §6.5, which asks for
 * explicit host permissions and no blanket `<all_urls>`. The trade is stated
 * plainly because it is a real one: the content script now loads on every page
 * the user visits, including their bank and their webmail.
 *
 * What limits the blast radius instead:
 *
 *  - The script only ever *reads* labels and *writes* profile values. It has no
 *    network access of its own and no code path to a submit button (§6.7).
 *  - Auto-filling is gated on a page actually looking like an identity form —
 *    see `looksLikeIdentityForm` in `entrypoints/content.ts`. A login box or a
 *    search bar is left alone.
 *  - The profile stays encrypted at rest and the key lives in the service
 *    worker, so a compromised page still cannot read it.
 *  - Auto-fill can be turned off entirely in Settings, leaving click-to-fill.
 */
export const ALL_SITES_PATTERN = '*://*/*';

/**
 * Sites worth naming.
 *
 * These get no extra permission — the pattern above already covers them. They
 * are the platforms this extension is *aimed* at, so they are the ones with
 * fixture tests and the ones any future adapter work should target first.
 */
export const PRIORITY_JOB_SITES = [
  'naukri.com',
  'linkedin.com',
  'indeed.com',
  // The user's own current use case; a per-tenant Keka subdomain.
  'keka.com',
] as const;

/** What the manifest declares, for both host_permissions and content scripts. */
export const ATS_MATCH_PATTERNS = [ALL_SITES_PATTERN] as const;

export type AtsMatchPattern = (typeof ATS_MATCH_PATTERNS)[number];
