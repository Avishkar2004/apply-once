import { squashWhitespace } from '@autofill/core';
import type { PageContext } from '@/shared/types';
import { createLogger } from '@/shared/logger';

const log = createLogger('email/detect');

/**
 * Finding the address an application should go to (ARCHITECTURE.md §3.7).
 *
 * Plenty of postings have no form at all — a paragraph ending "send your CV to
 * careers@…" is the whole application process. Those pages were a dead end: the
 * scanner found nothing to fill and the panel correctly said so, which is not
 * the same as being useful.
 *
 * The hard part is not finding an email address on a web page; it is finding the
 * *right* one. Every page has several, and most of them are wrong: a privacy
 * contact in the footer, a support desk in the header, an unsubscribe link. So
 * candidates are ranked rather than taken first-found:
 *
 *   1. a `mailto:` inside the job description outranks everything;
 *   2. a `mailto:` anywhere else outranks plain text;
 *   3. an address whose local part is about hiring — careers@, jobs@, hr@ —
 *      gains on one that is not;
 *   4. page furniture (footer, nav, header) loses to body content;
 *   5. addresses that are definitionally not for applications — privacy@,
 *      support@, no-reply@ — are dropped, not demoted.
 *
 * The top candidate is a proposal, never a decision: the alternatives travel
 * with it and the review panel lets the user pick a different one before
 * anything is composed.
 */

export type EmailCandidateKind = 'mailto' | 'text';

/** Where on the page it was found. Furniture is worth less than body copy. */
export type EmailRegion = 'body' | 'page' | 'footer';

export interface EmailCandidate {
  address: string;
  kind: EmailCandidateKind;
  region: EmailRegion;
  /** 0..1 — how likely this is where applications are read. */
  score: number;
  /** Link text or surrounding sentence, so the panel can show why. */
  context?: string;
}

export interface EmailDetection {
  best: EmailCandidate;
  /** Ranked, best first, excluding `best`. */
  alternatives: EmailCandidate[];
}

/**
 * Below this many form controls, a page is a job *listing* rather than an
 * application form, and the email route is the only one there is. At or above
 * it, the form is how you apply and the offer stays out of the way — the user
 * can still ask for it explicitly.
 */
export const EMAIL_APPLY_FIELD_CEILING = 3;

/** More than a handful of choices is not a choice; it is a list to read. */
const MAX_CANDIDATES = 5;

/** A whole careers page of text is not worth scanning for an address. */
const MAX_TEXT_CHARS = 40_000;

/**
 * Deliberately not RFC 5322. This has to reject far more than it accepts —
 * "2x@3x.png" in a srcset and "@media" in an inline style are both "addresses"
 * to a permissive pattern.
 */
const ADDRESS = /[A-Z0-9](?:[A-Z0-9._%+-]{0,62}[A-Z0-9])?@(?:[A-Z0-9-]+\.)+[A-Z]{2,24}/gi;

/**
 * Addresses that are never where an application is read. Dropped outright: a
 * demoted privacy@ still shows up as an alternative, and offering to email an
 * application to a data-protection officer is worse than offering nothing.
 */
const NEVER_APPLICATIONS =
  /^(privacy|dpo|gdpr|legal|compliance|abuse|security|support|help|helpdesk|service|no-?reply|do-?not-?reply|bounce|mailer-daemon|postmaster|webmaster|unsubscribe|newsletter|subscribe|billing|invoices?|accounts?|payments?|sales|marketing|press|media|partnerships?)([+.-]|$)/i;

/** A local part or nearby wording that says "this is where applications go". */
const HIRING_WORDS = /\b(career|careers|job|jobs|hiring|hire|recruit\w*|talent|apply|application|resume|cv|hr|people|vacanc\w+)\b/i;

/** Page furniture. Anything inside one of these is not the job description. */
const FURNITURE_SELECTOR =
  'footer, nav, header, aside, [role="contentinfo"], [role="banner"], [role="navigation"], [class*="footer" i], [id*="footer" i], [class*="cookie" i], [class*="nav" i]';

/** The same regions `page-context.ts` reads a job description out of. */
const BODY_SELECTOR =
  '[class*="job-description"], [class*="posting-description"], [id*="job-description"], [class*="job" i][class*="detail" i], article, main';

/** A file name that happens to contain an "@" — retina assets, mostly. */
const LOOKS_LIKE_ASSET = /\.(png|jpe?g|gif|svg|webp|avif|css|js|json|woff2?)$/i;

const KIND_SCORE: Record<EmailCandidateKind, number> = { mailto: 0.55, text: 0.35 };
const REGION_SCORE: Record<EmailRegion, number> = { body: 0.3, page: 0.1, footer: 0 };
const HIRING_BONUS = 0.15;

export interface DetectOptions {
  /**
   * What the scanner already read off the page (§3.2). Its job description is
   * the strongest evidence available for "this text is the posting, not the
   * site's chrome", and it costs nothing here because it is already computed.
   */
  page?: PageContext;
}

/**
 * The best address to apply to on this page, with the runners-up.
 *
 * Returns `undefined` when there is nothing credible — the caller changes
 * nothing on the page in that case (§3.7).
 */
export function detectApplicationEmail(
  doc: Document = document,
  options: DetectOptions = {},
): EmailDetection | undefined {
  const ranked = rankEmailCandidates(doc, options);
  if (ranked.length === 0) return undefined;

  const [best, ...alternatives] = ranked;
  return { best: best!, alternatives: alternatives.slice(0, MAX_CANDIDATES - 1) };
}

/** Every credible address on the page, best first. Exported for the tests. */
export function rankEmailCandidates(
  doc: Document = document,
  options: DetectOptions = {},
): EmailCandidate[] {
  const found = new Map<string, EmailCandidate>();

  // 1. `mailto:` links. An explicit link is a stronger statement of intent than
  //    an address that merely appears in prose.
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') ?? '';
    if (!/^mailto:/i.test(href)) continue;

    const address = normalise(href.slice('mailto:'.length).split('?')[0] ?? '');
    if (!address) continue;

    offer(found, {
      address,
      kind: 'mailto',
      region: regionOf(link),
      ...(contextOf(link) ? { context: contextOf(link) } : {}),
    });
  }

  // 2. Plain text in the job description the scanner already extracted. Treated
  //    as body copy by definition — that is what `readPageContext` selected for.
  for (const address of addressesIn(options.page?.jobDescription ?? '')) {
    offer(found, { address, kind: 'text', region: 'body' });
  }

  // 3. Plain text elsewhere in the document, classified by where it sits. This
  //    is what catches "Email your CV to …" in a paragraph the description
  //    extractor missed.
  for (const { address, region, context } of addressesInDom(doc)) {
    offer(found, { address, kind: 'text', region, ...(context ? { context } : {}) });
  }

  const ranked = [...found.values()]
    .map((candidate) => ({ ...candidate, score: scoreOf(candidate) }))
    // Stable sort: equal scores keep document order, which is the only
    // tie-break that is not arbitrary.
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  log.debug(`${ranked.length} email candidate(s)`, ranked[0]?.address);
  return ranked;
}

/**
 * Keep the strongest sighting of each address.
 *
 * The same careers@ often appears both as a footer link and in the posting
 * text; it is one address and should be scored on its best appearance, not
 * listed twice.
 */
function offer(found: Map<string, EmailCandidate>, candidate: Omit<EmailCandidate, 'score'>): void {
  if (!isPlausible(candidate.address)) return;

  const scored: EmailCandidate = { ...candidate, score: scoreOf(candidate) };
  const existing = found.get(candidate.address);
  if (!existing || scored.score > existing.score) found.set(candidate.address, scored);
}

function scoreOf(candidate: Omit<EmailCandidate, 'score'>): number {
  const local = candidate.address.split('@')[0] ?? '';
  const hiring = HIRING_WORDS.test(local) || HIRING_WORDS.test(candidate.context ?? '');
  const score =
    KIND_SCORE[candidate.kind] + REGION_SCORE[candidate.region] + (hiring ? HIRING_BONUS : 0);
  return Math.min(score, 1);
}

/** Reject what is not an address at all, and what is never an application inbox. */
export function isPlausible(address: string): boolean {
  if (!address.includes('@')) return false;
  if (LOOKS_LIKE_ASSET.test(address)) return false;

  const [local, domain] = address.split('@');
  if (!local || !domain) return false;
  if (NEVER_APPLICATIONS.test(local)) return false;
  // `example@2x.png` is caught above; `a@b` and `x@.com` here.
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,24}$/i.test(domain)) return false;
  return true;
}

function normalise(raw: string): string {
  // Addresses in prose pick up trailing punctuation, and `mailto:` targets are
  // percent-encoded often enough to matter.
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // A stray `%` in a mailto is the page's problem, not ours.
  }
  return value.replace(/^[<("']+|[>)"'.,;:]+$/g, '').toLowerCase();
}

function addressesIn(text: string): string[] {
  if (!text) return [];
  const matches = text.slice(0, MAX_TEXT_CHARS).match(ADDRESS) ?? [];
  return matches.map((match) => normalise(match));
}

/**
 * Walk the document's text once, remembering which region each address sat in.
 *
 * A `TreeWalker` rather than `body.textContent`: the region is the whole point,
 * and flattening the document to a single string throws it away.
 */
function addressesInDom(
  doc: Document,
): Array<{ address: string; region: EmailRegion; context?: string }> {
  const body = doc.body;
  if (!body) return [];

  const out: Array<{ address: string; region: EmailRegion; context?: string }> = [];
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let budget = MAX_TEXT_CHARS;

  for (let node = walker.nextNode(); node && budget > 0; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    if (!text.includes('@')) continue;

    const parent = node.parentElement;
    if (!parent || /^(script|style|noscript|template)$/i.test(parent.tagName)) continue;

    budget -= text.length;
    const region = regionOf(parent);
    const context = squashWhitespace(text).slice(0, 160) || undefined;

    for (const address of addressesIn(text)) {
      out.push({ address, region, ...(context ? { context } : {}) });
    }
  }

  return out;
}

/** Body copy, page furniture, or neither. */
export function regionOf(element: Element): EmailRegion {
  if (element.closest(FURNITURE_SELECTOR)) return 'footer';
  if (element.closest(BODY_SELECTOR)) return 'body';
  return 'page';
}

/**
 * The link's own text, not the paragraph around it.
 *
 * Granularity is the whole point: context feeds the hiring bonus, and a sentence
 * reading "questions to Ada, applications to recruitment@" mentions applications
 * for *both* links. Widening to the parent gave every address in that sentence
 * the same bonus and left the ranking to document order. Only an anchor with no
 * text of its own — an icon link — borrows its parent's.
 */
function contextOf(link: Element): string | undefined {
  const own = squashWhitespace(link.textContent ?? '');
  if (own) return own.slice(0, 160);
  const around = squashWhitespace(link.parentElement?.textContent ?? '');
  return around ? around.slice(0, 160) : undefined;
}

/**
 * Should the panel offer this unasked?
 *
 * A page carrying a real application form is applied to *through the form* — the
 * email route is the fallback for postings that have none, not a second front
 * door on every application. The user can still ask for it explicitly on any
 * page; this only governs the automatic offer.
 */
export function shouldOfferEmailApply(
  detection: EmailDetection | undefined,
  fillableFields: number,
): boolean {
  return detection !== undefined && fillableFields < EMAIL_APPLY_FIELD_CEILING;
}
