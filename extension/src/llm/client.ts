import Anthropic from '@anthropic-ai/sdk';
import { VaultLockedError } from '@autofill/core';
import { createLogger } from '@/shared/logger';
import { getSettings } from '@/storage/settings';
import { hasApiHostPermission, readCredentials } from './credentials';
import {
  getProvider,
  originForProvider,
  resolveModel,
  LlmRequestError,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  type LlmRole,
  type ProviderCredentials,
} from './providers';

const log = createLogger('llm/client');

/**
 * The one way to reach a model (ARCHITECTURE.md §7).
 *
 * Which vendor answers is a setting, not a compile-time fact: see
 * `llm/providers/`. This file owns the *gates* — is AI assistance on, is there a
 * key, does it belong to the selected provider, has the host permission been
 * granted — so "is the LLM available?" has exactly one answer in the codebase,
 * and so no caller can accidentally reach a provider around them.
 */

export class LlmDisabledError extends Error {
  constructor(
    readonly reason: 'setting-off' | 'no-key' | 'no-permission' | 'locked' | 'wrong-provider',
    detail?: string,
  ) {
    super(
      {
        'setting-off': 'AI assistance is turned off in AutoFill settings.',
        'no-key': detail
          ? `Add your ${detail} API key in AutoFill settings to enable AI assistance.`
          : 'Add an API key in AutoFill settings to enable AI assistance.',
        'no-permission': `AutoFill needs permission to reach ${detail ?? 'the AI provider'}.`,
        locked: 'Unlock AutoFill to use AI assistance.',
        'wrong-provider': `The stored key was issued for ${detail ?? 'another provider'}. Save a key for the provider you selected.`,
      }[reason],
    );
    this.name = 'LlmDisabledError';
  }
}

export interface LlmContext {
  provider: LlmProvider;
  credentials: ProviderCredentials;
  /** The model to use for each role, overrides already applied. */
  model: (role: LlmRole) => string;
}

/**
 * Resolve the configured provider, or explain precisely why we cannot.
 *
 * Credentials are read before the permission check so the origin we ask about is
 * the one we will actually call — a self-hosted proxy needs its own permission,
 * and checking the vendor's origin instead would report "granted" for a host we
 * never contact.
 */
export async function getLlmContext(): Promise<LlmContext> {
  const settings = await getSettings();
  if (!settings.llmEnabled) throw new LlmDisabledError('setting-off');

  const provider = getProvider(settings.llmProvider);
  const credentials = await loadCredentials(provider);

  const origin = originForProvider(provider.id, credentials.baseUrl);
  if (!(await hasApiHostPermission(origin))) {
    throw new LlmDisabledError('no-permission', origin.replace(/\/\*$/, ''));
  }

  return {
    provider,
    credentials,
    model: (role) => resolveModel(provider, role, settings.llmModels),
  };
}

/**
 * A keyless provider is not a provider without credentials — it may still carry
 * a custom base URL. It just must not be gated on a key it will never have, and
 * must not be gated on the vault either, since there is nothing sealed to read.
 */
async function loadCredentials(provider: LlmProvider): Promise<ProviderCredentials> {
  let stored;
  try {
    stored = await readCredentials();
  } catch (error) {
    if (error instanceof VaultLockedError) {
      if (!provider.needsKey) return {};
      throw new LlmDisabledError('locked');
    }
    throw error;
  }

  if (!stored) {
    if (!provider.needsKey) return {};
    throw new LlmDisabledError('no-key', provider.label);
  }

  // A key issued by one vendor is worthless to another and must never be sent
  // to it — switching the dropdown without saving a new key stops here.
  if (stored.provider !== provider.id) {
    if (!provider.needsKey) return {};
    throw new LlmDisabledError('wrong-provider', getProvider(stored.provider).label);
  }

  if (!stored.apiKey && provider.needsKey) {
    throw new LlmDisabledError('no-key', provider.label);
  }

  return {
    // Never an empty string: it would put `Bearer ` on the wire and turn a
    // configuration problem into a 401 from the provider.
    ...(stored.apiKey ? { apiKey: stored.apiKey } : {}),
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
  };
}

/**
 * Ask the configured provider for a completion.
 *
 * Callers name a *role* — mapping, drafting, parsing — and never a model id.
 * That is what lets one user run Tier 3 on a free OpenRouter model and another
 * on Claude without a single call site changing.
 */
export async function complete(
  role: LlmRole,
  request: Omit<CompletionRequest, 'model'>,
): Promise<CompletionResult> {
  const { provider, credentials, model } = await getLlmContext();
  const resolved = model(role);
  log.debug(`${role} → ${provider.id}/${resolved}`);
  return provider.complete({ ...request, model: resolved }, credentials);
}

/** True when the LLM tiers are usable right now. Never throws. */
export async function isLlmAvailable(): Promise<boolean> {
  try {
    await getLlmContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a provider error into something worth showing a person.
 *
 * Typed exception classes, most specific first — never string-matching on the
 * message, which changes without notice.
 */
export function describeLlmError(error: unknown): string {
  if (error instanceof LlmDisabledError) return error.message;
  if (error instanceof LlmRequestError) return error.message;

  if (error instanceof Anthropic.AuthenticationError) {
    return 'That Anthropic API key was rejected. Check it in AutoFill settings.';
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'This API key does not have access to the model AutoFill uses.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Anthropic rate-limited the request. Try again in a moment.';
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach Anthropic. Check your connection.';
  }
  if (error instanceof Anthropic.APIError) {
    log.warn('Anthropic API error', error.status, error.message);
    return `Anthropic returned an error (${error.status ?? 'unknown'}).`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a model's JSON answer, without throwing.
 *
 * Providers vary in how literally they take "return only JSON": some wrap it in
 * a ```json fence whatever the schema said. Stripping that here means every
 * structured caller gets the same tolerance instead of each rediscovering it.
 *
 * Returns `undefined` rather than throwing so the caller's `safeParse` is the
 * single place a malformed answer is handled — an unparseable response and one
 * that does not match the schema are the same failure with the same recovery.
 */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();

  // A fence anywhere, not only wrapping the whole answer: a model that writes
  // "Here you go:" before its ```json block, or a note after it, was producing
  // a parse failure over a perfectly good object.
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);

  for (const candidate of [fenced?.[1], trimmed, outermostBraces(trimmed)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next shape.
    }
  }

  log.warn('provider returned unparseable JSON');
  return undefined;
}

/** The `{…}` span, for an answer with prose either side of it. */
function outermostBraces(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : undefined;
}
