import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { truncate, type EducationEntry, type Profile, type WorkEntry } from '@autofill/core';
import { createLogger } from '@/shared/logger';
import { getLlmContext, MODELS } from './client';

const log = createLogger('llm/resume-parse');

/**
 * Résumé → profile bootstrap (ARCHITECTURE.md §7, milestone M6:
 * "Upload a PDF, get a populated profile").
 *
 * The extraction schema is deliberately **not** the `Profile` Zod schema.
 * Structured outputs require every property to be required with
 * `additionalProperties: false`, and they reject the unions, defaults and
 * numeric constraints `Profile` uses. Keeping the wire contract separate also
 * means a change to how profiles are stored cannot silently change what the
 * model is asked for.
 *
 * Every field is required and empty-string-means-absent, which is the shape
 * structured outputs are designed around.
 */

const RESUME_EXTRACTION = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string(),
  linkedin: z.string(),
  github: z.string(),
  website: z.string(),
  skills: z.array(z.string()),
  work: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      /** `YYYY-MM`, or empty when the résumé does not say. */
      startDate: z.string(),
      endDate: z.string(),
      current: z.boolean(),
      description: z.string(),
    }),
  ),
  education: z.array(
    z.object({
      school: z.string(),
      degree: z.string(),
      fieldOfStudy: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      gpa: z.string(),
    }),
  ),
});

export type ResumeExtraction = z.infer<typeof RESUME_EXTRACTION>;

const SYSTEM_PROMPT = `You extract structured data from a résumé.

Copy what the document says. Do not infer, normalise job titles, expand abbreviations, or fill gaps with what is typical — an invented employer or date ends up in a submitted job application.

Leave a field as an empty string when the résumé does not state it. Never guess an email, a phone number, or a date.

Dates are YYYY-MM (or YYYY when only a year is given). Set current to true only when the résumé says the role is ongoing ("Present", "Current").

List roles and schools most recent first.`;

export async function structureResume(resumeText: string): Promise<ResumeExtraction> {
  const { client } = await getLlmContext();

  const message = await client.messages.parse({
    model: MODELS.parsing,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    output_config: { format: zodOutputFormat(RESUME_EXTRACTION), effort: 'medium' },
    messages: [{ role: 'user', content: `Résumé:\n\n${truncate(resumeText, 40_000)}` }],
  });

  const parsed = message.parsed_output;
  if (!parsed) throw new Error('Could not read a profile out of that résumé.');

  log.info(`extracted ${parsed.work.length} roles and ${parsed.education.length} schools`);
  return parsed;
}

/**
 * Merge an extraction into an existing profile, **non-destructively**.
 *
 * M6 is a bootstrap, not a re-import: a value the user has already typed always
 * wins over one the model read out of a PDF. Work and education entries are
 * appended only when the same company/school-and-title pair is not already
 * present, so re-running on an updated résumé does not duplicate a career.
 */
export function applyResumeExtraction(profile: Profile, extraction: ResumeExtraction): Profile {
  const keep = (existing: string | undefined, incoming: string): string =>
    existing && existing.trim() ? existing : incoming.trim();

  const merged: Profile = {
    ...profile,
    personal: {
      ...profile.personal,
      firstName: keep(profile.personal.firstName, extraction.firstName),
      lastName: keep(profile.personal.lastName, extraction.lastName),
    },
    contact: {
      ...profile.contact,
      email: keep(profile.contact.email, extraction.email),
      phone: keep(profile.contact.phone, extraction.phone),
      address: {
        ...profile.contact.address,
        city: keep(profile.contact.address.city, extraction.city),
        state: keep(profile.contact.address.state, extraction.state),
        postalCode: keep(profile.contact.address.postalCode, extraction.postalCode),
        country: keep(profile.contact.address.country, extraction.country),
      },
    },
    links: {
      ...profile.links,
      linkedin: keep(profile.links.linkedin, extraction.linkedin),
      github: keep(profile.links.github, extraction.github),
      website: keep(profile.links.website, extraction.website),
    },
    skills: mergeSkills(profile.skills, extraction.skills),
    work: [...profile.work, ...newWorkEntries(profile.work, extraction.work)],
    education: [...profile.education, ...newEducationEntries(profile.education, extraction.education)],
  };

  return merged;
}

function mergeSkills(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((skill) => skill.toLowerCase()));
  const added = incoming.filter((skill) => skill.trim() && !seen.has(skill.toLowerCase()));
  return [...existing, ...added];
}

const workKey = (entry: { company: string; title: string }) =>
  `${entry.company.toLowerCase().trim()}|${entry.title.toLowerCase().trim()}`;

function newWorkEntries(existing: WorkEntry[], incoming: ResumeExtraction['work']): WorkEntry[] {
  const seen = new Set(existing.map(workKey));
  return incoming
    .filter((entry) => entry.company.trim() && !seen.has(workKey(entry)))
    .map((entry) => ({
      company: entry.company.trim(),
      title: entry.title.trim(),
      current: entry.current,
      ...(entry.location.trim() ? { location: entry.location.trim() } : {}),
      ...(entry.startDate.trim() ? { startDate: entry.startDate.trim() } : {}),
      ...(entry.endDate.trim() ? { endDate: entry.endDate.trim() } : {}),
      ...(entry.description.trim() ? { description: entry.description.trim() } : {}),
    }));
}

const schoolKey = (entry: { school: string; degree: string }) =>
  `${entry.school.toLowerCase().trim()}|${entry.degree.toLowerCase().trim()}`;

function newEducationEntries(
  existing: EducationEntry[],
  incoming: ResumeExtraction['education'],
): EducationEntry[] {
  const seen = new Set(existing.map(schoolKey));
  return incoming
    .filter((entry) => entry.school.trim() && !seen.has(schoolKey(entry)))
    .map((entry) => ({
      school: entry.school.trim(),
      degree: entry.degree.trim(),
      fieldOfStudy: entry.fieldOfStudy.trim(),
      ...(entry.startDate.trim() ? { startDate: entry.startDate.trim() } : {}),
      ...(entry.endDate.trim() ? { endDate: entry.endDate.trim() } : {}),
      ...(entry.gpa.trim() ? { gpa: entry.gpa.trim() } : {}),
    }));
}
