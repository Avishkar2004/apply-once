import { truncate, type Profile } from '@autofill/core';
import type { PageContext } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import type { StoredAnswer } from '@/core/answers/bank';
import { complete } from './client';

const log = createLogger('llm/answer-draft');

/**
 * The Answer Generator (ARCHITECTURE.md §3.6).
 *
 * Context is assembled exactly as the diagram specifies: profile + résumé text
 * + the job description scraped from the page + the user's top-3 similar past
 * answers. The draft is grounded in what the applicant has actually said about
 * themselves rather than invented.
 *
 * Two rules from §3.6 are enforced here rather than left to the caller:
 *
 *  - "Answers cap at the field's `maxLength`, enforced in the prompt *and*
 *    truncated after." Both, because a model asked for 500 characters will
 *    sometimes produce 520 and a form will silently drop the tail.
 *  - Drafts are never filled silently. This module only *returns* text; the
 *    overlay requires a click before anything is written (§3.6, §6.7).
 *
 * Unlike Tier 3 mapping, this call **does** send profile context — which is why
 * §6.3 requires it to be disclosed at the point the feature is enabled.
 */

export interface DraftRequest {
  question: string;
  /** The control's `maxLength`, when it declares one. */
  maxLength?: number;
  page: PageContext;
  profile: Profile;
  /** Previously approved answers to similar questions. */
  examples: StoredAnswer[];
}

export interface DraftResult {
  answer: string;
  /** True when the answer had to be shortened after generation. */
  truncated: boolean;
}

/** A sensible written answer with no stated limit. Roughly 150 words. */
const DEFAULT_ANSWER_CHARS = 900;

const SYSTEM_PROMPT = `You draft answers to job application questions on behalf of an applicant, in their voice.

Write in first person, plainly and specifically. Ground every claim in the applicant's own background as given — their roles, their skills, their past answers. Do not invent employers, dates, metrics, or achievements that are not in the material you were given; a fabricated detail in a submitted application is worse than a vague one.

Match the register of the applicant's previous answers when you are shown some.

No preamble, no sign-off, no "Here is my answer". Return only the answer text itself, ready to paste into the form.`;

/**
 * Everything the model is allowed to know about the applicant, in one block.
 *
 * Exported because the email drafter grounds itself in exactly the same
 * material (§3.7) — one brief, one truncation policy, one place to audit what
 * leaves the device when profile context is in play (§6.3).
 */
export function buildProfileBrief(profile: Profile): string {
  const lines: string[] = [];
  const { personal, work, education, skills, preferences } = profile;

  const name = [personal.preferredName || personal.firstName, personal.lastName]
    .filter(Boolean)
    .join(' ');
  if (name) lines.push(`Name: ${name}`);

  if (work.length) {
    lines.push('Experience:');
    for (const role of work.slice(0, 5)) {
      const span = [role.startDate, role.current ? 'present' : role.endDate]
        .filter(Boolean)
        .join('–');
      lines.push(`- ${role.title} at ${role.company}${span ? ` (${span})` : ''}`);
      if (role.description) lines.push(`  ${truncate(role.description, 400)}`);
    }
  }

  if (education.length) {
    lines.push('Education:');
    for (const entry of education.slice(0, 3)) {
      lines.push(`- ${entry.degree} ${entry.fieldOfStudy} — ${entry.school}`.trim());
    }
  }

  if (skills.length) lines.push(`Skills: ${skills.slice(0, 40).join(', ')}`);
  if (preferences.remotePreference) lines.push(`Work preference: ${preferences.remotePreference}`);

  const resume = profile.documents.resume?.parsedText;
  if (resume) lines.push('', 'Résumé text:', truncate(resume, 4000));

  return lines.join('\n');
}

function buildUserPrompt(request: DraftRequest, limit: number): string {
  const sections: string[] = [];

  const role = [request.page.jobTitle, request.page.company].filter(Boolean).join(' at ');
  if (role) sections.push(`They are applying for: ${role}`);

  if (request.page.jobDescription) {
    sections.push('', 'Job description:', truncate(request.page.jobDescription, 3000));
  }

  sections.push('', 'About the applicant:', buildProfileBrief(request.profile));

  if (request.examples.length) {
    sections.push('', 'Answers this applicant has approved before — match this voice:');
    for (const example of request.examples) {
      sections.push(`Q: ${example.question}`, `A: ${truncate(example.answer, 600)}`, '');
    }
  }

  sections.push(
    '',
    `Question to answer: ${request.question}`,
    '',
    `Hard limit: ${limit} characters. Stay comfortably under it.`,
  );

  return sections.join('\n');
}

export async function draftAnswer(request: DraftRequest): Promise<DraftResult> {
  const limit = request.maxLength && request.maxLength > 0 ? request.maxLength : DEFAULT_ANSWER_CHARS;

  const { text: raw } = await complete('drafting', {
    // ~4 characters per token, plus room for the model to think.
    maxTokens: Math.min(4096, Math.ceil(limit / 3) + 512),
    system: SYSTEM_PROMPT,
    effort: 'medium',
    messages: [{ role: 'user', content: buildUserPrompt(request, limit) }],
  });

  // Belt and braces: the prompt asked for the limit, and we enforce it anyway.
  const answer = truncate(raw, limit);
  if (answer.length < raw.length) {
    log.info(`draft truncated from ${raw.length} to ${answer.length} characters`);
  }

  return { answer, truncated: answer.length < raw.length };
}

/**
 * Is there enough here to ground a draft?
 *
 * This used to read `profile.work.length > 0 || profileCompleteness(profile).ready`,
 * which looks like two chances and is one: `ready` is only ever true when
 * `work.length > 0` is among the satisfied requirements, so the second clause
 * could never rescue the first. The effect was that someone who had uploaded a
 * résumé, filled in their contact details, and listed their education still got
 * a refusal and an empty email body — while `buildProfileBrief` was sitting on
 * four thousand characters of their résumé, which is ample grounding.
 *
 * The test is now what it always meant: is there *anything* about this person's
 * background to write from.
 */
export function canDraft(profile: Profile): boolean {
  return (
    profile.work.length > 0 ||
    profile.education.length > 0 ||
    Boolean(profile.documents.resume?.parsedText?.trim())
  );
}
