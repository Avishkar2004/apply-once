import { describe, expect, it } from 'vitest';
import {
  createEmptyProfile,
  CURRENT_SCHEMA_VERSION,
  FREE_TEXT,
  PROFILE,
  UNMAPPABLE,
  type Profile,
} from '@autofill/core';
import { buildFillPlan } from '@/core/mapping/plan';
import type { FieldDescriptorDto, FieldMapping } from '@/shared/types';

function field(id: string, extra: Partial<FieldDescriptorDto> = {}): FieldDescriptorDto {
  return {
    id,
    signature: id,
    kind: 'text',
    labelBlob: id,
    displayLabel: id,
    required: false,
    ...extra,
  };
}

const mapping = (fieldId: string, target: FieldMapping['target'], confidence = 0.95): FieldMapping => ({
  fieldId,
  target,
  confidence,
  source: 'rule',
});

const profile: Profile = PROFILE.parse({
  ...createEmptyProfile(CURRENT_SCHEMA_VERSION),
  personal: { firstName: 'Ada', lastName: 'Lovelace' },
  eeo: {
    gender: 'female',
    race: 'decline',
    ethnicity: 'decline',
    veteranStatus: 'decline',
    disabilityStatus: 'decline',
  },
});

describe('buildFillPlan', () => {
  it('produces an instruction per resolvable mapping', () => {
    const plan = buildFillPlan(
      [field('a')],
      [mapping('a', 'personal.firstName')],
      profile,
      { fillEeo: false },
    );
    expect(plan.instructions).toHaveLength(1);
    expect(plan.instructions[0]?.value.text).toBe('Ada');
  });

  it('skips a mapped field the profile has no data for', () => {
    const plan = buildFillPlan([field('a')], [mapping('a', 'links.github')], profile, { fillEeo: false });
    expect(plan.instructions).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'no-profile-data', key: 'links.github' });
  });

  it('skips unmappable fields', () => {
    const plan = buildFillPlan([field('a')], [mapping('a', UNMAPPABLE, 0)], profile, { fillEeo: false });
    expect(plan.skipped[0]?.reason).toBe('unmapped');
  });

  it('routes free-text questions away from the profile (§3.6)', () => {
    const plan = buildFillPlan([field('a')], [mapping('a', FREE_TEXT)], profile, { fillEeo: false });
    expect(plan.skipped[0]?.reason).toBe('free-text');
    expect(plan.instructions).toHaveLength(0);
  });

  it('leaves voluntary self-identification blank unless the user opted in (§4)', () => {
    const off = buildFillPlan([field('a')], [mapping('a', 'eeo.gender')], profile, { fillEeo: false });
    expect(off.instructions).toHaveLength(0);
    expect(off.skipped[0]?.reason).toBe('eeo-disabled');

    const on = buildFillPlan([field('a')], [mapping('a', 'eeo.gender')], profile, { fillEeo: true });
    expect(on.instructions[0]?.value.text).toBe('Female');
  });

  it('formats a date for the control it is going into', () => {
    const dated = PROFILE.parse({
      ...profile,
      personal: { ...profile.personal, dateOfBirth: '1815-12-10' },
    });

    const iso = buildFillPlan(
      [field('a', { kind: 'date', inputType: 'date' })],
      [mapping('a', 'personal.dateOfBirth')],
      dated,
      { fillEeo: false },
    );
    expect(iso.instructions[0]?.value.text).toBe('1815-12-10');

    const us = buildFillPlan(
      [field('a', { kind: 'text', placeholder: 'MM/DD/YYYY' })],
      [mapping('a', 'personal.dateOfBirth')],
      dated,
      { fillEeo: false },
    );
    expect(us.instructions[0]?.value.text).toBe('12/10/1815');
  });

  it('honours the control maxLength', () => {
    const wordy = PROFILE.parse({
      ...profile,
      work: [{ company: 'A', title: 'T', current: false, description: 'word '.repeat(60) }],
    });
    const plan = buildFillPlan(
      [field('a', { kind: 'textarea', maxLength: 50 })],
      [mapping('a', 'work[].description')],
      wordy,
      { fillEeo: false },
    );
    expect(plan.instructions[0]?.value.text.length).toBeLessThanOrEqual(50);
  });

  it('resolves repeating-section rows by their annotated index', () => {
    const twoJobs = PROFILE.parse({
      ...profile,
      work: [
        { company: 'Acme', title: 'Engineer', current: false },
        { company: 'Globex', title: 'Staff Engineer', current: true },
      ],
    });
    const plan = buildFillPlan(
      [field('a', { rowIndex: 0 }), field('b', { rowIndex: 1 })],
      [mapping('a', 'work[].company'), mapping('b', 'work[].company')],
      twoJobs,
      { fillEeo: false },
    );
    expect(plan.instructions.map((i) => i.value.text)).toEqual(['Acme', 'Globex']);
  });
});
