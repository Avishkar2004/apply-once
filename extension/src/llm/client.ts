import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@/shared/logger';
import { getSettings } from '@/storage/settings';
import { hasApiHostPermission, readCredentials } from './credentials';

const log = createLogger('llm/client');

/**
 * The Anthropic client (ARCHITECTURE.md §7).
 *
 * Model assignment is the one in §3.6, verbatim:
 *   `claude-sonnet-5`  — answer drafts. Quality writing.
 *   `claude-haiku-4-5` — Tier 3 field mapping. "It is a classification task and
 *                        does not need the bigger model."
 *
 * `dangerouslyAllowBrowser` is required outside Node. The flag exists to stop
 * developers shipping *their* key to end users; here the key is the user's own,
 * sealed with their DEK on their machine, and the request goes direct to
 * Anthropic with no intermediary — which is exactly what §6.4 asks for.
 */

export const MODELS = {
  /** Tier 3 field mapping — classification (§3.6). */
  mapping: 'claude-haiku-4-5',
  /** Free-text answer drafts — quality writing (§3.6). */
  drafting: 'claude-sonnet-5',
  /** Résumé → profile structuring (§7). */
  parsing: 'claude-sonnet-5',
} as const;

/** 10 minutes is the SDK default; a field-mapping call that slow has already failed. */
const REQUEST_TIMEOUT_MS = 60_000;

export class LlmDisabledError extends Error {
  constructor(readonly reason: 'setting-off' | 'no-key' | 'no-permission' | 'locked') {
    super(
      {
        'setting-off': 'AI assistance is turned off in AutoFill settings.',
        'no-key': 'Add your Anthropic API key in AutoFill settings to enable AI assistance.',
        'no-permission': 'AutoFill needs permission to reach api.anthropic.com.',
        locked: 'Unlock AutoFill to use AI assistance.',
      }[reason],
    );
    this.name = 'LlmDisabledError';
  }
}

export interface LlmContext {
  client: Anthropic;
}

/**
 * Build a client, or explain precisely why we cannot.
 *
 * Every gate is checked here rather than at each call site, so "is the LLM
 * available?" has exactly one answer in the codebase.
 */
export async function getLlmContext(): Promise<LlmContext> {
  const settings = await getSettings();
  if (!settings.llmEnabled) throw new LlmDisabledError('setting-off');

  if (!(await hasApiHostPermission())) throw new LlmDisabledError('no-permission');

  const credentials = await readCredentials();
  if (!credentials?.apiKey) throw new LlmDisabledError('no-key');

  const client = new Anthropic({
    apiKey: credentials.apiKey,
    ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
    // See the note above: the key belongs to the user running this browser.
    dangerouslyAllowBrowser: true,
    // The SDK already retries 408/409/429/5xx with backoff.
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS, // milliseconds in the TypeScript SDK
  });

  return { client };
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
 * Turn an SDK error into something worth showing a person.
 *
 * Typed exception classes, most specific first — never string-matching on the
 * message, which changes without notice.
 */
export function describeLlmError(error: unknown): string {
  if (error instanceof LlmDisabledError) return error.message;

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
