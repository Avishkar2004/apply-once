/**
 * The explicit host allow-list.
 *
 * ARCHITECTURE.md §6.5: "Least-privilege manifest. `activeTab` + explicit host
 * permissions for known ATS domains. No blanket `<all_urls>`."
 *
 * One list, consumed by both `wxt.config.ts` (host_permissions) and
 * `entrypoints/content.ts` (content-script matches), so the two can never drift.
 *
 * Adding an ATS means adding its pattern here *and* shipping an adapter or
 * relying on the generic cascade — the pipeline works either way (§5).
 */
export const ATS_MATCH_PATTERNS = [
  // Greenhouse — boards.greenhouse.io, job-boards.greenhouse.io, embedded boards
  'https://*.greenhouse.io/*',
  // Lever — jobs.lever.co, jobs.eu.lever.co
  'https://*.lever.co/*',
  // Ashby
  'https://jobs.ashbyhq.com/*',
  // SmartRecruiters
  'https://*.smartrecruiters.com/*',
  // Workday — per-tenant subdomains
  'https://*.myworkdayjobs.com/*',
  'https://*.myworkdaysite.com/*',
  // iCIMS
  'https://*.icims.com/*',
  // Oracle Taleo
  'https://*.taleo.net/*',
] as const;

export type AtsMatchPattern = (typeof ATS_MATCH_PATTERNS)[number];
