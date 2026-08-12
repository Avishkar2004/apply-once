import type { PageContext } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { canDraft, draftAnswer } from '@/llm/answer-draft';
import { readProfile } from '@/storage/profile-store';
import { findAnswer, saveAnswer, similarAnswers } from './bank';

export * from './bank';

const log = createLogger('answers');

/**
 * The Answer Generator flow (ARCHITECTURE.md §3.6), worker-side.
 *
 * The bank is checked first because a hit is free and instant; only a miss
 * reaches the model. Nothing here writes to the page — the overlay requires an
 * explicit approval click, and approval is also what puts the answer in the
 * bank for next time.
 */

export class NoProfileContextError extends Error {
  constructor() {
    super('Add your work history to the profile so drafts have something to draw on.');
    this.name = 'NoProfileContextError';
  }
}

export interface DraftRequest {
  question: string;
  maxLength?: number;
  page: PageContext;
}

export interface DraftResponse {
  answer: string;
  /** `bank` means it was reused verbatim — no model call, no cost. */
  source: 'bank' | 'llm';
  truncated: boolean;
}

export async function requestDraft(request: DraftRequest): Promise<DraftResponse> {
  const reused = await findAnswer(request.question, request.page.company);
  if (reused) {
    log.info('answer bank hit — reusing an approved answer');
    // Re-saving bumps usedCount and lastUsed, which drives the "similar past
    // answers" ordering.
    await saveAnswer({
      question: reused.question,
      answer: reused.answer,
      ...(reused.company ? { company: reused.company } : {}),
    });
    return { answer: reused.answer, source: 'bank', truncated: false };
  }

  const profile = await readProfile();
  if (!canDraft(profile)) throw new NoProfileContextError();

  const draft = await draftAnswer({
    question: request.question,
    ...(request.maxLength !== undefined ? { maxLength: request.maxLength } : {}),
    page: request.page,
    profile,
    examples: await similarAnswers(request.question),
  });

  return { ...draft, source: 'llm' };
}

/** Called when the user accepts a draft in the overlay. */
export async function approveAnswer(input: {
  question: string;
  answer: string;
  company?: string;
}): Promise<void> {
  await saveAnswer(input);
  log.info('answer approved and stored');
}
