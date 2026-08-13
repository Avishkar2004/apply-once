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

  it('derives total experience from the earliest start, not the sum of roles', () => {
    const profile = profileWith({
      work: [
        { company: 'A', title: 'Engineer', startDate: '2015-06', endDate: '2019-01', current: false },
        // Overlaps the first role — summing durations would double-count it.
        { company: 'B', title: 'Advisor', startDate: '2018-01', endDate: '2020-06', current: false },
      ],
    });

    // 2015-06 → 2020-06 is five years, not the seven that summing would give.
    expect(resolveValue(profile, 'work.totalYears')?.text).toBe('5');
  });

  it('declines to guess total experience when the history has no dates', () => {
    const profile = profileWith({
      work: [{ company: 'Acme', title: 'Engineer', current: true }],
    });
    // Better a ⬜ the user fills in than a confident zero on a real application.
    expect(resolveValue(profile, 'work.totalYears')).toBeNull();
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

/**
 * Notice period, asked two ways on one form.
 *
 * A live Keka application has a free-text notice-period box *and* a required
 * numeric "Available To Join (in days)". Making the user answer the same
 * question twice in the profile editor would be a poor trade, so whichever half
 * they filled derives the other.
 */
describe('notice period', () => {
  const withPreferences = (patch: Record<string, unknown>): Profile =>
    profileWith({
      preferences: { preferredLocations: [], ...patch } as Profile['preferences'],
    });

  it('answers the numeric box from the number', () => {
    expect(resolveValue(withPreferences({ noticePeriodDays: 45 }), 'preferences.noticePeriodDays')?.text).toBe(
      '45',
    );
  });

  it('answers the numeric box from prose the user typed', () => {
    expect(
      resolveValue(withPreferences({ noticePeriod: '2 months' }), 'preferences.noticePeriodDays')?.text,
    ).toBe('60');
  });

  it('reads "immediate" as zero days', () => {
    expect(
      resolveValue(withPreferences({ noticePeriod: 'Immediate joiner' }), 'preferences.noticePeriodDays')
        ?.text,
    ).toBe('0');
  });

  it('answers the free-text box from the number', () => {
    expect(resolveValue(withPreferences({ noticePeriodDays: 30 }), 'preferences.noticePeriod')?.text).toBe(
      '30 days',
    );
  });

  it('offers "1 month" as an option candidate for a dropdown', () => {
    const value = resolveValue(withPreferences({ noticePeriodDays: 30 }), 'preferences.noticePeriod');
    expect(value?.candidates).toContain('1 month');
  });

  it('says Immediate rather than "0 days"', () => {
    expect(resolveValue(withPreferences({ noticePeriodDays: 0 }), 'preferences.noticePeriod')?.text).toBe(
      'Immediate',
    );
  });

  it('prefers what the user actually wrote over the derived form', () => {
    const profile = withPreferences({ noticePeriod: 'Serving notice, free 15 Jan', noticePeriodDays: 30 });
    expect(resolveValue(profile, 'preferences.noticePeriod')?.text).toBe('Serving notice, free 15 Jan');
  });

  it('skips the field when neither half is set', () => {
    expect(resolveValue(withPreferences({}), 'preferences.noticePeriodDays')).toBeNull();
    expect(resolveValue(withPreferences({}), 'preferences.noticePeriod')).toBeNull();
  });
});

describe('preferred work locations', () => {
  it('joins them for a text box and offers each for a dropdown', () => {
    const profile = profileWith({
      preferences: { preferredLocations: ['Bengaluru', 'Pune', 'Remote'] } as Profile['preferences'],
    });
    const value = resolveValue(profile, 'preferences.preferredLocations');
    expect(value?.text).toBe('Bengaluru, Pune, Remote');
    expect(value?.candidates).toContain('Pune');
  });

  it('is skipped when empty rather than filled blank', () => {
    expect(
      resolveValue(createEmptyProfile(CURRENT_SCHEMA_VERSION), 'preferences.preferredLocations'),
    ).toBeNull();
  });
});
