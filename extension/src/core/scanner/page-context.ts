import { squashWhitespace, truncate } from '@autofill/core';
import type { PageContext } from '@/shared/types';
import { createLogger } from '@/shared/logger';

const log = createLogger('scanner/page-context');

export type { PageContext };

/**
 * What this page is an application *for*.
 *
 * Tier 3 gets the job title and company as disambiguating context
 * (ARCHITECTURE.md §3.2); the Answer Generator additionally gets the job
 * description scraped from the page (§3.6).
 *
 * Read in three passes, most trustworthy first: schema.org JobPosting JSON-LD,
 * then Open Graph meta tags, then the DOM. Every ATS worth supporting emits
 * JSON-LD because it is what job aggregators index.
 */

/** Enough for the model to ground an answer; far short of a whole careers page. */
export const MAX_DESCRIPTION_CHARS = 6000;

export function readPageContext(doc: Document = document): PageContext {
  const context: PageContext = {};

  merge(context, fromJsonLd(doc));
  merge(context, fromMetaTags(doc));
  merge(context, fromDom(doc));

  if (context.jobDescription) {
    context.jobDescription = truncate(context.jobDescription, MAX_DESCRIPTION_CHARS);
  }
  return context;
}

/** First writer wins — passes run most-trustworthy first. */
function merge(target: PageContext, source: PageContext): void {
  target.jobTitle ??= source.jobTitle;
  target.company ??= source.company;
  target.jobDescription ??= source.jobDescription;
}

function fromJsonLd(doc: Document): PageContext {
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? '');
    } catch {
      continue; // A malformed blob on the page is not our problem to report.
    }

    for (const node of flattenJsonLd(parsed)) {
      if (node['@type'] !== 'JobPosting') continue;
      const hiring = node.hiringOrganization;
      return {
        ...(typeof node.title === 'string' ? { jobTitle: squashWhitespace(node.title) } : {}),
        ...(hiring && typeof hiring.name === 'string'
          ? { company: squashWhitespace(hiring.name) }
          : {}),
        ...(typeof node.description === 'string'
          ? { jobDescription: stripHtml(node.description) }
          : {}),
      };
    }
  }
  return {};
}

interface JsonLdNode {
  '@type'?: unknown;
  title?: unknown;
  description?: unknown;
  hiringOrganization?: { name?: unknown };
}

/** JSON-LD is legitimately an object, an array, or an `@graph` wrapper. */
function flattenJsonLd(value: unknown): JsonLdNode[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as JsonLdNode & { '@graph'?: unknown };
  return node['@graph'] ? [node, ...flattenJsonLd(node['@graph'])] : [node];
}

function fromMetaTags(doc: Document): PageContext {
  const meta = (selector: string): string | undefined => {
    const content = doc.querySelector(selector)?.getAttribute('content');
    return content ? squashWhitespace(content) : undefined;
  };

  return {
    ...pick('jobTitle', meta('meta[property="og:title"]') ?? meta('meta[name="title"]')),
    ...pick('company', meta('meta[property="og:site_name"]')),
    ...pick(
      'jobDescription',
      meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    ),
  };
}

function fromDom(doc: Document): PageContext {
  const heading = doc.querySelector('h1, [class*="posting-headline"] h2, [class*="app-title"]');
  const title = heading?.textContent ? squashWhitespace(heading.textContent) : undefined;

  const body = doc.querySelector(
    '[class*="job-description"], [class*="posting-description"], [id*="job-description"], article, main',
  );
  const description = body?.textContent ? squashWhitespace(body.textContent) : undefined;

  const context = {
    ...pick('jobTitle', title),
    ...pick('jobDescription', description && description.length > 200 ? description : undefined),
  };
  log.debug('page context from DOM', Object.keys(context));
  return context;
}

function pick<K extends keyof PageContext>(key: K, value: string | undefined): Partial<PageContext> {
  return value ? ({ [key]: value } as Partial<PageContext>) : {};
}

/** JSON-LD descriptions routinely carry escaped HTML. */
function stripHtml(input: string): string {
  return squashWhitespace(input.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' '));
}
