import { describe, expect, it } from 'vitest';
import { isFurniture } from '@/ui/overlay/Overlay';
import type { FillOutcome, SkipReason } from '@/shared/types';

/**
 * What the review panel demotes to a tally instead of a row.
 *
 * A live Keka form produced sixteen skipped rows, of which nine were page
 * furniture — a captcha, a consent paragraph, two "INR" currency prefixes, a
 * bare "Select" placeholder and the S/o · D/o · W/o radio labels. Each carried
 * "No matching profile field" and a key picker, which buried the two rows that
 * actually needed a decision.
 *
 * The rule may only ever demote, and only within the skipped group. Anything
 * with an action attached — a failure, a draftable question, a document waiting
 * to be attached — stays a row.
 */

const outcome = (label: string, extra: Partial<FillOutcome> = {}): FillOutcome => ({
  fieldId: 'f',
  signature: 's',
  status: 'skipped',
  label,
  skipReason: 'unmapped' as SkipReason,
  ...extra,
});

describe('demoted to the tally', () => {
  it.each([
    'Captcha',
    'reCAPTCHA',
    'INR',
    '₹',
    'Select',
    'Choose',
    'S/o',
    'D/o',
    'W/o',
    'By applying, you hereby accept the data processing terms under the Privacy Policy and give consent to processing of the data as part of this job application.',
    'I agree to the terms and conditions',
  ])('%s', (label) => {
    expect(isFurniture(outcome(label))).toBe(true);
  });
});

describe('kept as a row', () => {
  it.each([
    'Current Salary *',
    'Preferred Location',
    'Gender',
    'Available To Join (in days) *',
    'Experience',
  ])('%s', (label) => {
    expect(isFurniture(outcome(label))).toBe(false);
  });

  it('a failure, whatever it is called', () => {
    expect(isFurniture(outcome('Select', { status: 'rejected', reason: 'not a text control' }))).toBe(
      false,
    );
  });

  it('a low-confidence fill, whatever it is called', () => {
    expect(isFurniture(outcome('INR', { status: 'low-confidence' }))).toBe(false);
  });

  it('a free-text question — it has a draft flow', () => {
    expect(isFurniture(outcome('Captcha', { skipReason: 'free-text' }))).toBe(false);
  });

  it('a document waiting to be attached — it has a button', () => {
    expect(
      isFurniture(outcome('Add attachment 10MB max size', { skipReason: 'needs-attach' })),
    ).toBe(false);
  });

  it('an EEO field the user chose not to share — the reason is the point', () => {
    expect(isFurniture(outcome('Gender *', { skipReason: 'eeo-disabled' }))).toBe(false);
  });
});
