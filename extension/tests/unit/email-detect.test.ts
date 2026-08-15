import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMAIL_APPLY_FIELD_CEILING,
  detectApplicationEmail,
  isPlausible,
  rankEmailCandidates,
  shouldOfferEmailApply,
} from '@/core/email/detect';
import { readPageContext } from '@/core/scanner/page-context';

/**
 * Which address an application should go to (ARCHITECTURE.md §3.7).
 *
 * Finding *an* email address on a web page is trivial and useless. Every page
 * has several — a privacy contact, a support desk, an unsubscribe link — and
 * emailing a CV to the data-protection officer is worse than doing nothing. So
 * the unit under test is the *ranking*, not the extraction.
 */

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

/** A posting shaped like the real thing: body copy, and a footer full of noise. */
function posting(body: string, footer = ''): void {
  document.body.innerHTML = `
    <header><a href="mailto:support@acme.example">Contact support</a></header>
    <main>
      <h1>Backend Engineer</h1>
      <div class="job-description">${body}</div>
    </main>
    <footer>
      ${footer}
      <a href="mailto:privacy@acme.example">Privacy</a>
      <a href="mailto:unsubscribe@acme.example">Unsubscribe</a>
    </footer>`;
}

describe('ranking candidates', () => {
  it('prefers a mailto: in the job body over a careers@ in the footer', () => {
    posting(
      'Send your application to <a href="mailto:hiring-team@acme.example">hiring-team@acme.example</a>.',
      '<a href="mailto:careers@acme.example">Careers</a>',
    );

    const detection = detectApplicationEmail(document);
    expect(detection?.best.address).toBe('hiring-team@acme.example');
    expect(detection?.best.kind).toBe('mailto');
    expect(detection?.best.region).toBe('body');
    // The footer address is still offered, just not chosen.
    expect(detection?.alternatives.map((c) => c.address)).toContain('careers@acme.example');
  });

  it('prefers a careers@ in the footer over nothing else usable', () => {
    posting('Apply through our careers page.', '<a href="mailto:careers@acme.example">Careers</a>');

    expect(detectApplicationEmail(document)?.best.address).toBe('careers@acme.example');
  });

  it('drops privacy@, support@ and unsubscribe@ rather than ranking them low', () => {
    posting('Email <a href="mailto:jobs@acme.example">jobs@acme.example</a> to apply.');

    const addresses = rankEmailCandidates(document).map((candidate) => candidate.address);
    expect(addresses).toContain('jobs@acme.example');
    expect(addresses).not.toContain('privacy@acme.example');
    expect(addresses).not.toContain('support@acme.example');
    expect(addresses).not.toContain('unsubscribe@acme.example');
  });

  it('finds a plain-text address in the job description', () => {
    posting('No form here — email your CV to talent@acme.example and we will reply.');

    const detection = detectApplicationEmail(document, { page: readPageContext(document) });
    expect(detection?.best.address).toBe('talent@acme.example');
    expect(detection?.best.kind).toBe('text');
  });

  it('ranks a hiring-flavoured local part above a neutral one in the same place', () => {
    posting(
      'Questions to <a href="mailto:ada@acme.example">Ada</a>, applications to ' +
        '<a href="mailto:recruitment@acme.example">recruitment@acme.example</a>.',
    );

    expect(detectApplicationEmail(document)?.best.address).toBe('recruitment@acme.example');
  });

  it('lists each address once, scored on its best appearance', () => {
    posting(
      'Apply to <a href="mailto:careers@acme.example">careers@acme.example</a>.',
      '<a href="mailto:careers@acme.example">Careers</a>',
    );

    const ranked = rankEmailCandidates(document);
    expect(ranked.filter((c) => c.address === 'careers@acme.example')).toHaveLength(1);
    expect(ranked[0]?.region).toBe('body');
  });

  it('reports nothing on a page with no address', () => {
    document.body.innerHTML = `
      <main><div class="job-description">Apply through the portal.</div></main>`;

    expect(detectApplicationEmail(document)).toBeUndefined();
  });

  it('is not fooled by a retina asset name', () => {
    document.body.innerHTML = `<main><div class="job-description">logo@2x.png</div></main>`;
    expect(detectApplicationEmail(document)).toBeUndefined();
  });
});

describe('isPlausible', () => {
  it('accepts an ordinary address', () => {
    expect(isPlausible('careers@acme.example')).toBe(true);
  });

  it('rejects the addresses an application is never read at', () => {
    for (const address of [
      'privacy@acme.example',
      'no-reply@acme.example',
      'legal@acme.example',
      'billing@acme.example',
      'press@acme.example',
    ]) {
      expect(isPlausible(address)).toBe(false);
    }
  });

  it('rejects things that only look like addresses', () => {
    expect(isPlausible('sprite@2x.svg')).toBe(false);
    expect(isPlausible('ada@localhost')).toBe(false);
    expect(isPlausible('nothing-here')).toBe(false);
  });
});

/**
 * The form wins.
 *
 * A page with a real application form is applied to *through* the form. Offering
 * an email route beside it turns one clear action into two, and the email one is
 * strictly worse — it has no structured fields and no attachment.
 */
describe('when the offer is made unasked', () => {
  it('stays out of the way on a page that has both a form and an address', () => {
    posting('Or email <a href="mailto:careers@acme.example">careers@acme.example</a>.');

    const detection = detectApplicationEmail(document);
    expect(detection).toBeDefined();
    expect(shouldOfferEmailApply(detection, 14)).toBe(false);
  });

  it('offers on a posting with no form at all', () => {
    posting('Email <a href="mailto:careers@acme.example">careers@acme.example</a> to apply.');

    expect(shouldOfferEmailApply(detectApplicationEmail(document), 0)).toBe(true);
  });

  it('offers nothing when there is no address, however empty the page', () => {
    document.body.innerHTML = '<main><p>Apply through the portal.</p></main>';
    expect(shouldOfferEmailApply(detectApplicationEmail(document), 0)).toBe(false);
  });

  it('treats a couple of stray controls as not-an-application-form', () => {
    // A search box and a newsletter input are not a form to apply through.
    expect(EMAIL_APPLY_FIELD_CEILING).toBe(3);
  });
});
