import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyProfile,
  CURRENT_SCHEMA_VERSION,
  PROFILE,
  type CanonicalKey,
  type Profile,
} from '@autofill/core';
import { findAdapter, resolveAdapterMappings } from '@/adapters';
import { runCascade } from '@/core/mapping/cascade';
import { buildFillPlan } from '@/core/mapping/plan';
import { scanRoot } from '@/core/scanner';
import { toDto, type FieldDescriptor } from '@/shared/types';

/**
 * Fixture-based integration — ARCHITECTURE.md §10.
 *
 * Loads saved application markup, runs the real pipeline (scan → adapter →
 * cascade → plan) and asserts the mapping output. This is the regression suite:
 * every mis-mapping found in the wild should land here as a case.
 */

// Vitest runs from the workspace root; `import.meta.url` inside happy-dom is a
// page URL, not a file path.
const fixture = (name: string) =>
  readFileSync(resolve(process.cwd(), 'extension/tests/e2e/fixtures', name), 'utf8');

const PROFILE_FIXTURE: Profile = PROFILE.parse({
  ...createEmptyProfile(CURRENT_SCHEMA_VERSION),
  personal: { firstName: 'Ada', lastName: 'Lovelace', preferredName: 'Ada' },
  contact: {
    email: 'ada@example.com',
    phone: '5550134000',
    phoneCountryCode: '+44',
    address: {
      line1: '12 St James Square',
      city: 'London',
      state: '',
      postalCode: 'SW1Y 4LE',
      country: 'GB',
    },
  },
  links: { linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada' },
  work: [
    {
      company: 'Analytical Engines Ltd',
      title: 'Principal Engineer',
      startDate: '2019-01',
      current: true,
    },
  ],
  workAuth: { authorizedIn: ['GB'], requiresSponsorship: false },
  preferences: { desiredSalary: { amount: 150000, currency: 'GBP', period: 'year' }, willingToRelocate: true },
  documents: { resume: { blobId: 'blob-1', filename: 'ada-lovelace-cv.pdf' } },
  eeo: {
    gender: 'female',
    race: 'decline',
    ethnicity: 'decline',
    veteranStatus: 'decline',
    disabilityStatus: 'decline',
  },
});

async function runPipeline(html: string, href: string, options = { fillEeo: false }) {
  document.body.innerHTML = html;

  const url = new URL(href);
  const adapter = findAdapter(url, document);
  const fields: FieldDescriptor[] = scanRoot(document).fields;
  const adapterMappings = adapter ? resolveAdapterMappings(adapter, fields, document) : {};

  const { mappings } = await runCascade(
    { hostname: url.hostname, fields: fields.map(toDto), adapterMappings },
    { overrides: new Map() },
  );

  const plan = buildFillPlan(fields.map(toDto), mappings, PROFILE_FIXTURE, options);

  const keyByLabel = new Map<string, CanonicalKey>();
  const sourceByLabel = new Map<string, string>();
  for (const mapping of mappings) {
    const field = fields.find((candidate) => candidate.id === mapping.fieldId);
    if (!field) continue;
    if (mapping.target !== 'UNMAPPABLE' && mapping.target !== 'FREE_TEXT') {
      keyByLabel.set(field.displayLabel, mapping.target);
    }
    sourceByLabel.set(field.displayLabel, mapping.source);
  }

  const filledByLabel = new Map<string, string>();
  const instructionByLabel = new Map<string, (typeof plan.instructions)[number]>();
  for (const instruction of plan.instructions) {
    const field = fields.find((candidate) => candidate.id === instruction.fieldId);
    if (!field) continue;
    filledByLabel.set(field.displayLabel, instruction.value.text);
    instructionByLabel.set(field.displayLabel, instruction);
  }

  return { adapter, fields, mappings, plan, keyByLabel, sourceByLabel, filledByLabel, instructionByLabel };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Greenhouse application', () => {
  const html = fixture('greenhouse-application.html');
  const href = 'https://boards.greenhouse.io/acme/jobs/4001';

  it('is claimed by the greenhouse adapter', async () => {
    const { adapter } = await runPipeline(html, href);
    expect(adapter?.name).toBe('greenhouse');
  });

  it('maps the core identity fields through the adapter (Tier 0)', async () => {
    const { keyByLabel, sourceByLabel } = await runPipeline(html, href);

    expect(keyByLabel.get('First Name *')).toBe('personal.firstName');
    expect(keyByLabel.get('Last Name *')).toBe('personal.lastName');
    expect(keyByLabel.get('Email *')).toBe('contact.email');
    expect(keyByLabel.get('Phone')).toBe('contact.phone');
    expect(keyByLabel.get('Resume/CV *')).toBe('documents.resume');
    expect(keyByLabel.get('Cover Letter')).toBe('documents.coverLetter');

    expect(sourceByLabel.get('First Name *')).toBe('adapter');
  });

  it('catches custom questions the adapter does not know about (Tier 1)', async () => {
    const { keyByLabel, sourceByLabel } = await runPipeline(html, href);

    expect(keyByLabel.get('LinkedIn Profile')).toBe('links.linkedin');
    expect(sourceByLabel.get('LinkedIn Profile')).toBe('rule');
    expect(keyByLabel.get('Will you now or in the future require visa sponsorship? *')).toBe(
      'workAuth.requiresSponsorship',
    );
  });

  it('fills real values, correctly shaped for each control', async () => {
    const { filledByLabel } = await runPipeline(html, href);

    expect(filledByLabel.get('First Name *')).toBe('Ada');
    expect(filledByLabel.get('Email *')).toBe('ada@example.com');
    expect(filledByLabel.get('LinkedIn Profile')).toBe('https://linkedin.com/in/ada');
    expect(filledByLabel.get('Resume/CV *')).toBe('ada-lovelace-cv.pdf');
    // A boolean maps onto the Yes/No option set, not onto "true".
    expect(filledByLabel.get('Will you now or in the future require visa sponsorship? *')).toBe('No');
  });

  it('leaves voluntary self-identification alone by default (§4)', async () => {
    const { plan, fields } = await runPipeline(html, href, { fillEeo: false });
    const eeoField = fields.find((field) => field.displayLabel === 'Gender');
    expect(eeoField).toBeDefined();

    const skipped = plan.skipped.find((entry) => entry.fieldId === eeoField?.id);
    expect(skipped?.reason).toBe('eeo-disabled');
    expect(plan.instructions.some((i) => i.key.startsWith('eeo.'))).toBe(false);
  });

  it('fills self-identification only when the user opted in', async () => {
    const { filledByLabel, instructionByLabel } = await runPipeline(html, href, { fillEeo: true });
    expect(filledByLabel.get('Gender')).toBe('Female');

    // Declining is a real answer and must be filled as one. The resolver offers
    // every phrasing sites use so the option matcher can find this board's.
    expect(filledByLabel.get('Veteran Status')).toMatch(/decline/i);
    expect(instructionByLabel.get('Veteran Status')?.value.candidates).toContain(
      "I don't wish to answer",
    );
  });

  it('never treats the submit button as a field', async () => {
    const { fields } = await runPipeline(html, href);
    expect(fields.some((field) => field.displayLabel.toLowerCase().includes('submit'))).toBe(false);
  });

  it('leaves a genuinely open question for the answer generator, not the profile', async () => {
    const { keyByLabel } = await runPipeline(html, href);
    expect(keyByLabel.has('Why do you want to work here?')).toBe(false);
  });

  /**
   * G1 is "fill 90%+ of fields with zero manual typing", but a raw
   * filled ÷ scanned ratio does not measure that. This fixture legitimately
   * skips a cover letter and a website the profile does not carry, and four
   * voluntary questions the user has not opted into. Counting those as misses
   * would make the number meaningless.
   *
   * What the pipeline is actually accountable for is below: every field it
   * declines to fill has a reason it can state, and the only field it fails to
   * *understand* is the free-text essay — which is Tier 3's job (M3) and then
   * the Answer Generator's (M4), neither of which ships yet.
   */
  it('accounts for every field it does not fill (G1/G2)', async () => {
    const { plan, fields } = await runPipeline(html, href);

    expect(plan.instructions).toHaveLength(fields.length - plan.skipped.length);

    const reasons = plan.skipped.map((entry) => entry.reason).sort();
    expect(reasons).toEqual([
      'eeo-disabled',
      'eeo-disabled',
      'eeo-disabled',
      'eeo-disabled',
      'no-profile-data',
      'no-profile-data',
      'unmapped',
    ]);
  });

  it('leaves exactly one field unmapped, and it is the one Tier 3 exists for', async () => {
    const { plan, fields } = await runPipeline(html, href);

    const unmapped = plan.skipped.filter((entry) => entry.reason === 'unmapped');
    expect(unmapped).toHaveLength(1);

    const field = fields.find((candidate) => candidate.id === unmapped[0]?.fieldId);
    expect(field?.displayLabel).toBe('Why do you want to work here?');
  });

  it('fills every structured field the profile can supply', async () => {
    const { filledByLabel } = await runPipeline(html, href);

    // Everything the profile holds and this board asks for, with nothing typed.
    expect([...filledByLabel.keys()].sort()).toEqual([
      'Email *',
      'First Name *',
      'Last Name *',
      'LinkedIn Profile',
      'Location (City)',
      'Phone',
      'Resume/CV *',
      'Will you now or in the future require visa sponsorship? *',
    ]);
  });
});

describe('Lever application', () => {
  const html = fixture('lever-application.html');
  const href = 'https://jobs.lever.co/acme/00000000-0000-0000-0000-000000000000/apply';

  it('is claimed by the lever adapter', async () => {
    const { adapter } = await runPipeline(html, href);
    expect(adapter?.name).toBe('lever');
  });

  it('maps Lever’s flat name attributes through the adapter', async () => {
    const { keyByLabel } = await runPipeline(html, href);

    expect(keyByLabel.get('Full name✱')).toBe('personal.fullName');
    expect(keyByLabel.get('Email✱')).toBe('contact.email');
    expect(keyByLabel.get('Current company')).toBe('work[].company');
    expect(keyByLabel.get('LinkedIn URL')).toBe('links.linkedin');
    expect(keyByLabel.get('GitHub URL')).toBe('links.github');
    expect(keyByLabel.get('Resume/CV✱')).toBe('documents.resume');
  });

  it('detects the location typeahead as a combobox rather than a text input', async () => {
    const { fields } = await runPipeline(html, href);
    const location = fields.find((field) => field.name === 'location');
    expect(location?.kind).toBe('combobox');
  });

  it('maps custom card questions through the rules', async () => {
    const { keyByLabel } = await runPipeline(html, href);
    expect(keyByLabel.get('What is your desired salary?')).toBe('preferences.desiredSalary.amount');
    expect(keyByLabel.get('Are you willing to relocate?')).toBe('preferences.willingToRelocate');
  });

  it('derives the full name from the profile parts', async () => {
    const { filledByLabel } = await runPipeline(html, href);
    expect(filledByLabel.get('Full name✱')).toBe('Ada Lovelace');
  });

  it('picks the right option for a Yes/No select', async () => {
    const { filledByLabel } = await runPipeline(html, href);
    expect(filledByLabel.get('Are you willing to relocate?')).toBe('Yes');
  });
});

/**
 * The case the product actually lives or dies on (ARCHITECTURE.md G2 — "handle
 * unknown/custom forms gracefully").
 *
 * No adapter, no stable ids, no `autocomplete`, and labels marked required with
 * a decorated asterisk. This is the shape used by Keka, Zoho Recruit,
 * Darwinbox, Freshteam and most in-house career pages.
 */
describe('a generic form on an unknown ATS', () => {
  const html = fixture('generic-application.html');
  const href = 'https://smartdocs.keka.com/careers/applyjob/136647';

  it('is claimed by no adapter — brand markers must not over-match', async () => {
    const { adapter } = await runPipeline(html, href);
    // `.application-form` is a class name half the web uses. An adapter
    // claiming this page would map another ATS's selectors onto it.
    expect(adapter).toBeUndefined();
  });

  it('reads a label that a required-asterisk splits across nodes', async () => {
    const { keyByLabel } = await runPipeline(html, href);

    // <span>First Name<em>*</em></span> — taking the last text node yields "*"
    // and silently loses every required field, i.e. the ones that matter most.
    expect(keyByLabel.get('First Name*')).toBe('personal.firstName');
    expect(keyByLabel.get('Last Name*')).toBe('personal.lastName');
    expect(keyByLabel.get('Email Address*')).toBe('contact.email');
    expect(keyByLabel.get('Mobile Number*')).toBe('contact.phone');
    expect(keyByLabel.get('Upload Resume*')).toBe('documents.resume');
  });

  it('maps the vocabulary non-US boards actually use', async () => {
    const { keyByLabel } = await runPipeline(html, href);

    // A city, not a postal address — "Pune" is the answer these forms want.
    expect(keyByLabel.get('Current Location')).toBe('contact.address.city');
    expect(keyByLabel.get('Current Company')).toBe('work[].company');
    expect(keyByLabel.get('Current Designation')).toBe('work[].title');
    expect(keyByLabel.get('Total Experience (Years)')).toBe('work.totalYears');
    expect(keyByLabel.get('Expected CTC')).toBe('preferences.desiredSalary.amount');
    expect(keyByLabel.get('Notice Period')).toBe('preferences.noticePeriod');
    expect(keyByLabel.get('Highest Qualification')).toBe('education[].degree');
  });

  it('maps every field on the form with rules alone — no adapter, no LLM', async () => {
    const { mappings, fields } = await runPipeline(html, href);
    const unmapped = mappings.filter((mapping) => mapping.target === 'UNMAPPABLE');

    expect(fields).toHaveLength(14);
    expect(unmapped).toEqual([]);
  });

  it('derives total experience from the work history', async () => {
    const { filledByLabel } = await runPipeline(html, href);
    // The fixture profile starts in 2019 and is current, so this is a number
    // rather than a blank — and it was never typed in twice.
    expect(Number(filledByLabel.get('Total Experience (Years)'))).toBeGreaterThanOrEqual(0);
  });
});

describe('an unknown ATS still works (G2)', () => {
  it('falls back to the generic cascade with no adapter', async () => {
    const html = `
      <form>
        <label for="a">First name</label><input id="a" />
        <label for="b">Last name</label><input id="b" />
        <label for="c">Email address</label><input id="c" type="email" />
        <label for="d">LinkedIn</label><input id="d" />
        <label for="e">What is your favourite compiler?</label><input id="e" />
      </form>`;

    const { adapter, keyByLabel, plan } = await runPipeline(html, 'https://careers.unknown-ats.test/apply');

    expect(adapter).toBeUndefined();
    expect(keyByLabel.get('First name')).toBe('personal.firstName');
    expect(keyByLabel.get('Email address')).toBe('contact.email');
    expect(keyByLabel.get('LinkedIn')).toBe('links.linkedin');
    // The novel question degrades to ⬜ skipped rather than being guessed at.
    expect(plan.skipped.some((entry) => entry.reason === 'unmapped')).toBe(true);
  });
});
