import { truncate, type Profile } from '@autofill/core';
import type { PageContext } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { buildProfileBrief } from './answer-draft';
import { complete, parseJsonOutput } from './client';

const log = createLogger('llm/email-draft');

/**
 * The application email drafter (ARCHITECTURE.md §3.7).
 *
 * Modelled on the Answer Generator (§3.6) and deliberately not a second way of
 * doing the same thing: the same `complete()` gate, the same provider layer, the
 * same `buildProfileBrief`, the same truncation discipline. The only differences
 * are the shape of the output (a subject and a body rather than one answer) and
 * that there is no answer bank to check first — a covering email is written for
 * one posting and reusing it verbatim on the next would be obvious.
 *
 * Grounding is the same hard rule as §3.6: nothing about the applicant that is
 * not in their profile or their résumé. An invented employer in a covering email
 * is worse than a vague one — the recruiter has the CV in front of them.
 *
 * The draft is returned, never sent. §6.7's "never auto-submits" extends here
 * unchanged: the panel requires a click, and the click opens a compose window
 * rather than a socket.
 */

/**
 * Why this asks for text and not a JSON schema.
 *
 * The first version constrained generation with `{ subject, body }` as strict
 * JSON, the way Tier 3 mapping and résumé parsing do. That was the wrong tool
 * for two strings, and it broke the feature on exactly the provider the product
 * defaults to: most free models on OpenRouter do not support structured
 * outputs, so the request is either rejected outright or answered with prose
 * that fails to parse. Either way the drafter threw, the caller fell back to the
 * plain path, and the user got a subject line with an empty body — the single
 * worst outcome, because it looks like the feature simply did not run.
 *
 * A `Subject:` line followed by the body is something every model can produce,
 * from Claude down to a 1B model running locally. `parseDraftedEmail` below
 * accepts that, and JSON too for the models that volunteer it.
 */
export interface ParsedEmail {
  subject: string;
  body: string;
}

/** ~220 words with room for a signature. Enforced in the prompt *and* after. */
export const MAX_BODY_CHARS = 1800;
export const MAX_SUBJECT_CHARS = 140;

export interface EmailDraftRequest {
  /** The address the detector proposed, or the one the user chose instead. */
  to: string;
  page: PageContext;
  profile: Profile;
  /** Filenames the user will attach by hand — named so the email can say so. */
  attachments?: string[];
}

export interface EmailDraftResult {
  subject: string;
  body: string;
  /** True when either part had to be shortened after generation. */
  truncated: boolean;
}

const SYSTEM_PROMPT = `You write short application emails on behalf of a job applicant, in their voice.

Write in first person, plainly and specifically. Ground every claim in the applicant's own background as given — their roles, their skills, their résumé. Do not invent employers, dates, metrics, or achievements that are not in the material you were given; a fabricated detail in a job application is worse than a vague one, and the recruiter has the CV in front of them.

The body is 150–220 words. Three or four short paragraphs:
- why you are writing, naming the role and where you saw it;
- what in your actual background fits this posting;
- a plain closing line, then your name.

Do not open with "I hope this email finds you well", "I am writing to express my interest", or any other stock phrase. Do not flatter the company. Do not claim years of experience you were not given. Do not include a placeholder like [Your Name] — use the applicant's real name, or omit the line if you were not given one.

The subject line names the role and the applicant, and nothing else.

Answer in exactly this shape and nothing else:

Subject: <the subject line>

<the body, plain text, blank lines between paragraphs>

No preamble, no commentary, no markdown, no HTML, no code fence, no signature block beyond the name.`;

/** The exact payload sent. Exported so a test can assert what leaves the device. */
export function buildEmailPrompt(request: EmailDraftRequest): string {
  const sections: string[] = [];

  const role = [request.page.jobTitle, request.page.company].filter(Boolean).join(' at ');
  sections.push(role ? `They are applying for: ${role}` : 'They are applying for a role.');
  sections.push(`The email goes to: ${request.to}`);

  if (request.page.jobDescription) {
    sections.push('', 'Job description as posted:', truncate(request.page.jobDescription, 3000));
  }

  sections.push('', 'About the applicant:', buildProfileBrief(request.profile));

  if (request.attachments?.length) {
    sections.push(
      '',
      `They will attach: ${request.attachments.join(', ')}. Refer to the attachment in one clause; do not list file names.`,
    );
  }

  sections.push(
    '',
    `Hard limits: subject at most ${MAX_SUBJECT_CHARS} characters, body at most ${MAX_BODY_CHARS}. Stay comfortably under both.`,
  );

  return sections.join('\n');
}

/**
 * Read a subject and a body out of whatever the model actually returned.
 *
 * Four shapes, in the order models produce them. Every branch must yield a
 * non-empty *body* or return `undefined` — a subject with nothing under it is
 * indistinguishable from the feature not running, so it is a failure to report,
 * never a result to ship.
 */
export function parseDraftedEmail(text: string): ParsedEmail | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // 1. JSON, fenced or bare — some models volunteer it whatever the prompt said.
  //    Only attempted when the text actually looks like JSON: a prose email is
  //    the normal case here, and running it through the JSON parser would log a
  //    warning on every successful draft.
  if (/^[{[]/.test(trimmed) || /^```/.test(trimmed)) {
    const json = parseJsonOutput(trimmed);
    if (json && typeof json === 'object') {
      const record = json as { subject?: unknown; body?: unknown };
      if (typeof record.subject === 'string' && typeof record.body === 'string') {
        const body = record.body.trim();
        if (body) return { subject: record.subject.trim(), body };
      }
    }
  }

  // 2. A `Subject:` header somewhere near the top. Not anchored to line 1: a
  //    model that opens with "Here is your email:" is otherwise perfectly usable.
  const lines = stripFence(trimmed).split(/\r?\n/);
  const headerAt = lines
    .slice(0, 5)
    .findIndex((line) => /^\s*\**subject\**\s*:/i.test(line));

  if (headerAt !== -1) {
    const subject = lines[headerAt]!.replace(/^\s*\**subject\**\s*:/i, '').trim();
    const body = dropBodyLabel(lines.slice(headerAt + 1).join('\n')).trim();
    if (body) return { subject: stripEmphasis(subject), body };
  }

  // 3. No header, but a short first line and something under it — that is a
  //    subject and a body however it was labelled.
  const [first = '', ...rest] = lines;
  const remainder = dropBodyLabel(rest.join('\n')).trim();
  if (first.trim().length <= MAX_SUBJECT_CHARS && remainder) {
    return { subject: stripEmphasis(first.trim()), body: remainder };
  }

  // 4. One undifferentiated blob. It is the body; the caller supplies a subject.
  return { subject: '', body: trimmed };
}

const stripFence = (text: string): string =>
  /^```/.test(text) ? text.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '') : text;

/**
 * Models label the second half as often as they label the first, and markdown
 * emphasis wraps the *whole* label including its colon — `**Body:**`, not
 * `**Body**:` — so the trailing asterisks sit after the colon, not before it.
 */
const dropBodyLabel = (text: string): string =>
  text.replace(/^\s*\**body\**\s*:\s*\**\s*/i, '');

const stripEmphasis = (text: string): string => text.replace(/^\**|\**$/g, '').trim();

export async function draftApplicationEmail(
  request: EmailDraftRequest,
): Promise<EmailDraftResult> {
  const { text } = await complete('drafting', {
    // ~4 characters per token, plus room for the model to think.
    maxTokens: 1600,
    system: SYSTEM_PROMPT,
    effort: 'medium',
    messages: [{ role: 'user', content: buildEmailPrompt(request) }],
  });

  const parsed = parseDraftedEmail(text);
  if (!parsed?.body) {
    log.warn('the model returned nothing usable as an email body');
    throw new Error('The model did not return an email we could read.');
  }

  // Belt and braces: the prompt asked for the limits, and we enforce them
  // anyway. A model asked for 220 words will sometimes write 400.
  const rawSubject = parsed.subject || fallbackSubject(request);
  const subject = truncate(rawSubject, MAX_SUBJECT_CHARS);
  const body = truncate(parsed.body, MAX_BODY_CHARS);
  const truncated = subject.length < rawSubject.length || body.length < parsed.body.length;

  if (truncated) log.info('email draft shortened to fit the cap');
  return { subject, body, truncated };
}

/** For the model that wrote a fine body and no subject line at all. */
function fallbackSubject(request: EmailDraftRequest): string {
  const name = applicantName(request.profile);
  return ['Application', request.page.jobTitle ? `— ${request.page.jobTitle}` : '', name ? `— ${name}` : '']
    .filter(Boolean)
    .join(' ');
}

const applicantName = (profile: Profile): string =>
  [profile.personal.preferredName || profile.personal.firstName, profile.personal.lastName]
    .filter(Boolean)
    .join(' ');

/**
 * The no-AI path (§3.7, §6.3).
 *
 * When AI assistance is off, or unconfigured, the address is still worth having:
 * the user gets a subject line and an empty body, opened in their own mail
 * client. Detection is local and free, so turning the model off should cost the
 * draft, not the feature.
 */
export function plainApplicationEmail(profile: Profile, page: PageContext): EmailDraftResult {
  const name = applicantName(profile);
  const role = page.jobTitle ?? 'your open role';
  const subject = truncate(
    ['Application', role ? `— ${role}` : '', name ? `— ${name}` : ''].filter(Boolean).join(' '),
    MAX_SUBJECT_CHARS,
  );

  return { subject, body: '', truncated: false };
}
