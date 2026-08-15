import Anthropic from '@anthropic-ai/sdk';
import { toStrictJsonSchema } from './json-schema';
import { LlmRequestError, REQUEST_TIMEOUT_MS, type LlmProvider } from './types';

/**
 * Anthropic, through the official SDK — the original path, behaviour unchanged.
 *
 * Kept on the SDK rather than folded into the plain-`fetch` helper: it carries
 * the retry policy, the typed error classes `describeLlmError` branches on, and
 * the structured-output plumbing, and there is no reason to reimplement all
 * three to save a dependency that is already installed.
 *
 * `dangerouslyAllowBrowser` is required outside Node. The flag exists to stop
 * developers shipping *their* key to end users; here the key is the user's own,
 * sealed with their DEK on their machine, and the request goes direct to
 * Anthropic with no intermediary — which is what §6.4 asks for.
 */
export const anthropic: LlmProvider = {
  id: 'anthropic',
  label: 'Anthropic',
  needsKey: true,
  keyUrl: 'https://console.anthropic.com/settings/keys',
  note: 'Paid. Best drafting quality of the five.',
  defaultBaseUrl: 'https://api.anthropic.com',
  origin: 'https://api.anthropic.com/*',
  models: {
    /** Classification — it does not need the bigger model (§3.6). */
    mapping: 'claude-haiku-4-5',
    /** Quality writing (§3.6). */
    drafting: 'claude-sonnet-5',
    parsing: 'claude-sonnet-5',
  },

  async complete(request, credentials) {
    const client = new Anthropic({
      apiKey: credentials.apiKey ?? '',
      ...(credentials.baseUrl ? { baseURL: credentials.baseUrl } : {}),
      // See the note above: the key belongs to the user running this browser.
      dangerouslyAllowBrowser: true,
      // The SDK already retries 408/409/429/5xx with backoff.
      maxRetries: 2,
      timeout: REQUEST_TIMEOUT_MS, // milliseconds in the TypeScript SDK
    });

    const outputConfig = {
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.json
        ? { format: { type: 'json_schema' as const, schema: toStrictJsonSchema(request.json.schema) } }
        : {}),
    };

    const message = await client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      ...(request.system ? { system: request.system } : {}),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
      messages: request.messages,
    });

    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) throw new LlmRequestError('anthropic', undefined, 'The model returned nothing.');
    return { text };
  },
};
