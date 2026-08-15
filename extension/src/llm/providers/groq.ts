import { chatCompletion } from './openai-compatible';
import { normaliseBaseUrl, type LlmProvider } from './types';

/**
 * Groq — OpenAI-compatible, and fast enough that Tier 3 mapping stops being a
 * visible pause in the fill. Its free tier is rate-limited rather than paid,
 * which suits a per-site mapping call better than a per-keystroke one.
 */
export const groq: LlmProvider = {
  id: 'groq',
  label: 'Groq',
  needsKey: true,
  keyUrl: 'https://console.groq.com/keys',
  note: 'Free tier with rate limits. Very fast.',
  defaultBaseUrl: 'https://api.groq.com/openai/v1',
  origin: 'https://api.groq.com/*',
  models: {
    // Mapping is classification — the small model is the right tool and the
    // cheap one, exactly as it is on Anthropic.
    mapping: 'llama-3.1-8b-instant',
    drafting: 'llama-3.3-70b-versatile',
    parsing: 'llama-3.3-70b-versatile',
  },

  complete(request, credentials) {
    const base = normaliseBaseUrl(credentials.baseUrl || this.defaultBaseUrl);
    return chatCompletion(request, {
      provider: 'groq',
      url: `${base}/chat/completions`,
      headers: { authorization: `Bearer ${credentials.apiKey ?? ''}` },
    });
  },
};
