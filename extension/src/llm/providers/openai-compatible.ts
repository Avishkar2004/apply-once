import { createLogger } from '@/shared/logger';
import { toStrictJsonSchema } from './json-schema';
import {
  LlmRequestError,
  REQUEST_TIMEOUT_MS,
  type CompletionRequest,
  type CompletionResult,
  type ProviderId,
} from './types';

const log = createLogger('llm/openai-compatible');

/**
 * `POST /chat/completions` — the shape OpenRouter, Groq and most gateways speak.
 *
 * Plain `fetch`, no SDK. The Anthropic SDK is 200KB of retry logic and streaming
 * we do not use here, and adding four more vendor SDKs to a browser extension
 * bundle to send four nearly identical JSON bodies would be absurd.
 *
 * Two failure modes are handled that a naive caller misses:
 *
 *  - gateways routinely return HTTP 200 with `{"error": {...}}` in the body, so
 *    a status check alone is not enough;
 *  - `message.content` is sometimes an array of parts, or null beside a
 *    `reasoning` field, depending on which upstream model served the request.
 */

interface ChatChoice {
  message?: { content?: unknown };
  finish_reason?: string;
}

interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string; code?: unknown };
}

export interface ChatCallOptions {
  provider: ProviderId;
  /** Full URL of the completions endpoint. */
  url: string;
  headers: Record<string, string>;
}

function buildBody(request: CompletionRequest, useResponseFormat: boolean): Record<string, unknown> {
  // When the gateway will not take a schema, the schema goes in the prompt
  // instead. Same requirement, stated in the one language every model speaks.
  const system =
    !useResponseFormat && request.json
      ? [
          request.system,
          `Respond with a single JSON object matching this schema, and nothing else — no prose, no markdown fence:`,
          JSON.stringify(toStrictJsonSchema(request.json.schema)),
        ]
          .filter(Boolean)
          .join('\n\n')
      : request.system;

  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...request.messages,
    ],
    max_tokens: request.maxTokens,
  };

  if (useResponseFormat && request.json) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: request.json.name,
        strict: true,
        schema: toStrictJsonSchema(request.json.schema),
      },
    };
  }

  return body;
}

/**
 * Did the gateway refuse the schema itself, rather than the request?
 *
 * Most free models have no native structured-output support, and OpenRouter
 * rejects the call outright rather than degrading — which turned "use a free
 * model" into "Tier 3 and résumé import silently stop working". The refusal is
 * recognisable, and recoverable: ask again with the schema in the prompt.
 */
function rejectsStructuredOutput(response: Response, payload: ChatResponse): boolean {
  if (response.ok && !payload.error) return false;
  if (response.status >= 500) return false;
  // A rate limit or an empty balance says nothing about schemas, and retrying
  // immediately spends a second request against the quota that just ran out.
  if (response.status === 429 || response.status === 402) return false;

  const message = (payload.error?.message ?? '').toLowerCase();
  return (
    message.includes('response_format') ||
    message.includes('json_schema') ||
    message.includes('structured output') ||
    message.includes('json schema') ||
    // OpenRouter's wording when no upstream provider satisfies the requirement.
    (message.includes('no endpoints') && message.includes('support'))
  );
}

export async function chatCompletion(
  request: CompletionRequest,
  options: ChatCallOptions,
): Promise<CompletionResult> {
  let response = await postJson(options, buildBody(request, true));
  let payload = (await readJson(response, options.provider)) as ChatResponse;

  if (request.json && rejectsStructuredOutput(response, payload)) {
    log.info(
      `${options.provider}/${request.model} does not take a JSON schema; retrying with it in the prompt`,
    );
    response = await postJson(options, buildBody(request, false));
    payload = (await readJson(response, options.provider)) as ChatResponse;
  }

  if (payload.error) {
    const stated = payload.error.message ?? 'The provider rejected that request.';
    throw new LlmRequestError(options.provider, response.status, withQuotaAdvice(response.status, stated));
  }
  if (!response.ok) {
    throw new LlmRequestError(
      options.provider,
      response.status,
      withQuotaAdvice(response.status, describeStatus(response.status)),
    );
  }

  const choice = payload.choices?.[0];
  const text = readContent(choice?.message?.content);
  if (!text) {
    log.warn(`${options.provider} returned no text`, choice?.finish_reason);
    throw new LlmRequestError(options.provider, response.status, 'The model returned nothing.');
  }
  return { text };
}

/** `content` is a string on every provider that behaves, and parts on the rest. */
function readContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : typeof (part as { text?: unknown })?.text === 'string'
          ? (part as { text: string }).text
          : '',
    )
    .join('')
    .trim();
}

export async function postJson(
  options: ChatCallOptions,
  body: unknown,
): Promise<Response> {
  try {
    return await fetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A DNS failure, a blocked host permission, or the timeout above. None of
    // them carry a status, and all of them read as "could not reach it".
    const detail = error instanceof Error ? error.message : String(error);
    throw new LlmRequestError(options.provider, undefined, `Could not reach the provider (${detail}).`);
  }
}

export async function readJson(response: Response, provider: ProviderId): Promise<unknown> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LlmRequestError(
      provider,
      response.status,
      response.ok
        ? 'The provider returned something that was not JSON.'
        : describeStatus(response.status),
    );
  }
}

/**
 * A free-tier quota is the one failure a user can act on immediately, and the
 * provider's own wording never says how.
 *
 * Free models on OpenRouter share a per-day allowance across *every* call this
 * extension makes — field mapping, résumé parsing, drafting — so the message a
 * user sees when a draft fails is usually the bill for something else they did
 * an hour ago. Keep the provider's wording, which names the actual limit, and
 * add the part that tells them what to do.
 */
export function withQuotaAdvice(status: number, stated: string): string {
  if (status === 429) {
    return `${stated} Free models share a daily allowance — wait a minute, or set a paid model in AutoFill's AI settings.`;
  }
  if (status === 402) {
    return `${stated} That account is out of credit.`;
  }
  return stated;
}

export function describeStatus(status: number): string {
  if (status === 401 || status === 403) return 'That API key was rejected.';
  if (status === 404) return 'That model id does not exist on this provider.';
  if (status === 429) return 'Rate-limited. Try again in a moment.';
  if (status >= 500) return 'The provider is having trouble. Try again shortly.';
  return `The provider returned an error (${status}).`;
}
