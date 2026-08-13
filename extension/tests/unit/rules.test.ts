import { describe, expect, it } from 'vitest';
import { buildLabelBlob, type CanonicalKey } from '@autofill/core';
import { LABEL_RULES } from '@/core/mapping/rules';
import { mapWithRules, matchAutocomplete, normalizeAutocomplete } from '@/core/mapping/tier1';
import type { FieldDescriptorDto, FieldKind } from '@/shared/types';

/**
 * The rule table against a labelled corpus — ARCHITECTURE.md §10:
 * "rule table against a labeled corpus of ~500 real field labels".
 *
 * This is the seed of that corpus. Every mis-mapping found in the wild should be
 * appended here as a case before it is fixed.
 */

function field(labels: string[], extra: Partial<FieldDescriptorDto> = {}): FieldDescriptorDto {
  return {
    id: 'f',
    signature: 's',
    kind: 'text' as FieldKind,
    labelBlob: buildLabelBlob(labels),
    displayLabel: labels[0] ?? '',
    required: false,
    ...extra,
  };
}

const expectations: Array<[string[], CanonicalKey | null]> = [
  // personal
  [['First Name *'], 'personal.firstName'],
  [['Given name'], 'personal.firstName'],
  [['Last Name'], 'personal.lastName'],
  [['Surname'], 'personal.lastName'],
  [['Family Name'], 'personal.lastName'],
  [['Middle initial'], 'personal.middleName'],
  [['Preferred name'], 'personal.preferredName'],
  [['What are your pronouns?'], 'personal.pronouns'],
  [['Date of Birth'], 'personal.dateOfBirth'],
  [['Full name'], 'personal.fullName'],
  [['Legal name'], 'personal.fullName'],

  // contact
  [['Email'], 'contact.email'],
  [['E-mail address'], 'contact.email'],
  [['Phone'], 'contact.phone'],
  [['Mobile number'], 'contact.phone'],
  [['Country code'], 'contact.phoneCountryCode'],
  [['Address line 1'], 'contact.address.line1'],
  [['Apartment, suite'], 'contact.address.line2'],
  [['City'], 'contact.address.city'],
  [['State / Province'], 'contact.address.state'],
  [['Zip code'], 'contact.address.postalCode'],
  [['Postal Code'], 'contact.address.postalCode'],
  [['Country'], 'contact.address.country'],

  // links
  [['LinkedIn Profile'], 'links.linkedin'],
  [['Linked In URL'], 'links.linkedin'],
  [['GitHub'], 'links.github'],
  [['Portfolio'], 'links.portfolio'],
  [['Website'], 'links.website'],

  // work & education
  [['Current company'], 'work[].company'],
  [['Employer name'], 'work[].company'],
  [['Job title'], 'work[].title'],
  [['School'], 'education[].school'],
  [['University'], 'education[].school'],
  [['Degree'], 'education[].degree'],
  [['Field of study'], 'education[].fieldOfStudy'],
  [['GPA'], 'education[].gpa'],

  // eligibility & preferences
  [['Will you now or in the future require visa sponsorship?'], 'workAuth.requiresSponsorship'],
  [['Are you legally authorized to work in the United States?'], 'workAuth.authorizedIn'],
  [['Desired salary'], 'preferences.desiredSalary.amount'],
  [['Notice period'], 'preferences.noticePeriod'],
  [['Are you willing to relocate?'], 'preferences.willingToRelocate'],

  // voluntary
  [['Gender'], 'eeo.gender'],
  [['Are you Hispanic or Latino?'], 'eeo.ethnicity'],
  [['Veteran status'], 'eeo.veteranStatus'],
  [['Disability status'], 'eeo.disabilityStatus'],
];

describe('Tier 1 label rules', () => {
  it.each(expectations)('maps %j → %s', (labels, expected) => {
    expect(mapWithRules(field(labels))?.key ?? null).toBe(expected);
  });

  it('does not put a company name into the applicant surname (§3.2)', () => {
    expect(mapWithRules(field(['Company Name']))?.key).not.toBe('personal.lastName');
    expect(mapWithRules(field(['Company Name']))?.key).not.toBe('personal.fullName');
    expect(mapWithRules(field(['Employer Name']))?.key).toBe('work[].company');
  });

  it('does not treat a file name or user name as the applicant name', () => {
    expect(mapWithRules(field(['File name']))?.key).not.toBe('personal.fullName');
    expect(mapWithRules(field(['User name']))?.key).not.toBe('personal.fullName');
  });

  it('keeps a confirmation email out of the contact email', () => {
    expect(mapWithRules(field(['Confirm email']))?.key).not.toBe('contact.email');
  });

  it('keeps the phone country code out of the phone number', () => {
    expect(mapWithRules(field(['Phone country code']))?.key).toBe('contact.phoneCountryCode');
  });

  it('leaves genuinely novel questions unmapped for a later tier', () => {
    expect(mapWithRules(field(['Which of our engineering values resonates most with you?']))).toBeNull();
  });

  it('has no duplicate rule ids', () => {
    const ids = LABEL_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('restricts file-only rules to file controls', () => {
    expect(mapWithRules(field(['Resume'], { kind: 'file' }))?.key).toBe('documents.resume');
    expect(mapWithRules(field(['Resume'], { kind: 'text' }))?.key).not.toBe('documents.resume');
  });
});

describe('section heading disambiguation (§11)', () => {
  it('routes a start date under an Education heading to education', () => {
    const hit = mapWithRules(field(['Start date'], { sectionHeading: 'Education' }));
    expect(hit?.key).toBe('education[].startDate');
  });

  it('leaves a start date alone under an Employment heading', () => {
    const hit = mapWithRules(field(['Employment start date'], { sectionHeading: 'Employment history' }));
    expect(hit?.key).toBe('work[].startDate');
  });

  it('routes contact details under a References heading to the reference', () => {
    expect(mapWithRules(field(['Email'], { sectionHeading: 'Reference 1' }))?.key).toBe('references[].email');
  });
});

describe('autocomplete rules', () => {
  it('strips section and address-type prefixes', () => {
    expect(normalizeAutocomplete('section-blue shipping given-name')).toBe('given-name');
  });

  it.each([
    ['given-name', 'personal.firstName'],
    ['family-name', 'personal.lastName'],
    ['email', 'contact.email'],
    ['tel', 'contact.phone'],
    ['address-level2', 'contact.address.city'],
    ['postal-code', 'contact.address.postalCode'],
    ['organization-title', 'work[].title'],
  ] as Array<[string, CanonicalKey]>)('maps autocomplete=%s → %s', (token, expected) => {
    expect(matchAutocomplete(field(['irrelevant'], { autocomplete: token }))?.key).toBe(expected);
  });

  it('beats the label rules when both would fire', () => {
    // The label says "company", the autocomplete says it is the applicant's name.
    const hit = mapWithRules(field(['Company'], { autocomplete: 'given-name' }));
    expect(hit?.key).toBe('personal.firstName');
  });
});

/**
 * Labels taken verbatim from a live Keka application form (smartdocs.keka.com).
 *
 * Every one of these was reported as ⬜ "No matching profile field" by the
 * review panel before these rules existed. Indian job boards — Naukri, Keka,
 * Darwinbox, Zoho Recruit — share this vocabulary almost word for word, so the
 * corpus is the fix and the regression guard at once.
 */
describe('vocabulary outside the US', () => {
  const cases: Array<[string[], CanonicalKey, Partial<FieldDescriptorDto>?]> = [
    // Notice period, asked the way every Indian board asks it. A label that
    // names its unit wants a number; the rest take the free-text answer.
    [['Available To Join (in days) *'], 'preferences.noticePeriodDays', { kind: 'number' }],
    [['Notice period in days'], 'preferences.noticePeriodDays', { kind: 'number' }],
    [['How soon can you join?'], 'preferences.noticePeriod'],
    [['Joining time'], 'preferences.noticePeriod'],
    [['Notice Period'], 'preferences.noticePeriod'],
    [['Available to join'], 'preferences.noticePeriod'],

    // Where you want to work, which is not where you live.
    [['Preferred Location *'], 'preferences.preferredLocations'],
    [['Preferred locations'], 'preferences.preferredLocations'],
    [['Preferred city'], 'preferences.preferredLocations'],
    [['Desired work location'], 'preferences.preferredLocations'],
    [['Current Location'], 'contact.address.full'],

    // Current and expected compensation are two questions, never one.
    [['Current Salary *'], 'preferences.currentSalary.amount', { kind: 'number' }],
    [['Current CTC'], 'preferences.currentSalary.amount', { kind: 'number' }],
    [['Present package'], 'preferences.currentSalary.amount', { kind: 'number' }],
    [['Expected CTC'], 'preferences.desiredSalary.amount', { kind: 'number' }],
    [['Expected Salary'], 'preferences.desiredSalary.amount', { kind: 'number' }],

    // Total experience, whole and split.
    [['Experience *'], 'work.totalYears', { kind: 'number' }],
    [['Total Experience'], 'work.totalYears'],
    [['work experience years'], 'work.totalYears', { kind: 'number' }],
    [['work experience months'], 'work.totalMonths', { kind: 'number' }],

    // An unlabelled upload box is the résumé slot.
    [['Add attachment 10MB max size'], 'documents.resume', { kind: 'file' }],
    [['Upload'], 'documents.resume', { kind: 'file' }],
  ];

  it.each(cases)('maps %s → %s', (labels, expected, extra) => {
    expect(mapWithRules(field(labels, extra ?? {}))?.key).toBe(expected);
  });

  it('does not mistake the expected figure for the current one', () => {
    expect(mapWithRules(field(['Expected CTC'], { kind: 'number' }))?.key).not.toBe(
      'preferences.currentSalary.amount',
    );
  });

  it('leaves a written question about experience to the answer generator', () => {
    // A textarea is not a "how many years" box, whatever the label says.
    expect(mapWithRules(field(['Describe your experience'], { kind: 'textarea' }))?.key).not.toBe(
      'work.totalYears',
    );
  });

  it('still prefers a named document over the generic attachment rule', () => {
    expect(mapWithRules(field(['Attach your cover letter'], { kind: 'file' }))?.key).toBe(
      'documents.coverLetter',
    );
  });
});
