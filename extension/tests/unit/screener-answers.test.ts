import { beforeEach, describe, expect, it } from 'vitest';
import { findAnswer, saveAnswer } from '@/core/answers/bank';
import { db } from '@/storage/db';
import { createSession, lockSession, sessionStatus, unlockSession } from '@/storage/session';

/**
 * Screener questions: answered once, reused everywhere.
 *
 * Naukri asks a handful of these on every posting — "What is your location?",
 * "Do you have your own laptop which you can use for work?" — and no canonical
 * key could ever hold them. Before this they were reported as ⬜ "No matching
 * profile field" on every single application, with a list of profile fields to
 * choose from, none of which fitted.
 *
 * The bank already existed for §3.6 essay answers. These tests pin the parts
 * that make a one-word screener answer durable: the question is the key, the
 * wording is normalised, and a generic answer is not leaked between employers
 * when the question is about the employer.
 */

const PASSPHRASE = 'correct horse battery staple';

// One vault per device, so it is created once and re-unlocked thereafter.
beforeEach(async () => {
  await db().answerBank.clear();
  await lockSession();
  if ((await sessionStatus()).hasVault) await unlockSession(PASSPHRASE);
  else await createSession(PASSPHRASE);
});

describe('the answer bank as a screener store', () => {
  it('recalls a yes/no answer for the question that was asked', async () => {
    await saveAnswer({
      question: 'Do you have your own laptop which you can use for work?',
      answer: 'Yes',
    });

    const hit = await findAnswer('Do you have your own laptop which you can use for work?');
    expect(hit?.answer).toBe('Yes');
  });

  it('recalls it despite the punctuation and casing a different board uses', async () => {
    await saveAnswer({ question: 'What is your location?', answer: 'Pune' });

    // Same question, rendered by a different site.
    expect((await findAnswer('What is your Location'))?.answer).toBe('Pune');
    expect((await findAnswer('  what is your location?  '))?.answer).toBe('Pune');
  });

  it('does not answer a question it has never seen', async () => {
    await saveAnswer({ question: 'Do you own a laptop?', answer: 'Yes' });
    expect(await findAnswer('Are you willing to relocate?')).toBeUndefined();
  });

  it('reuses a generic answer across employers', async () => {
    await saveAnswer({ question: 'How many years of Python experience?', answer: '4', company: 'Acme' });

    // Not about the employer, so it is not scoped to one.
    expect((await findAnswer('How many years of Python experience?', 'Globex'))?.answer).toBe('4');
  });

  it('never reuses an answer that was about a particular employer', async () => {
    await saveAnswer({
      question: 'Why do you want to work here?',
      answer: 'I admire Acme’s work on logistics.',
      company: 'Acme',
    });

    expect(await findAnswer('Why do you want to work here?', 'Globex')).toBeUndefined();
  });

  it('lets a later answer replace an earlier one', async () => {
    await saveAnswer({ question: 'Notice period?', answer: '90 days' });
    await saveAnswer({ question: 'Notice period?', answer: '30 days' });

    const hit = await findAnswer('Notice period?');
    expect(hit?.answer).toBe('30 days');
    // The count is what tells the user an answer is pulling its weight.
    expect(hit?.usedCount).toBe(2);
  });

  it('keeps answers sealed at rest — the question and answer never sit in the clear', async () => {
    await saveAnswer({ question: 'Do you have your own laptop?', answer: 'Yes' });

    const [record] = await db().answerBank.toArray();
    expect(JSON.stringify(record)).not.toContain('laptop');
    expect(record?.ciphertext).toBeInstanceOf(Uint8Array);
  });

  it('cannot be read while the vault is locked', async () => {
    await saveAnswer({ question: 'Do you have your own laptop?', answer: 'Yes' });
    await lockSession();

    await expect(findAnswer('Do you have your own laptop?')).rejects.toThrow();
  });
});
