import { describe, expect, it } from 'vitest';
import {
  createEmptyProfile,
  CURRENT_SCHEMA_VERSION,
  EEO_DECLINE,
  migrateProfile,
  PROFILE,
  profileCompleteness,
  profileDrift,
  PROFILE_REVIEW_INTERVAL_DAYS,
  ProfileVersionError,
} from '../src/schema/index';

describe('profile schema', () => {
  it('creates an empty profile that validates', () => {
    const profile = createEmptyProfile(CURRENT_SCHEMA_VERSION);
    expect(profile.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(profile.work).toEqual([]);
    expect(profile.skills).toEqual([]);
    expect(profile.documents).toEqual({});
  });

  it('accepts a partially-filled profile — saving progress must never be blocked', () => {
    const profile = createEmptyProfile(CURRENT_SCHEMA_VERSION);
    expect(() => PROFILE.parse({ ...profile, personal: { ...profile.personal, firstName: 'Jane' } })).not.toThrow();
  });

  it('validates email format only when a value is present', () => {
    const profile = createEmptyProfile(CURRENT_SCHEMA_VERSION);
    expect(() => PROFILE.parse({ ...profile, contact: { ...profile.contact, email: '' } })).not.toThrow();
    expect(() => PROFILE.parse({ ...profile, contact: { ...profile.contact, email: 'nope' } })).toThrow();
    expect(() =>
      PROFILE.parse({ ...profile, contact: { ...profile.contact, email: 'jane@example.com' } }),
    ).not.toThrow();
  });

  it('defaults every EEO field to declining', () => {
    const eeo = PROFILE.parse({ ...createEmptyProfile(CURRENT_SCHEMA_VERSION), eeo: {} }).eeo;
    expect(eeo).toEqual({
      gender: EEO_DECLINE,
      race: EEO_DECLINE,
      ethnicity: EEO_DECLINE,
      veteranStatus: EEO_DECLINE,
      disabilityStatus: EEO_DECLINE,
    });
  });

  it('leaves EEO absent entirely when the user never touched it', () => {
    expect(createEmptyProfile(CURRENT_SCHEMA_VERSION).eeo).toBeUndefined();
  });

  it('reports what is missing without blocking', () => {
    const report = profileCompleteness(createEmptyProfile(CURRENT_SCHEMA_VERSION));
    expect(report.ready).toBe(false);
    expect(report.missing.map((item) => item.field)).toContain('contact.email');
  });
});

describe('profile drift (§11)', () => {
  const at = (iso: string) => PROFILE.parse({ ...createEmptyProfile(CURRENT_SCHEMA_VERSION), updatedAt: iso });

  it('says nothing about a profile that was never saved', () => {
    expect(profileDrift(createEmptyProfile(CURRENT_SCHEMA_VERSION))).toEqual({ stale: false });
  });

  it('is quiet inside the review window', () => {
    const now = new Date('2026-08-12T00:00:00Z');
    const report = profileDrift(at('2026-07-01T00:00:00Z'), now);
    expect(report.stale).toBe(false);
    expect(report.daysSinceUpdate).toBe(42);
  });

  it('prompts once a profile is 90 days stale', () => {
    const now = new Date('2026-08-12T00:00:00Z');
    const report = profileDrift(at('2026-05-01T00:00:00Z'), now);
    expect(report.stale).toBe(true);
    expect(report.daysSinceUpdate).toBeGreaterThanOrEqual(PROFILE_REVIEW_INTERVAL_DAYS);
  });

  it('fires exactly on the boundary, not a day late', () => {
    const now = new Date('2026-08-12T00:00:00Z');
    const boundary = new Date(now.getTime() - PROFILE_REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
    expect(profileDrift(at(boundary.toISOString()), now).stale).toBe(true);
  });

  it('ignores an unparseable timestamp rather than nagging', () => {
    expect(profileDrift(at('not a date' as string)).stale).toBe(false);
  });
});

describe('migrations', () => {
  it('passes a current-version profile straight through', () => {
    const profile = createEmptyProfile(CURRENT_SCHEMA_VERSION);
    expect(migrateProfile(profile).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses a profile written by a newer build rather than truncating it', () => {
    const future = { ...createEmptyProfile(CURRENT_SCHEMA_VERSION), schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    expect(() => migrateProfile(future)).toThrow(ProfileVersionError);
  });

  it('rejects non-objects', () => {
    expect(() => migrateProfile(null)).toThrow(TypeError);
  });
});
