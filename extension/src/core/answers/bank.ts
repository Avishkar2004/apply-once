import { normalizeLabel, openJson, sealJson, sha256Hex } from '@autofill/core';
import { db } from '@/storage/db';
import { requireDek } from '@/storage/session';

/**
 * The Answer Bank (ARCHITECTURE.md §3.6).
 *
 *   question ──► normalize + hash ──► bank hit? ──yes──► reuse (0ms, free)
 *
 * "Company-specific answers store with the company as part of the key. Generic
 * ones ('describe a challenge') reuse everywhere."
 *
 * Answers are free text written by the user about themselves, so records are
 * sealed with the DEK exactly like the profile.
 */

export interface StoredAnswer {
  question: string;
  answer: string;
  company?: string;
  usedCount: number;
  lastUsed: string;
}

/**
 * Questions that are about *this* employer rather than about the applicant.
 * A "why do you want to work here" answer must not be reused at another company;
 * "describe a challenging project" can be.
 */
const COMPANY_SPECIFIC = /\b(this (company|role|position|team|job)|our (company|team|mission|product|values)|work here|join us|about us|why us|interested in (us|this))\b/;

export function normalizeQuestion(question: string): string {
  return normalizeLabel(question);
}

export function isCompanySpecific(question: string, company?: string): boolean {
  const normalized = normalizeQuestion(question);
  if (COMPANY_SPECIFIC.test(normalized)) return true;
  const companyName = company ? normalizeLabel(company) : '';
  return companyName.length > 2 && normalized.includes(companyName);
}

/**
 * The lookup key. Company-scoped questions get the company folded in so the
 * same wording at two employers cannot collide.
 */
export async function questionKey(question: string, company?: string): Promise<string> {
  const normalized = normalizeQuestion(question);
  const scope = isCompanySpecific(question, company) && company ? `${normalizeLabel(company)}|` : '';
  return sha256Hex(`${scope}${normalized}`);
}

async function readRecord(hash: string): Promise<StoredAnswer | undefined> {
  const record = await db().answerBank.get(hash);
  if (!record) return undefined;

  const dek = await requireDek();
  const payload = await openJson<{ question: string; answer: string }>(dek, 'answer', hash, {
    iv: record.iv,
    ciphertext: record.ciphertext,
  });
  return {
    ...payload,
    ...(record.company ? { company: record.company } : {}),
    usedCount: record.usedCount,
    lastUsed: record.lastUsed,
  };
}

/** A previously approved answer for this question, if there is one. */
export async function findAnswer(
  question: string,
  company?: string,
): Promise<StoredAnswer | undefined> {
  const scoped = await questionKey(question, company);
  const hit = await readRecord(scoped);
  if (hit) return hit;

  // A company-scoped miss can still fall back to a generic answer for the same
  // wording — but never the other way round.
  const generic = await sha256Hex(normalizeQuestion(question));
  return generic === scoped ? undefined : readRecord(generic);
}

/** Record an answer the user approved (§3.6 — approval is what makes it durable). */
export async function saveAnswer(input: {
  question: string;
  answer: string;
  company?: string;
}): Promise<void> {
  const dek = await requireDek();
  const hash = await questionKey(input.question, input.company);
  const existing = await db().answerBank.get(hash);

  const { iv, ciphertext } = await sealJson(dek, 'answer', hash, {
    question: input.question,
    answer: input.answer,
  });

  await db().answerBank.put({
    questionHash: hash,
    iv,
    ciphertext,
    ...(isCompanySpecific(input.question, input.company) && input.company
      ? { company: input.company }
      : {}),
    usedCount: (existing?.usedCount ?? 0) + 1,
    lastUsed: new Date().toISOString(),
  });
}

export async function forgetAnswer(questionHash: string): Promise<void> {
  await db().answerBank.delete(questionHash);
}

export async function countAnswers(): Promise<number> {
  return db().answerBank.count();
}

/**
 * "Your top-3 similar past answers" (§3.6) — grounding context for a new draft,
 * so a fresh answer sounds like the ones the user already approved.
 *
 * Similarity is token overlap rather than embeddings: it needs no model, it is
 * deterministic, and at a few hundred answers it is instant.
 */
export async function similarAnswers(question: string, limit = 3): Promise<StoredAnswer[]> {
  const records = await db().answerBank.orderBy('lastUsed').reverse().limit(50).toArray();
  if (records.length === 0) return [];

  const wanted = tokenSet(question);
  const scored: Array<{ score: number; answer: StoredAnswer }> = [];

  for (const record of records) {
    const answer = await readRecord(record.questionHash);
    if (!answer) continue;
    const score = jaccard(wanted, tokenSet(answer.question));
    if (score > 0) scored.push({ score, answer });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.answer);
}

/** Words too common to carry signal about what a question is asking. */
const STOP_WORDS = new Set([
  'the', 'and', 'or', 'to', 'of', 'in', 'for', 'on', 'at', 'is', 'are', 'was',
  'you', 'your', 'we', 'our', 'us', 'i', 'me', 'my', 'do', 'does', 'did', 'what', 'why',
  'how', 'this', 'that', 'it', 'be', 'have', 'has', 'with', 'about', 'would', 'please',
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeQuestion(text)
      .split(' ')
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}
