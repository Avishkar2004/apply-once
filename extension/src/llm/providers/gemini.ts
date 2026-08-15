import { createLogger } from '@/shared/logger';
import { toGeminiSchema } from './json-schema';
import { describeStatus, postJson, readJson } from './openai-compatible';
import { LlmRequestError, normaliseBaseUrl, type LlmProvider } from './types';

const log = createLogger('llm/gemini');

/**
 * Google's Generative Language API.
 *
 * The only provider here that is not OpenAI-shaped: the system prompt is a
 * separate `systemInstruction`, messages are `contents` with `parts`, and a JSON
 * schema goes in `generationConfig.responseSchema` in an OpenAPI 3.0 subset (see
 * `toGeminiSchema`).
 *
 * The key travels in the `x-goog-api-key` header rather than the `?key=` query
 * parameter the docs lead with. Both work; only one of them stays out of proxy
 * logs and browser history.
 */

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
    finishReason?: string;
  }>;
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

export const gemini: LlmProvider = {
  id: 'gemini',
  label: 'Google Gemini',
  needsKey: true,
  keyUrl: 'https://aistudio.google.com/apikey',
  note: 'Generous free tier from Google AI Studio.',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  origin: 'https://generativelanguage.googleapis.com/*',
  models: {
    mapping: 'gemini-2.0-flash',
    drafting: 'gemini-2.5-flash',
    parsing: 'gemini-2.5-flash',
  },

  async complete(request, credentials) {
    const base = normaliseBaseUrl(credentials.baseUrl || this.defaultBaseUrl);
    const url = `${base}/models/${encodeURIComponent(request.model)}:generateContent`;

    const generationConfig: Record<string, unknown> = { maxOutputTokens: request.maxTokens };
    if (request.json) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = toGeminiSchema(request.json.schema);
    }

    const options = {
      provider: 'gemini' as const,
      url,
      headers: { 'x-goog-api-key': credentials.apiKey ?? '' },
    };

    const response = await postJson(options, {
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      contents: request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig,
    });

    const payload = (await readJson(response, 'gemini')) as GeminiResponse;
    if (payload.error) {
      throw new LlmRequestError(
        'gemini',
        response.status,
        payload.error.message ?? describeStatus(response.status),
      );
    }
    if (!response.ok) {
      throw new LlmRequestError('gemini', response.status, describeStatus(response.status));
    }

    // A safety filter returns 200 with no candidate. Say so rather than
    // reporting "the model returned nothing", which sends the user hunting for
    // a network fault that is not there.
    const blocked = payload.promptFeedback?.blockReason;
    if (blocked) {
      throw new LlmRequestError('gemini', response.status, `Gemini blocked that request (${blocked}).`);
    }

    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();

    if (!text) {
      log.warn('gemini returned no text', candidate?.finishReason);
      throw new LlmRequestError('gemini', response.status, 'The model returned nothing.');
    }
    return { text };
  },
};
