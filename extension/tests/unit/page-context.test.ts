import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DESCRIPTION_CHARS, readPageContext } from '@/core/scanner/page-context';

/**
 * Page context (ARCHITECTURE.md §3.2, §3.6) — the job title and company Tier 3
 * uses to disambiguate, and the job description the Answer Generator grounds
 * drafts in.
 */

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('readPageContext', () => {
  it('prefers schema.org JobPosting JSON-LD', () => {
    document.head.innerHTML = `
      <meta property="og:title" content="Careers at Acme" />
      <script type="application/ld+json">
        ${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'JobPosting',
          title: 'Staff Frontend Engineer',
          hiringOrganization: { '@type': 'Organization', name: 'Acme Corp' },
          description: '<p>You will <b>build</b> things.</p>',
        })}
      </script>`;

    expect(readPageContext(document)).toEqual({
      jobTitle: 'Staff Frontend Engineer',
      company: 'Acme Corp',
      jobDescription: 'You will build things.',
    });
  });

  it('reads a JobPosting out of an @graph wrapper', () => {
    document.head.innerHTML = `
      <script type="application/ld+json">
        ${JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'WebSite', name: 'Acme' },
            { '@type': 'JobPosting', title: 'Data Engineer' },
          ],
        })}
      </script>`;

    expect(readPageContext(document).jobTitle).toBe('Data Engineer');
  });

  it('ignores malformed JSON-LD instead of throwing', () => {
    document.head.innerHTML = `
      <script type="application/ld+json">{ not json at all }</script>
      <meta property="og:title" content="Backend Engineer" />`;

    expect(() => readPageContext(document)).not.toThrow();
    expect(readPageContext(document).jobTitle).toBe('Backend Engineer');
  });

  it('falls back to Open Graph, then the DOM', () => {
    document.head.innerHTML = `<meta property="og:site_name" content="Globex" />`;
    document.body.innerHTML = `<h1>Principal Engineer</h1>`;

    const context = readPageContext(document);
    expect(context.company).toBe('Globex');
    expect(context.jobTitle).toBe('Principal Engineer');
  });

  it('caps the description — this is prompt input, not a document store', () => {
    document.head.innerHTML = `
      <script type="application/ld+json">
        ${JSON.stringify({ '@type': 'JobPosting', description: 'x'.repeat(50_000) })}
      </script>`;

    const { jobDescription } = readPageContext(document);
    expect(jobDescription!.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });

  it('returns an empty context on a page with nothing to read', () => {
    document.body.innerHTML = '<div>hello</div>';
    expect(readPageContext(document)).toEqual({});
  });
});
