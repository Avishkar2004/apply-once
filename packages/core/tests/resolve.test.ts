import { describe, expect, it } from 'vitest';
import {
  createEmptyProfile,
  CURRENT_SCHEMA_VERSION,
  PROFILE,
  resolveValue,
  type Profile,
} from '../src/schema/index';

function profileWith(patch: Partial<Profile>): Profile {
  return PROFILE.parse({ ...createEmptyProfile(CURRENT_SCHEMA_VERSION), ...patch });
}

describe('resolveValue', () => {
  it('returns null when the profile has nothing — the caller reports ⬜ skipped', () => {
    expect(resolveValue(createEmptyProfile(CURRENT_SCHEMA_VERSION), 'links.github')).toBeNull();
  });

  it('derives a full name, preferring the preferred name', () => {
    const profile = profileWith({
      personal: { firstName: 'Jonathan', lastName: 'Reyes', preferredName: 'Jon' },
    });
    expect(resolveValue(profile, 'personal.fullName')?.text).toBe('Jon Reyes');
  });

  it('derives a single-line address', () => {
    const profile = profileWith({
      contact: {
        email: '',
        phone: '',
        address: {
          line1: '12 Rue Cler',
          line2: 'Apt 4',
          city: 'Paris',
          state: '',
          postalCode: '75007',
          country: 'FR',
        },
      },
    });
    expect(resolveValue(profile, 'contact.address.full')?.text).toBe('12 Rue Cler, Apt 4, Paris 75007, FR');
  });

  it('offers a country-code-prefixed phone as a candidate', () => {
    const profile = profileWith({
      contact: {
        email: '',
        phone: '555 0134',
        phoneCountryCode: '+1',
        address: { line1: '', city: '', state: '', postalCode: '', country: '' },
      },
    });
    const resolved = resolveValue(profile, 'contact.phone');
    expect(resolved?.text).toBe('555 0134');
    expect(resolved?.candidates).toContain('+1 555 0134');
  });

  it('turns booleans into option candidates in both directions', () => {
    const yes = profileWith({ workAuth: { authorizedIn: [], requiresSponsorship: true } });
    const no = profileWith({ workAuth: { authorizedIn: [], requiresSponsorship: false } });

    expect(resolveValue(yes, 'workAuth.requiresSponsorship')).toMatchObject({ text: 'Yes', boolean: true });
    expect(resolveValue(no, 'workAuth.requiresSponsorship')).toMatchObject({ text: 'No', boolean: false });
  });

  it('formats dates for the target control', () => {
    const profile = profileWith({ personal: { firstName: '', lastName: '', dateOfBirth: '1994-03-07' } });
    expect(resolveValue(profile, 'personal.dateOfBirth')?.text).toBe('1994-03-07');
    expect(resolveValue(profile, 'personal.dateOfBirth', { dateFormat: 'MM/DD/YYYY' })?.text).toBe('03/07/1994');
    expect(resolveValue(profile, 'personal.dateOfBirth', { dateFormat: 'YYYY' })?.text).toBe('1994');
  });

  it('reads a repeating key at the requested row', () => {
    const profile = profileWith({
      work: [
        { company: 'Acme', title: 'Engineer', current: false },
        { company: 'Globex', title: 'Staff Engineer', current: true },
      ],
    });
    expect(resolveValue(profile, 'work[].company', { rowIndex: 0 })?.text).toBe('Acme');
    expect(resolveValue(profile, 'work[].company', { rowIndex: 1 })?.text).toBe('Globex');
    expect(resolveValue(profile, 'work[].company', { rowIndex: 7 })).toBeNull();
  });

  it('caps a value at the control maxLength', () => {
    const profile = profileWith({
      work: [{ company: 'A', title: 'T', current: false, description: 'x'.repeat(500) }],
    });
    const resolved = resolveValue(profile, 'work[].description', { maxLength: 100 });
    expect(resolved?.text.length).toBeLessThanOrEqual(100);
  });

  it('joins list values and keeps the items as candidates', () => {
    const profile = profileWith({ skills: ['TypeScript', 'Rust', 'Postgres'] });
    const resolved = resolveValue(profile, 'skills');
    expect(resolved?.text).toBe('TypeScript, Rust, Postgres');
    expect(resolved?.candidates).toContain('Rust');
  });

  it('expands EEO answers into the phrasings forms actually use', () => {
    const profile = profileWith({
      eeo: {
        gender: 'decline',
        race: 'decline',
        ethnicity: 'decline',
        veteranStatus: 'decline',
        disabilityStatus: 'decline',
      },
    });
    const resolved = resolveValue(profile, 'eeo.gender');
    expect(resolved?.candidates).toContain('I do not wish to answer');
    expect(resolved?.candidates).toContain('Decline to self identify');
  });

  it('surfaces the document reference for file controls', () => {
    const profile = profileWith({
      documents: { resume: { blobId: 'abc123', filename: 'jane-resume.pdf' } },
    });
    const resolved = resolveValue(profile, 'documents.resume');
    expect(resolved?.file?.blobId).toBe('abc123');
    expect(resolved?.text).toBe('jane-resume.pdf');
  });
});
