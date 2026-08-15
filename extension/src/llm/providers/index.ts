import { anthropic } from './anthropic';
import { gemini } from './gemini';
import { groq } from './groq';
import { ollama } from './ollama';
import { openrouter } from './openrouter';
import {
  DEFAULT_PROVIDER,
  normaliseBaseUrl,
  type LlmProvider,
  type LlmRole,
  type ModelOverrides,
  type ProviderId,
} from './types';

export * from './types';

/**
 * The provider registry.
 *
 * Order is the order the options page lists them in: free first, paid last.
 * That is a deliberate default rather than a neutral one — nothing in AutoFill
 * should require a billing account to work.
 */
export const PROVIDERS: Readonly<Record<ProviderId, LlmProvider>> = {
  openrouter,
  gemini,
  groq,
  ollama,
  anthropic,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && value in PROVIDERS;
}

/** Unknown ids fall back to the default rather than throwing at call time. */
export function getProvider(id: string | undefined): LlmProvider {
  return isProviderId(id) ? PROVIDERS[id] : PROVIDERS[DEFAULT_PROVIDER];
}

/** Every origin that could ever be requested — the manifest's optional list. */
export const PROVIDER_ORIGINS = PROVIDER_IDS.map((id) => PROVIDERS[id].origin);

/**
 * Which origin to ask the browser for.
 *
 * A custom `baseUrl` — a self-hosted proxy, an Ollama on another machine —
 * means the provider's own origin is the wrong thing to request, and asking for
 * it would grant a permission that is never used while the one that *is* used
 * stays missing.
 */
export function originForProvider(id: string | undefined, baseUrl?: string): string {
  const provider = getProvider(id);
  if (!baseUrl?.trim()) return provider.origin;
  try {
    const url = new URL(normaliseBaseUrl(baseUrl.trim()));
    // Host only — a match pattern cannot carry a port, and one that does is
    // rejected by `permissions.request` rather than merely ignored.
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return provider.origin;
  }
}

/** The model actually used for a role: the user's override, else the default. */
export function resolveModel(
  provider: LlmProvider,
  role: LlmRole,
  overrides: ModelOverrides | undefined,
): string {
  const override = overrides?.[provider.id]?.[role]?.trim();
  return override || provider.models[role];
}
