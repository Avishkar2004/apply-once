import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyProfile,
  CURRENT_SCHEMA_VERSION,
  PROFILE,
  type Profile,
} from '@autofill/core';
import {
  MAX_BODY_CHARS,
  MAX_SUBJECT_CHARS,
  buildEmailPrompt,
  draftApplicationEmail,
  parseDraftedEmail,
  plainApplicationEmail,
} from '@/llm/email-draft';
import { canDraft } from '@/llm/answer-draft';
import { gmailComposeUrl, mailtoUrl, plainTextEmail } from '@/core/email/send';
import type { PageContext } from '@/shared/types';

/**
 * The application email drafter (ARCHITECTURE.md §3.7).
 *
 * Two things are worth pinning. First, what goes into the prompt: the same
 * grounding material as an answer draft (§3.6) — profile, résumé text, the
 * scraped posting — and nothing the applicant did not supply. A covering email
 * that invents an employer is worse than a vague one, because the recruiter has
 * the CV in front of them.
 *
 * Second, the length cap. A model asked for 220 words will sometimes write 400,
 * and a wall of text is the single most recognisable mark of a generated
 * application. The prompt asks, and the code enforces.
 */

const RESUME_TEXT =
  'Ada Lovelace — Principal Engineer at Analytical Engines. Built the note-G compiler. Cambridge, BA Mathematics.';

const profile: Profile = PROFILE.parse({
  ...createEmptyProfile(CURRENT_SCHEMA_VERSION),
  personal: { firstName: 'Ada', lastName: 'Lovelace' },
  contact: {
    email: 'ada@example.com',
    phone: '5550134000',
    address: { line1: '', city: 'London', state: '', postalCode: '', country: 'GB' },
  },
  skills: ['TypeScript', 'Rust'],
  work: [
    {
      company: 'Analytical Engines',
      title: 'Principal Engineer',
      current: true,
      startDate: '2021-03',
      description: 'Built the note-G compiler.',
    },
  ],
  documents: {
    resume: { blobId: 'b1', filename: 'ada-cv.pdf', parsedText: RESUME_TEXT },
  },
});

const page: PageContext = {
  jobTitle: 'Backend Engineer',
  company: 'Acme Corp',
  jobDescription: 'We need someone comfortable with distributed systems and Rust.',
};

/** Answer as the prompt asks: a `Subject:` line, then the body. */
function stubDraft(subject: string, body: string) {
  return vi.fn(async () => ({ text: `Subject: ${subject}\n\n${body}` }));
}

vi.mock('@/llm/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/llm/client')>()),
  complete: vi.fn(),
}));

const { complete } = await import('@/llm/client');

beforeEach(() => {
  vi.mocked(complete).mockReset();
});

describe('what the prompt carries (§6.3)', () => {
  const prompt = () => buildEmailPrompt({ to: 'careers@acme.example', page, profile });

  it('names the role, the company and the recipient', () => {
    expect(prompt()).toContain('Backend Engineer at Acme Corp');
    expect(prompt()).toContain('careers@acme.example');
  });

  it('carries the job description as posted', () => {
    expect(prompt()).toContain('distributed systems and Rust');
  });

  it('carries the profile — the roles the applicant actually held', () => {
    expect(prompt()).toContain('Ada Lovelace');
    expect(prompt()).toContain('Principal Engineer at Analytical Engines');
    expect(prompt()).toContain('TypeScript');
  });

  it('carries the résumé text, which is what grounds the specifics', () => {
    expect(prompt()).toContain('Résumé text:');
    expect(prompt()).toContain('note-G compiler');
  });

  it('states the limits it will later enforce', () => {
    expect(prompt()).toContain(String(MAX_BODY_CHARS));
    expect(prompt()).toContain(String(MAX_SUBJECT_CHARS));
  });

  it('names attachments without inviting the model to list file names', () => {
    const withFiles = buildEmailPrompt({
      to: 'careers@acme.example',
      page,
      profile,
      attachments: ['ada-cv.pdf'],
    });
    expect(withFiles).toContain('ada-cv.pdf');
    expect(withFiles).toContain('do not list file names');
  });

  it('invents nothing the applicant did not supply', () => {
    const text = prompt();
    // An empty profile section must stay empty rather than being filled in with
    // something plausible — there is no education entry on this profile.
    expect(text).not.toContain('Education:');
    // Nor is a company the applicant never worked at smuggled in from the page.
    expect(text).not.toMatch(/Experience:[\s\S]*Acme Corp/);
  });
});

describe('drafting', () => {
  it('returns the subject and body the model produced', async () => {
    vi.mocked(complete).mockImplementation(
      stubDraft('Backend Engineer — Ada Lovelace', 'I am writing about the Backend Engineer role.'),
    );

    const draft = await draftApplicationEmail({ to: 'careers@acme.example', page, profile });
    expect(draft.subject).toBe('Backend Engineer — Ada Lovelace');
    expect(draft.body).toContain('Backend Engineer role');
    expect(draft.truncated).toBe(false);
  });

  /**
   * The first version demanded strict JSON, which is unsupported by most free
   * models on the provider this product *defaults to*. The request was rejected,
   * the drafter threw, and the user got a subject with an empty body. Two
   * strings do not need a schema.
   */
  it('does not require structured output the default provider cannot give', async () => {
    vi.mocked(complete).mockImplementation(stubDraft('s', 'b'));
    await draftApplicationEmail({ to: 'careers@acme.example', page, profile });

    const [role, request] = vi.mocked(complete).mock.calls[0]!;
    expect(role).toBe('drafting');
    expect(request.json).toBeUndefined();
  });

  it('enforces the length cap the prompt asked for', async () => {
    const overlong = 'word '.repeat(2000);
    vi.mocked(complete).mockImplementation(stubDraft('x'.repeat(400), overlong));

    const draft = await draftApplicationEmail({ to: 'careers@acme.example', page, profile });
    expect(draft.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(draft.subject.length).toBeLessThanOrEqual(MAX_SUBJECT_CHARS);
    expect(draft.truncated).toBe(true);
  });

  it('supplies a subject when the model wrote a body and forgot one', async () => {
    const body = 'I am writing about the Backend Engineer role.\n\nI build distributed systems.';
    vi.mocked(complete).mockImplementation(vi.fn(async () => ({ text: body })));

    const draft = await draftApplicationEmail({ to: 'a@b.example', page, profile });
    expect(draft.body).toContain('distributed systems');
    expect(draft.subject).toContain('Backend Engineer');
  });

  it('fails loudly rather than shipping an empty body', async () => {
    vi.mocked(complete).mockImplementation(vi.fn(async () => ({ text: '   ' })));

    await expect(
      draftApplicationEmail({ to: 'a@b.example', page, profile }),
    ).rejects.toThrow(/did not return an email/i);
  });
});

/**
 * What models actually return.
 *
 * Every branch here is a shape a real model produced when asked for a subject
 * and a body. The rule the whole function serves: a non-empty body, or
 * `undefined` so the caller can say why — never a subject with nothing under it,
 * because that is indistinguishable from the feature not running at all.
 */
describe('parseDraftedEmail', () => {
  it('reads the shape the prompt asked for', () => {
    expect(parseDraftedEmail('Subject: Backend Engineer — Ada\n\nHello,\n\nI build things.')).toEqual({
      subject: 'Backend Engineer — Ada',
      body: 'Hello,\n\nI build things.',
    });
  });

  it('accepts JSON from a model that volunteered it', () => {
    expect(parseDraftedEmail('{"subject":"S","body":"B"}')).toEqual({ subject: 'S', body: 'B' });
  });

  it('accepts JSON in a code fence', () => {
    expect(parseDraftedEmail('```json\n{"subject":"S","body":"B"}\n```')).toEqual({
      subject: 'S',
      body: 'B',
    });
  });

  it('skips a chatty preamble to find the header', () => {
    const text = 'Sure! Here is your email:\n\nSubject: Backend Engineer\n\nHello,\n\nI build things.';
    expect(parseDraftedEmail(text)?.subject).toBe('Backend Engineer');
    expect(parseDraftedEmail(text)?.body).toBe('Hello,\n\nI build things.');
  });

  it('strips markdown emphasis and a Body: label', () => {
    const text = '**Subject:** Backend Engineer\n\n**Body:** Hello, I build things.';
    expect(parseDraftedEmail(text)).toEqual({
      subject: 'Backend Engineer',
      body: 'Hello, I build things.',
    });
  });

  it('treats a short first line with prose under it as a subject and a body', () => {
    expect(parseDraftedEmail('Backend Engineer — Ada\n\nHello, I build things.')).toEqual({
      subject: 'Backend Engineer — Ada',
      body: 'Hello, I build things.',
    });
  });

  it('treats one long blob as the body, leaving the subject to the caller', () => {
    const blob = 'x'.repeat(MAX_SUBJECT_CHARS + 50);
    expect(parseDraftedEmail(blob)).toEqual({ subject: '', body: blob });
  });

  it('never returns a subject with an empty body', () => {
    expect(parseDraftedEmail('Subject: Backend Engineer')).not.toMatchObject({ body: '' });
    expect(parseDraftedEmail('')).toBeUndefined();
    expect(parseDraftedEmail('   \n  ')).toBeUndefined();
  });

  it('does not lose a body that happens to be valid JSON-ish prose', () => {
    const text = 'Subject: Hello\n\n{ this is not json but mentions braces }';
    expect(parseDraftedEmail(text)?.body).toBe('{ this is not json but mentions braces }');
  });
});

/**
 * The no-AI path (§6.3): turning the model off costs the wording, not the
 * feature. Detection is local and free, so the address is still worth having.
 */
describe('the plain fallback', () => {
  it('produces a subject line and an empty body', () => {
    const plain = plainApplicationEmail(profile, page);
    expect(plain.subject).toContain('Backend Engineer');
    expect(plain.subject).toContain('Ada Lovelace');
    expect(plain.body).toBe('');
  });

  it('still says something useful when the page named no role', () => {
    expect(plainApplicationEmail(profile, {}).subject).toContain('Application');
  });
});

/**
 * The gate that decides whether a draft is attempted at all.
 *
 * It read `work.length > 0 || profileCompleteness(profile).ready`, which looks
 * like two chances and is one — `ready` can only be true when `work.length > 0`
 * is among the satisfied requirements, so the second clause could never rescue
 * the first. Someone who had uploaded a résumé and filled in everything but the
 * work-history repeater got a refusal and an empty email body, while the résumé
 * text sat in the prompt builder unused.
 */
describe('canDraft', () => {
  const withoutWork = (extra: Partial<Profile>): Profile =>
    PROFILE.parse({ ...createEmptyProfile(CURRENT_SCHEMA_VERSION), work: [], ...extra });

  it('accepts a profile whose only history is a parsed résumé', () => {
    expect(
      canDraft(
        withoutWork({
          documents: { resume: { blobId: 'b', filename: 'cv.pdf', parsedText: RESUME_TEXT } },
        }),
      ),
    ).toBe(true);
  });

  it('accepts a profile with education and no employment yet', () => {
    expect(
      canDraft(
        withoutWork({
          education: [{ school: 'Cambridge', degree: 'BA', fieldOfStudy: 'Mathematics' }],
        }),
      ),
    ).toBe(true);
  });

  it('still accepts work history on its own', () => {
    expect(canDraft(profile)).toBe(true);
  });

  it('refuses a profile with nothing to write from', () => {
    expect(canDraft(withoutWork({}))).toBe(false);
  });

  it('is not fooled by a résumé that has no extracted text', () => {
    // An upload whose text extraction failed grounds nothing.
    expect(
      canDraft(withoutWork({ documents: { resume: { blobId: 'b', filename: 'cv.pdf' } } })),
    ).toBe(false);
  });
});

/**
 * Hand-off (§3.7). None of these send; each opens a compose window.
 */
describe('send URLs', () => {
  const email = { to: 'careers@acme.example', subject: 'Hello & goodbye', body: 'One\n\nTwo' };

  it('encodes a mailto: without turning spaces into plus signs', () => {
    const url = mailtoUrl(email);
    expect(url.startsWith('mailto:careers%40acme.example?')).toBe(true);
    expect(url).toContain('subject=Hello%20%26%20goodbye');
    expect(url).toContain('body=One%0A%0ATwo');
    expect(url).not.toContain('+');
  });

  it('builds a Gmail compose URL', () => {
    const url = gmailComposeUrl(email);
    expect(url.startsWith('https://mail.google.com/mail/?view=cm&fs=1')).toBe(true);
    expect(url).toContain('to=careers%40acme.example');
    expect(url).toContain('su=Hello%20%26%20goodbye');
  });

  it('copies headers with the body, so it can be pasted anywhere', () => {
    expect(plainTextEmail(email)).toBe(
      'To: careers@acme.example\nSubject: Hello & goodbye\n\nOne\n\nTwo',
    );
  });
});
