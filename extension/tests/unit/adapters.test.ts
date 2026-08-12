import { beforeEach, describe, expect, it } from 'vitest';
import { isCanonicalKey } from '@autofill/core';
import { ADAPTERS, findAdapter, resolveAdapterMappings } from '@/adapters';
import { scanRoot } from '@/core/scanner';

/**
 * Registry integrity across all six shipped platforms (ARCHITECTURE.md §5).
 *
 * Seven adapters' worth of hand-written CSS selectors is exactly the kind of
 * surface where a typo hides until someone opens that one job board. These
 * tests are cheap and catch all of it at build time.
 */

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('adapter registry', () => {
  it('ships the six platforms §5 lists for v1', () => {
    expect(ADAPTERS.map((adapter) => adapter.name)).toEqual([
      'greenhouse',
      'lever',
      'ashby',
      'smartrecruiters',
      'workday',
      'icims',
      'taleo',
    ]);
  });

  it('gives every adapter a unique name', () => {
    const names = ADAPTERS.map((adapter) => adapter.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(ADAPTERS.map((adapter) => [adapter.name, adapter] as const))(
    '%s uses only valid CSS selectors',
    (_name, adapter) => {
      const selectors = [
        ...Object.keys(adapter.fieldMap ?? {}),
        ...Object.values(adapter.comboboxStrategy ?? {}).filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
        ...(adapter.repeatingSections ?? []).flatMap((section) => [
          section.container,
          section.addButton,
          section.rowSelector,
        ]),
        ...(adapter.multiStep ? [adapter.multiStep.nextButton, adapter.multiStep.stepIndicator] : []),
      ];

      for (const selector of selectors) {
        expect(() => document.querySelector(selector), `invalid selector: ${selector}`).not.toThrow();
      }
    },
  );

  it.each(ADAPTERS.map((adapter) => [adapter.name, adapter] as const))(
    '%s maps only to canonical keys',
    (_name, adapter) => {
      for (const key of Object.values(adapter.fieldMap ?? {})) {
        expect(isCanonicalKey(key), `${key} is not a canonical key`).toBe(true);
      }
    },
  );

  it.each(ADAPTERS.map((adapter) => [adapter.name, adapter] as const))(
    '%s does not throw on an unrelated page',
    (_name, adapter) => {
      document.body.innerHTML = '<main><h1>Some unrelated page</h1></main>';
      expect(() => adapter.matches(new URL('https://example.test/'), document)).not.toThrow();
    },
  );
});

describe('adapter matching', () => {
  const cases: Array<[string, string]> = [
    ['https://boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://jobs.lever.co/acme/abc/apply', 'lever'],
    ['https://jobs.eu.lever.co/acme/abc/apply', 'lever'],
    ['https://jobs.ashbyhq.com/acme/abc', 'ashby'],
    ['https://jobs.smartrecruiters.com/acme/1234', 'smartrecruiters'],
    ['https://acme.wd1.myworkdayjobs.com/en-US/careers/job/x', 'workday'],
    ['https://acme.myworkdaysite.com/en-US/careers', 'workday'],
    ['https://careers-acme.icims.com/jobs/1234/apply', 'icims'],
    ['https://acme.taleo.net/careersection/apply', 'taleo'],
  ];

  it.each(cases)('%s → %s', (href, expected) => {
    expect(findAdapter(new URL(href), document)?.name).toBe(expected);
  });

  it('claims nothing on an unknown careers page', () => {
    document.body.innerHTML = '<form><input name="first_name" /></form>';
    expect(findAdapter(new URL('https://careers.unknown.test/apply'), document)).toBeUndefined();
  });
});

describe('selector resolution against real markup', () => {
  it('maps Workday data-automation-id controls', () => {
    document.body.innerHTML = `
      <div data-automation-id="applyFlow">
        <label for="fn">First Name</label>
        <input id="fn" data-automation-id="legalNameSection_firstName" />
        <label for="ln">Last Name</label>
        <input id="ln" data-automation-id="legalNameSection_lastName" />
        <label for="em">Email</label>
        <input id="em" data-automation-id="email" type="email" />
      </div>`;

    const adapter = findAdapter(new URL('https://acme.wd1.myworkdayjobs.com/careers'), document)!;
    const fields = scanRoot(document).fields;
    const mappings = resolveAdapterMappings(adapter, fields, document);

    const keyFor = (label: string) =>
      mappings[fields.find((field) => field.displayLabel === label)?.id ?? ''];

    expect(keyFor('First Name')).toBe('personal.firstName');
    expect(keyFor('Last Name')).toBe('personal.lastName');
    expect(keyFor('Email')).toBe('contact.email');
  });

  it('maps Ashby system fields', () => {
    document.body.innerHTML = `
      <form class="ashby-application-form">
        <label for="n">Name</label><input id="n" name="_systemfield_name" />
        <label for="e">Email</label><input id="e" name="_systemfield_email" />
        <label for="r">Resume</label><input id="r" name="_systemfield_resume" type="file" />
      </form>`;

    const adapter = findAdapter(new URL('https://jobs.ashbyhq.com/acme/x'), document)!;
    const fields = scanRoot(document).fields;
    const mappings = resolveAdapterMappings(adapter, fields, document);

    expect(Object.values(mappings)).toEqual(
      expect.arrayContaining(['personal.fullName', 'contact.email', 'documents.resume']),
    );
  });

  it('survives an adapter whose selectors have all rotted', () => {
    document.body.innerHTML = `<form><input name="totally_different" /></form>`;
    const adapter = findAdapter(new URL('https://jobs.lever.co/acme/x'), document)!;
    // No throw, no bogus mappings — the generic cascade takes over (§11).
    expect(resolveAdapterMappings(adapter, scanRoot(document).fields, document)).toEqual({});
  });
});
