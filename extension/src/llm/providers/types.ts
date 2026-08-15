/**
 * The provider interface (ARCHITECTURE.md §7).
 *
 * Everything above this file — Tier 3 mapping, the Answer Generator, résumé
 * structuring, the email drafter — asks for a *completion*, never for a vendor.
 * One `complete()` call, one `{ text }` back. Providers differ wildly in wire
 * format (chat/completions vs `:generateContent` vs `/api/chat`), in how they
 * accept a JSON schema, and in whether they want a key at all; all of that is
 * absorbed here so no caller has to know which one is configured.
 *
 * Roles, not model names, are what callers name. `MODELS.drafting` used to be a
 * constant; it is now "the model configured for the drafting role on whichever
 * provider is selected", which is the only form that survives a user who wants a
 * free model instead of a paid one.
 */

/** What a call is *for*. Each provider maps these to its own model ids. */
export type LlmRole = 'mapping' | 'drafting' | 'parsing';

export const LLM_ROLES = ['mapping', 'drafting', 'parsing'] as const;

export type ProviderId = 'openrouter' | 'gemini' | 'groq' | 'ollama' | 'anthropic';

/**
 * Free-first. Nothing in AutoFill should require a billing account to work, and
 * a default that does would put a paywall in front of the product's core promise.
 *
 * Declared here rather than in the registry so that modules which only need the
 * *name* of a provider — settings, the message contract — do not pull five
 * provider implementations and a vendor SDK in behind it.
 */
export const DEFAULT_PROVIDER: ProviderId = 'openrouter';

export interface CompletionMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A JSON schema the model must answer in.
 *
 * Callers pass plain JSON Schema (`z.toJSONSchema(…)`) rather than a Zod object,
 * because only one of the five providers speaks Zod and every one of them speaks
 * JSON Schema in some dialect. Validation stays with the caller — the schema
 * here constrains generation, it does not replace `safeParse`.
 */
export interface JsonOutput {
  /** OpenAI-compatible APIs require the schema to be named. */
  name: string;
  schema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  messages: CompletionMessage[];
  maxTokens: number;
  json?: JsonOutput;
  /**
   * Extended-thinking budget. Honoured by providers that have the concept and
   * ignored by the rest — it is a quality hint, never a correctness requirement.
   */
  effort?: 'low' | 'medium' | 'high';
}

export interface CompletionResult {
  text: string;
}

/** What the user supplied. `apiKey` is absent for providers that need none. */
export interface ProviderCredentials {
  apiKey?: string;
  /** A self-hosted proxy or a non-default Ollama host. */
  baseUrl?: string;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** False for local providers — the "no-key" gate must not fire for those. */
  readonly needsKey: boolean;
  /** Where to get a key, shown in settings. */
  readonly keyUrl?: string;
  /** One line in the options page: what this provider costs. */
  readonly note: string;
  readonly defaultBaseUrl: string;
  /** Match pattern for the optional host permission. */
  readonly origin: string;
  /** Default model per role. Every one is overridable in settings. */
  readonly models: Readonly<Record<LlmRole, string>>;
  complete(request: CompletionRequest, credentials: ProviderCredentials): Promise<CompletionResult>;
}

/**
 * A provider said no.
 *
 * Kept separate from `LlmDisabledError` (which means "we never sent anything")
 * so the UI can tell a misconfiguration apart from a rejection, and carries the
 * status because 401 and 429 need different words in front of a user.
 */
export class LlmRequestError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'LlmRequestError';
  }
}

/**
 * Per-provider, per-role model overrides, as stored in settings.
 *
 * Keyed by provider so that trying Groq for an afternoon and going back does not
 * silently discard the model ids typed for the provider you came from.
 */
export type ModelOverrides = Partial<Record<ProviderId, Partial<Record<LlmRole, string>>>>;

/** A request that has not returned in this long is not going to be useful. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Strip a trailing slash so `${base}/v1/…` never doubles up. */
export function normaliseBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}
