import { chatCompletion } from './openai-compatible';
import { normaliseBaseUrl, type LlmProvider } from './types';

/**
 * OpenRouter — the default provider.
 *
 * Default because of the `:free` tier: AutoFill's whole promise is that you fill
 * in your details once and never type them again, and putting a billing account
 * between the user and that promise loses most of them at the first step. A free
 * model drafts a covering email perfectly well.
 *
 * Model ids are *not* hardcoded as a choice of one. Free-tier ids on OpenRouter
 * come and go on a timescale of weeks, so the default below is a starting point
 * and the options page lets any id be typed in its place.
 */

/** A free-tier id that is good enough for all three roles. Overridable. */
const FREE_MODEL = 'deepseek/deepseek-chat-v3-0324:free';

export const openrouter: LlmProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  needsKey: true,
  keyUrl: 'https://openrouter.ai/keys',
  note: 'Free models available — ids ending in ":free" cost nothing.',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  origin: 'https://openrouter.ai/*',
  models: { mapping: FREE_MODEL, drafting: FREE_MODEL, parsing: FREE_MODEL },

  complete(request, credentials) {
    const base = normaliseBaseUrl(credentials.baseUrl || this.defaultBaseUrl);
    return chatCompletion(request, {
      provider: 'openrouter',
      url: `${base}/chat/completions`,
      headers: {
        authorization: `Bearer ${credentials.apiKey ?? ''}`,
        // OpenRouter attributes requests by these; both are optional and neither
        // identifies the user.
        'http-referer': 'https://github.com/autofill',
        'x-title': 'AutoFill',
      },
    });
  },
};
