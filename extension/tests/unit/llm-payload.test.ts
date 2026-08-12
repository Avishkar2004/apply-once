import { describe, expect, it } from 'vitest';
import {
  createEmptyProfile,
  CURRENT_SCHEMA_VERSION,
  isCanonicalKey,
  PROFILE,
  type Profile,
} from '@autofill/core';
import { MAX_FIELDS_PER_CALL, toMappableField } from '@/llm/field-mapping';
import { applyResumeExtraction } from '@/llm/resume-parse';
import type { FieldDescriptorDto } from '@/shared/types';

/**
 * ARCHITECTURE.md §6.3 is the rule under test here:
 *
 *   "PII never reaches the LLM for field mapping. Tier 3 sends field *labels
 *    and options* — never values."
 *
 * The implementation enforces it by building its payload from an explicit
 * allowlist. These tests are what stop that allowlist quietly growing.
 */

const field = (extra: Partial<FieldDescriptorDto> = {}): FieldDescriptorDto => ({
  id: 'f1',
  signature: 'sig-1',
  kind: 'text',
  labelBlob: 'first name',
  displayLabel: 'First name',
  required: true,
  ...extra,
});

describe('Tier 3 request payload (§6.3)', () => {
  it('sends labels, kind, section and options — and nothing else', () => {
    const payload = toMappableField(
      field({
        sectionHeading: 'Personal details',
        maxLength: 80,
        options: [{ value: 'us', text: 'United States' }],
        autocomplete: 'given-name',
        name: 'first_name',
        inputType: 'text',
        placeholder: 'Jane',
        pattern: '[A-Za-z]+',
        rowIndex: 2,
      }),
    );

    expect(Object.keys(payload).sort()).toEqual([
      'id',
      'kind',
      'label',
      'maxLength',
      'options',
      'required',
      'section',
    ]);
  });

  it('does not forward a descriptor field added later without a decision', () => {
    // Simulates someone adding a property to FieldDescriptorDto. The payload
    // must not grow just because the descriptor did.
    const payload = toMappableField(
      field({ placeholder: 'ada@example.com' } as Partial<FieldDescriptorDto>),
    );
    expect(JSON.stringify(payload)).not.toContain('ada@example.com');
  });

  it('carries no profile values under any key', () => {
    const payload = toMappableField(field({ options: [{ value: 'yes', text: 'Yes' }] }));
    const serialised = JSON.stringify(payload).toLowerCase();

    for (const secret of ['ada', 'lovelace', 'ada@example.com', '5550134000', 'sw1y']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('caps option lists rather than shipping a country dropdown in full', () => {
    const options = Array.from({ length: 300 }, (_, index) => ({
      value: `c${index}`,
      text: `Country ${index}`,
    }));
    expect(toMappableField(field({ options })).options).toHaveLength(25);
  });

  it('bounds the batch so one call cannot balloon (§11 unit economics)', () => {
    expect(MAX_FIELDS_PER_CALL).toBeLessThanOrEqual(100);
  });
});

describe('résumé extraction merge (M6)', () => {
  const base: Profile = PROFILE.parse({
    ...createEmptyProfile(CURRENT_SCHEMA_VERSION),
    personal: { firstName: 'Ada', lastName: '' },
    contact: {
      email: 'typed-by-hand@example.com',
      phone: '',
      address: { line1: '', city: '', state: '', postalCode: '', country: '' },
    },
    skills: ['TypeScript'],
    work: [{ company: 'Analytical Engines', title: 'Principal Engineer', current: true }],
  });

  const extraction = {
    firstName: 'Augusta',
    lastName: 'Lovelace',
    email: 'from-resume@example.com',
    phone: '5550134000',
    city: 'London',
    state: '',
    postalCode: '',
    country: 'GB',
    linkedin: 'https://linkedin.com/in/ada',
    github: '',
    website: '',
    skills: ['TypeScript', 'Rust'],
    work: [
      {
        company: 'Analytical Engines',
        title: 'Principal Engineer',
        location: '',
        startDate: '',
        endDate: '',
        current: true,
        description: '',
      },
      {
        company: 'Difference Engine Co',
        title: 'Engineer',
        location: 'London',
        startDate: '2019-01',
        endDate: '2021-06',
        current: false,
        description: 'Built things.',
      },
    ],
    education: [
      {
        school: 'Cambridge',
        degree: 'BA',
        fieldOfStudy: 'Mathematics',
        startDate: '2015-09',
        endDate: '2018-06',
        gpa: '',
      },
    ],
  };

  it('never overwrites something the user already typed', () => {
    const merged = applyResumeExtraction(base, extraction);
    expect(merged.personal.firstName).toBe('Ada');
    expect(merged.contact.email).toBe('typed-by-hand@example.com');
  });

  it('fills fields the user left blank', () => {
    const merged = applyResumeExtraction(base, extraction);
    expect(merged.personal.lastName).toBe('Lovelace');
    expect(merged.contact.phone).toBe('5550134000');
    expect(merged.contact.address.city).toBe('London');
    expect(merged.links.linkedin).toBe('https://linkedin.com/in/ada');
  });

  it('does not duplicate a role that is already there', () => {
    const merged = applyResumeExtraction(base, extraction);
    expect(merged.work).toHaveLength(2);
    expect(merged.work.map((entry) => entry.company)).toEqual([
      'Analytical Engines',
      'Difference Engine Co',
    ]);
  });

  it('merges skills without duplicating them', () => {
    expect(applyResumeExtraction(base, extraction).skills).toEqual(['TypeScript', 'Rust']);
  });

  it('is idempotent — re-importing the same résumé changes nothing', () => {
    const once = applyResumeExtraction(base, extraction);
    const twice = applyResumeExtraction(once, extraction);
    expect(twice).toEqual(once);
  });

  it('produces a profile that still validates', () => {
    expect(() => PROFILE.parse(applyResumeExtraction(base, extraction))).not.toThrow();
  });
});

describe('canonical key guard', () => {
  it('rejects a key the model might invent', () => {
    expect(isCanonicalKey('personal.firstName')).toBe(true);
    expect(isCanonicalKey('personal.favouriteColour')).toBe(false);
  });
});
