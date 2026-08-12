import { describe, expect, it } from 'vitest';
import {
  buildLabelBlob,
  compactKey,
  formatDate,
  humanizeAttribute,
  levenshtein,
  normalizeLabel,
  parseProfileDate,
  sniffDateFormat,
  stableHash,
  truncate,
} from '../src/util/index';

describe('normalizeLabel', () => {
  it('strips required markers, punctuation and case', () => {
    expect(normalizeLabel('First Name *')).toBe('first name');
    expect(normalizeLabel('Email (required)')).toBe('email');
    expect(normalizeLabel('Phone number (optional)')).toBe('phone number');
    expect(normalizeLabel('  LinkedIn   URL  ')).toBe('linkedin url');
  });

  it('keeps digits, which carry meaning', () => {
    expect(normalizeLabel('Address line 2')).toBe('address line 2');
  });

  it('folds accents', () => {
    expect(normalizeLabel('Résumé')).toBe('resume');
  });
});

describe('buildLabelBlob', () => {
  it('concatenates signals and drops duplicates', () => {
    expect(buildLabelBlob(['First name', 'first_name', undefined, 'First Name', 'e.g. Jane'])).toBe(
      'first name e g jane',
    );
  });
});

describe('humanizeAttribute', () => {
  it('handles the shapes real forms use', () => {
    expect(humanizeAttribute('first_name')).toBe('first name');
    expect(humanizeAttribute('firstName')).toBe('first name');
    expect(humanizeAttribute('first-name')).toBe('first name');
    expect(humanizeAttribute('applicant[first_name]')).toBe('applicant first name');
  });

  it('drops generated id noise', () => {
    expect(humanizeAttribute('field_0_1a2b3c4d')).toBe('field');
  });
});

describe('levenshtein', () => {
  it('measures edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('bails out past the ceiling', () => {
    expect(levenshtein('completely different', 'x', 2)).toBeGreaterThan(2);
  });
});

describe('stableHash', () => {
  it('is deterministic and varies with input', () => {
    expect(stableHash('input|text')).toBe(stableHash('input|text'));
    expect(stableHash('a')).not.toBe(stableHash('b'));
    expect(stableHash('anything')).toHaveLength(16);
  });
});

describe('truncate', () => {
  it('prefers a word boundary', () => {
    expect(truncate('the quick brown fox jumps', 15)).toBe('the quick brown');
  });

  it('hard-cuts when there is no usable boundary', () => {
    expect(truncate('supercalifragilistic', 8)).toBe('supercal');
  });
});

describe('dates', () => {
  it('parses the stored representations', () => {
    expect(parseProfileDate('2021-06-14')).toEqual({ year: 2021, month: 6, day: 14 });
    expect(parseProfileDate('2021-06')).toEqual({ year: 2021, month: 6 });
    expect(parseProfileDate('2021')).toEqual({ year: 2021 });
    expect(parseProfileDate('June 2021')).toBeNull();
  });

  it('sniffs the format a control wants', () => {
    expect(sniffDateFormat({ inputType: 'date' })).toBe('YYYY-MM-DD');
    expect(sniffDateFormat({ inputType: 'month' })).toBe('YYYY-MM');
    expect(sniffDateFormat({ placeholder: 'MM/DD/YYYY' })).toBe('MM/DD/YYYY');
    expect(sniffDateFormat({ placeholder: 'DD/MM/YYYY' })).toBe('DD/MM/YYYY');
    expect(sniffDateFormat({ placeholder: 'MM/YYYY' })).toBe('MM/YYYY');
    expect(sniffDateFormat({ locale: 'en-GB' })).toBe('DD/MM/YYYY');
    expect(sniffDateFormat({})).toBe('MM/DD/YYYY');
  });

  it('renders every supported format', () => {
    const parts = { year: 2021, month: 6, day: 14 };
    expect(formatDate(parts, 'YYYY-MM-DD')).toBe('2021-06-14');
    expect(formatDate(parts, 'MM/DD/YYYY')).toBe('06/14/2021');
    expect(formatDate(parts, 'DD/MM/YYYY')).toBe('14/06/2021');
    expect(formatDate({ year: 2021 }, 'MM/YYYY')).toBe('01/2021');
  });
});

describe('compactKey', () => {
  it('reduces to comparable alphanumerics', () => {
    expect(compactKey('Full-Time!')).toBe('fulltime');
    expect(compactKey('full time')).toBe('fulltime');
  });
});
