import type { MappingTarget } from '@autofill/core';
import type { PlanRequest } from '@/shared/messages';
import type { CascadeDeps } from '@/core/mapping/cascade';
import type { AnsweredQuestion, FieldMapping, FillPlan } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { findAnswer } from '@/core/answers/bank';
import { buildFillPlan } from '@/core/mapping/plan';
import { runCascade } from '@/core/mapping/cascade';
import { loadOverrides } from '@/core/learning';
import { LlmDisabledError } from '@/llm/client';
import { mapFieldsWithLlm } from '@/llm/field-mapping';
import { matchByEmbedding, warmEmbeddings } from '@/core/mapping/tier2';
import { readCache, writeCache } from '@/storage/mapping-cache';
import { readProfile } from '@/storage/profile-store';
import { getSettings } from '@/storage/settings';

const log = createLogger('orchestrator');

/**
 * The service-worker orchestrator (ARCHITECTURE.md §2).
 *
 * It is the only component that sees both the profile and the field
 * descriptors, and it lives in the service worker because that is where the DEK
 * is. The content script sends labels up and receives values down.
 */

export class HostDisabledError extends Error {
  constructor(hostname: string) {
    super(`AutoFill is turned off for ${hostname}.`);
    this.name = 'HostDisabledError';
  }
}

export async function planFill(request: PlanRequest): Promise<FillPlan> {
  const settings = await getSettings();
  if (!settings.enabled || settings.disabledHosts.includes(request.hostname)) {
    throw new HostDisabledError(request.hostname);
  }

  // Throws VaultLockedError when locked — the overlay turns that into an unlock prompt.
  const profile = await readProfile();

  const signatures = request.fields.map((field) => field.signature);
  const [overrides, cached] = await Promise.all([
    loadOverrides(request.hostname),
    readCache(request.hostname, signatures),
  ]);

  const cache = new Map<
    string,
    { canonicalKey: MappingTarget; confidence: number; source: FieldMapping['source'] }
  >();
  for (const [signature, record] of cached) {
    cache.set(signature, {
      canonicalKey: record.canonicalKey,
      confidence: record.confidence,
      source: record.source,
    });
  }

  const deps: CascadeDeps = { overrides, cache };

  // Tier 2 — local embeddings. Registered only once the model is resident, so a
  // first-ever fill is never blocked on a 23MB download (§3.2, §12.2).
  const embedder = await warmEmbeddings();
  if (embedder) deps.embeddingMatcher = (fields) => matchByEmbedding(embedder, fields);

  // Tier 3 — one batched call for whatever is left. Absent when the user has
  // not enabled AI assistance; the cascade then reports those fields as ⬜.
  deps.llmMatcher = async (unresolved) => {
    try {
      return await mapFieldsWithLlm(unresolved, {
        hostname: request.hostname,
        ...(request.pageContext?.jobTitle ? { jobTitle: request.pageContext.jobTitle } : {}),
        ...(request.pageContext?.company ? { company: request.pageContext.company } : {}),
      });
    } catch (error) {
      if (error instanceof LlmDisabledError) log.debug('tier 3 unavailable:', error.message);
      else log.warn('tier 3 failed; falling back to unmapped', error);
      return new Map();
    }
  };

  const { mappings, cacheable } = await runCascade(
    {
      hostname: request.hostname,
      fields: request.fields,
      ...(request.adapterMappings ? { adapterMappings: request.adapterMappings } : {}),
    },
    deps,
  );

  if (cacheable.length > 0) await writeCache(request.hostname, cacheable);

  const plan = await recallAnswers(
    buildFillPlan(request.fields, mappings, profile, { fillEeo: settings.fillEeo }),
    request,
  );

  log.info(
    `planned ${plan.instructions.length} fills, ${plan.answers?.length ?? 0} recalled answers, ` +
      `${plan.skipped.length} skipped on ${request.hostname}`,
  );
  return plan;
}

/**
 * Questions the user has already answered, recalled from the answer bank.
 *
 * Job boards ask screener questions no profile schema could anticipate — "Do
 * you have your own laptop which you can use for work?", "Are you open to night
 * shifts?", "Which languages do you speak?" — and Naukri asks the same handful
 * across every posting. Nothing in the canonical vocabulary can hold those, so
 * they were reported as ⬜ unmapped every single time.
 *
 * The Answer Bank already stores what the user approved, keyed by the
 * normalised question (§3.6). This checks it for anything the cascade could not
 * place, which makes answering one a one-time cost rather than a per-application
 * one. It costs no network and no model.
 *
 * Only `unmapped` and `free-text` are eligible: a field skipped because the
 * profile is empty, or because EEO filling is off, has a *reason* to be blank
 * and a recalled answer must not paper over it.
 */
async function recallAnswers(plan: FillPlan, request: PlanRequest): Promise<FillPlan> {
  const eligible = plan.skipped.filter(
    (skip) => skip.reason === 'unmapped' || skip.reason === 'free-text',
  );
  if (eligible.length === 0) return plan;

  const labels = new Map(request.fields.map((field) => [field.id, field.displayLabel]));
  const company = request.pageContext?.company;

  const answers: AnsweredQuestion[] = [];
  const recalled = new Set<string>();

  for (const skip of eligible) {
    const question = labels.get(skip.fieldId);
    if (!question) continue;

    const stored = await findAnswer(question, company).catch((error: unknown) => {
      log.warn('could not read the answer bank', error);
      return undefined;
    });
    if (!stored?.answer) continue;

    answers.push({ fieldId: skip.fieldId, question, answer: stored.answer });
    recalled.add(skip.fieldId);
  }

  if (answers.length === 0) return plan;

  return {
    instructions: plan.instructions,
    skipped: plan.skipped.filter((skip) => !recalled.has(skip.fieldId)),
    answers,
  };
}
