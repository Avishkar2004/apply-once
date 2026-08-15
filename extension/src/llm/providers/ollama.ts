import { createLogger } from '@/shared/logger';
import { toStrictJsonSchema } from './json-schema';
import { describeStatus, postJson, readJson } from './openai-compatible';
import { LlmRequestError, normaliseBaseUrl, type LlmProvider } from './types';

const log = createLogger('llm/ollama');

/**
 * Ollama — a model running on this machine.
 *
 * `needsKey: false` is the load-bearing part: the "no-key" gate in `client.ts`
 * must not fire here, or a local provider would be unusable without inventing a
 * credential to satisfy a check that has nothing to check.
 *
 * Uses the native `/api/chat` rather than Ollama's OpenAI-compatible shim
 * because `format` accepts a JSON schema directly, which is what Tier 3 mapping
 * and résumé structuring need.
 *
 * Nothing leaves the device on this provider — worth knowing, given the Answer
 * Generator sends profile context (§6.3).
 */

interface OllamaResponse {
  message?: { content?: unknown };
  error?: string;
  done_reason?: string;
}

export const ollama: LlmProvider = {
  id: 'ollama',
  label: 'Ollama (local)',
  needsKey: false,
  note: 'Runs on this machine. No key, no cost, nothing leaves the device.',
  defaultBaseUrl: 'http://localhost:11434',
  // Chrome match patterns have no concept of a port, so the permission covers
  // localhost as a whole. `http://localhost:11434/*` is not a valid pattern and
  // is rejected at request time.
  origin: 'http://localhost/*',
  models: { mapping: 'llama3.2', drafting: 'llama3.2', parsing: 'llama3.2' },

  async complete(request, credentials) {
    const base = normaliseBaseUrl(credentials.baseUrl || this.defaultBaseUrl);
    const options = { provider: 'ollama' as const, url: `${base}/api/chat`, headers: {} };

    const response = await postJson(options, {
      model: request.model,
      messages: [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
        ...request.messages,
      ],
      stream: false,
      ...(request.json ? { format: toStrictJsonSchema(request.json.schema) } : {}),
      options: { num_predict: request.maxTokens },
    });

    const payload = (await readJson(response, 'ollama')) as OllamaResponse;
    if (payload.error) {
      throw new LlmRequestError('ollama', response.status, payload.error);
    }
    if (!response.ok) {
      throw new LlmRequestError('ollama', response.status, describeStatus(response.status));
    }

    const text = typeof payload.message?.content === 'string' ? payload.message.content.trim() : '';
    if (!text) {
      log.warn('ollama returned no text', payload.done_reason);
      throw new LlmRequestError('ollama', response.status, 'The model returned nothing.');
    }
    return { text };
  },
};
