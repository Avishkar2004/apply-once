import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealJson } from '@autofill/core';
import {
  PROVIDERS,
  PROVIDER_IDS,
  getProvider,
  originForProvider,
  resolveModel,
  LlmRequestError,
  type CompletionRequest,
} from '@/llm/providers';
import { getLlmContext, LlmDisabledError, complete, parseJsonOutput } from '@/llm/client';
import { withQuotaAdvice } from '@/llm/providers/openai-compatible';
import {
  clearApiKey,
  readCredentials,
  requestApiHostPermission,
  revokeApiHostPermission,
  setApiKey,
  storedKeyProvider,
} from '@/llm/credentials';
import { db } from '@/storage/db';
import { createSession, requireDek, sessionStatus, unlockSession } from '@/storage/session';
import { setSettings } from '@/storage/settings';

/**
 * The provider layer (ARCHITECTURE.md §7).
 *
 * One `complete()` call has to work against five wire formats that agree on
 * almost nothing: OpenAI-shaped `chat/completions`, Gemini's `:generateContent`,
 * Ollama's `/api/chat`, and the Anthropic SDK. These tests pin the request each
 * one builds and the response each one reads, because a provider that silently
 * sends the wrong body does not fail — it returns a plausible answer to a
 * question nobody asked.
 *
 * Two rules are load-bearing rather than incidental:
 *
 *  - Ollama needs no key, so the "no-key" gate must not fire for it. Otherwise a
 *    local model would be unusable without inventing a credential.
 *  - A key issued by one vendor is never sent to another. Switching the provider
 *    dropdown must ask for a new key, not reuse the one already stored.
 */

const PASSPHRASE = 'correct horse battery staple';
const REQUEST: Omit<CompletionRequest, 'model'> = {
  system: 'You are terse.',
  messages: [{ role: 'user', content: 'Say hi.' }],
  maxTokens: 64,
};

/** Captures the fetch a provider makes and answers with a canned body. */
function stubFetch(body: unknown, init: { status?: number } = {}) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The JSON body of the single request a provider made. */
function sentBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentUrl(fetchMock: ReturnType<typeof stubFetch>): string {
  return String((fetchMock.mock.calls[0] as unknown as [string])[0]);
}

function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return (init.headers ?? {}) as Record<string, string>;
}

// Deriving a key is 600k PBKDF2 rounds; once for the file, not once per test.
beforeAll(async () => {
  if ((await sessionStatus()).hasVault) await unlockSession(PASSPHRASE);
  else await createSession(PASSPHRASE);
});

beforeEach(async () => {
  await clearApiKey();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the registry', () => {
  it('exposes every provider the settings page can offer', () => {
    expect(PROVIDER_IDS).toEqual(['openrouter', 'gemini', 'groq', 'ollama', 'anthropic']);
  });

  it('defaults to a free model on the default provider', () => {
    // §7 — nothing in AutoFill should require a billing account to work.
    for (const role of ['mapping', 'drafting', 'parsing'] as const) {
      expect(PROVIDERS.openrouter.models[role]).toMatch(/:free$/);
    }
  });

  it('keeps the documented Anthropic assignment (§3.6)', () => {
    expect(PROVIDERS.anthropic.models.mapping).toBe('claude-haiku-4-5');
    expect(PROVIDERS.anthropic.models.drafting).toBe('claude-sonnet-5');
  });

  it('falls back to the default rather than throwing on an unknown id', () => {
    expect(getProvider('does-not-exist').id).toBe('openrouter');
    expect(getProvider(undefined).id).toBe('openrouter');
  });

  it('lets any model id be typed in place of a default', () => {
    const overrides = { openrouter: { drafting: 'meta-llama/llama-3.3-70b-instruct:free' } };
    expect(resolveModel(PROVIDERS.openrouter, 'drafting', overrides)).toBe(
      'meta-llama/llama-3.3-70b-instruct:free',
    );
    // A blank override is not an override.
    expect(resolveModel(PROVIDERS.openrouter, 'mapping', { openrouter: { mapping: '  ' } })).toBe(
      PROVIDERS.openrouter.models.mapping,
    );
  });

  it('asks for the origin it will actually call, without a port', () => {
    expect(originForProvider('groq')).toBe('https://api.groq.com/*');
    // Match patterns cannot carry a port — one that does is rejected outright.
    expect(originForProvider('ollama', 'http://localhost:11434')).toBe('http://localhost/*');
    expect(originForProvider('anthropic', 'https://proxy.example.com/v1')).toBe(
      'https://proxy.example.com/*',
    );
  });
});

describe('openrouter', () => {
  it('posts an OpenAI-shaped body with a bearer key', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: 'hi' } }] });

    const result = await PROVIDERS.openrouter.complete(
      { ...REQUEST, model: 'deepseek/deepseek-chat-v3-0324:free' },
      { apiKey: 'sk-or-test' },
    );

    expect(sentUrl(fetchMock)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sentHeaders(fetchMock).authorization).toBe('Bearer sk-or-test');
    expect(sentBody(fetchMock)).toMatchObject({
      model: 'deepseek/deepseek-chat-v3-0324:free',
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Say hi.' },
      ],
    });
    expect(result.text).toBe('hi');
  });

  it('sends a JSON schema as strict response_format', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: '{"ok":true}' } }] });

    await PROVIDERS.openrouter.complete(
      {
        ...REQUEST,
        model: 'x:free',
        json: { name: 'thing', schema: { $schema: 'draft', type: 'object' } },
      },
      { apiKey: 'k' },
    );

    expect(sentBody(fetchMock).response_format).toEqual({
      type: 'json_schema',
      // `$schema` is stripped — several gateways reject it outright.
      json_schema: { name: 'thing', strict: true, schema: { type: 'object' } },
    });
  });

  it('honours a self-hosted base URL', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: 'hi' } }] });
    await PROVIDERS.openrouter.complete(
      { ...REQUEST, model: 'm' },
      { apiKey: 'k', baseUrl: 'https://proxy.example.com/v1/' },
    );
    expect(sentUrl(fetchMock)).toBe('https://proxy.example.com/v1/chat/completions');
  });

  it('reports an error body that arrived with a 200', async () => {
    // Gateways do this routinely; a status check alone would read it as success.
    stubFetch({ error: { message: 'No endpoints found for that model.' } });

    await expect(
      PROVIDERS.openrouter.complete({ ...REQUEST, model: 'nope' }, { apiKey: 'k' }),
    ).rejects.toThrow(/No endpoints found/);
  });

  it('explains a rejected key rather than echoing a status code', async () => {
    stubFetch({}, { status: 401 });
    await expect(
      PROVIDERS.openrouter.complete({ ...REQUEST, model: 'm' }, { apiKey: 'bad' }),
    ).rejects.toThrow(/rejected/i);
  });
});

/**
 * Most free models have no native structured-output support, and OpenRouter
 * rejects the call rather than degrading. Left alone, that turned "use a free
 * model" — the product's default — into "Tier 3 mapping and résumé import
 * silently stop working".
 */
describe('a model that cannot take a JSON schema', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

  /** First call fails the way a gateway does; the second succeeds. */
  function stubRejectThenAccept(errorMessage: string) {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ error: { message: errorMessage } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('retries with the schema in the prompt instead of giving up', async () => {
    const fetchMock = stubRejectThenAccept(
      'No endpoints found that support structured outputs for this model.',
    );

    const result = await PROVIDERS.openrouter.complete(
      { ...REQUEST, model: 'free:free', json: { name: 'thing', schema } },
      { apiKey: 'k' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('{"ok":true}');

    const [, retryInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const retry = JSON.parse(String(retryInit.body)) as Record<string, unknown>;
    // The parameter is gone; the requirement is not.
    expect(retry.response_format).toBeUndefined();
    const system = (retry.messages as Array<{ role: string; content: string }>)[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('single JSON object');
    expect(system?.content).toContain('"ok"');
    // The caller's own instructions survive the rewrite.
    expect(system?.content).toContain('You are terse.');
  });

  it('recognises the several ways a gateway words the refusal', async () => {
    for (const wording of [
      'response_format is not supported by this model',
      'Invalid json_schema parameter',
      'This model does not support structured output',
    ]) {
      const fetchMock = stubRejectThenAccept(wording);
      await PROVIDERS.groq.complete(
        { ...REQUEST, model: 'm', json: { name: 'thing', schema } },
        { apiKey: 'k' },
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('does not retry a plain rejection, which would just fail twice', async () => {
    const fetchMock = stubRejectThenAccept('That API key is invalid.');

    await expect(
      PROVIDERS.openrouter.complete(
        { ...REQUEST, model: 'm', json: { name: 'thing', schema } },
        { apiKey: 'bad' },
      ),
    ).rejects.toThrow(/invalid/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request that never asked for a schema', async () => {
    const fetchMock = stubRejectThenAccept('response_format is not supported by this model');

    await expect(
      PROVIDERS.openrouter.complete({ ...REQUEST, model: 'm' }, { apiKey: 'k' }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not spend a second request on a quota that just ran out', async () => {
    // 429 says nothing about schemas, and retrying immediately burns the
    // allowance that had already gone.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      PROVIDERS.openrouter.complete(
        { ...REQUEST, model: 'x:free', json: { name: 'thing', schema } },
        { apiKey: 'k' },
      ),
    ).rejects.toThrow(/free-models-per-day/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Free models on OpenRouter share a daily allowance across *every* call this
 * extension makes. So the message shown when a draft fails is usually the bill
 * for a résumé import an hour earlier, and the provider's wording never says
 * what to do about it.
 */
describe('quota errors', () => {
  it('keeps the provider wording and adds what to do about it', () => {
    const advised = withQuotaAdvice(429, 'Rate limit exceeded: free-models-per-day.');
    expect(advised).toContain('Rate limit exceeded: free-models-per-day.');
    expect(advised).toContain('daily allowance');
    expect(advised).toMatch(/wait|paid model/i);
  });

  it('names an empty balance as an empty balance', () => {
    expect(withQuotaAdvice(402, 'Insufficient credits.')).toMatch(/out of credit/i);
  });

  it('leaves every other status alone', () => {
    expect(withQuotaAdvice(401, 'That API key was rejected.')).toBe('That API key was rejected.');
  });
});

/**
 * Models put prose around their JSON however firmly they are told not to. The
 * fence regex used to be anchored to the whole answer, so one "Here you go:"
 * threw away a perfectly good object and Tier 3 reported every field unmapped.
 */
describe('parseJsonOutput', () => {
  it('reads a bare object', () => {
    expect(parseJsonOutput('{"ok":true}')).toEqual({ ok: true });
  });

  it('reads a fenced object', () => {
    expect(parseJsonOutput('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('reads a fenced object with prose either side of it', () => {
    expect(parseJsonOutput('Here you go:\n```json\n{"ok":true}\n```\nHope that helps!')).toEqual({
      ok: true,
    });
  });

  it('reads an unfenced object with a preamble', () => {
    expect(parseJsonOutput('Sure. {"ok":true}')).toEqual({ ok: true });
  });

  it('returns undefined rather than throwing on prose', () => {
    expect(parseJsonOutput('I am afraid I cannot do that.')).toBeUndefined();
  });
});

describe('groq', () => {
  it('posts to its OpenAI-compatible endpoint', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: 'hi' } }] });

    const result = await PROVIDERS.groq.complete(
      { ...REQUEST, model: 'llama-3.1-8b-instant' },
      { apiKey: 'gsk-test' },
    );

    expect(sentUrl(fetchMock)).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(sentHeaders(fetchMock).authorization).toBe('Bearer gsk-test');
    expect(result.text).toBe('hi');
  });
});

describe('gemini', () => {
  it('posts contents + systemInstruction and keys by header', async () => {
    const fetchMock = stubFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    });

    const result = await PROVIDERS.gemini.complete(
      { ...REQUEST, model: 'gemini-2.5-flash' },
      { apiKey: 'AIza-test' },
    );

    expect(sentUrl(fetchMock)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    // Header, not `?key=` — a key in a URL ends up in logs and history.
    expect(sentHeaders(fetchMock)['x-goog-api-key']).toBe('AIza-test');
    expect(sentUrl(fetchMock)).not.toContain('AIza-test');

    expect(sentBody(fetchMock)).toMatchObject({
      systemInstruction: { parts: [{ text: 'You are terse.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Say hi.' }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    expect(result.text).toBe('hi');
  });

  it('converts a JSON schema to the OpenAPI subset it accepts', async () => {
    const fetchMock = stubFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });

    await PROVIDERS.gemini.complete(
      {
        ...REQUEST,
        model: 'gemini-2.0-flash',
        json: {
          name: 'thing',
          schema: {
            $schema: 'draft',
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
      { apiKey: 'k' },
    );

    const config = sentBody(fetchMock).generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseSchema).toEqual({
      // Upper case: the field is a protobuf enum, matched by name.
      type: 'OBJECT',
      properties: { name: { type: 'STRING' } },
      required: ['name'],
    });
  });

  it('names a safety block instead of reporting an empty answer', async () => {
    stubFetch({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(
      PROVIDERS.gemini.complete({ ...REQUEST, model: 'm' }, { apiKey: 'k' }),
    ).rejects.toThrow(/SAFETY/);
  });
});

describe('ollama', () => {
  it('posts to the native chat endpoint with no key at all', async () => {
    const fetchMock = stubFetch({ message: { content: 'hi' } });

    const result = await PROVIDERS.ollama.complete({ ...REQUEST, model: 'llama3.2' }, {});

    expect(sentUrl(fetchMock)).toBe('http://localhost:11434/api/chat');
    expect(sentHeaders(fetchMock).authorization).toBeUndefined();
    expect(sentBody(fetchMock)).toMatchObject({
      model: 'llama3.2',
      stream: false,
      options: { num_predict: 64 },
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Say hi.' },
      ],
    });
    expect(result.text).toBe('hi');
  });

  it('passes a JSON schema straight through as `format`', async () => {
    const fetchMock = stubFetch({ message: { content: '{}' } });
    await PROVIDERS.ollama.complete(
      { ...REQUEST, model: 'llama3.2', json: { name: 'x', schema: { type: 'object' } } },
      {},
    );
    expect(sentBody(fetchMock).format).toEqual({ type: 'object' });
  });

  it('surfaces a model that has not been pulled', async () => {
    stubFetch({ error: 'model "llama3.2" not found, try pulling it first' }, { status: 404 });
    await expect(PROVIDERS.ollama.complete({ ...REQUEST, model: 'llama3.2' }, {})).rejects.toThrow(
      /not found/,
    );
  });
});

describe('anthropic', () => {
  it('keeps the SDK path and reads its text blocks', async () => {
    const fetchMock = stubFetch({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const result = await PROVIDERS.anthropic.complete(
      { ...REQUEST, model: 'claude-sonnet-5' },
      { apiKey: 'sk-ant-test' },
    );

    expect(sentUrl(fetchMock)).toContain('api.anthropic.com');
    expect(sentBody(fetchMock)).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 64,
      system: 'You are terse.',
    });
    expect(result.text).toBe('hi');
  });
});

/**
 * Credentials (§6.4).
 *
 * The key is sealed with the DEK exactly as the profile is, and it now records
 * which vendor issued it — because sending an OpenRouter key to Groq is not a
 * degraded experience, it is leaking a bearer credential to a third party.
 */
describe('credentials', () => {
  it('round-trips a key with its provider', async () => {
    await setApiKey('groq', 'gsk-abc', 'https://proxy.example.com');

    expect(await readCredentials()).toMatchObject({
      provider: 'groq',
      apiKey: 'gsk-abc',
      baseUrl: 'https://proxy.example.com',
    });
    // Readable while locked, because the options page needs it before unlock.
    expect(await storedKeyProvider()).toBe('groq');
  });

  it('migrates a record written before providers existed', async () => {
    // The pre-provider shape: an API key and nothing else. It was, by
    // construction, an Anthropic key — that was the only provider there was.
    const dek = await requireDek();
    const sealed = await sealJson(dek, 'settings', 'llm:credentials', {
      apiKey: 'sk-ant-legacy',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await db().meta.put({ key: 'llm:credentials', value: sealed });

    expect(await readCredentials()).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-ant-legacy',
    });
    expect(await storedKeyProvider()).toBe('anthropic');
  });
});

/**
 * The gates in `client.ts` — the one place that answers "can we call a model?".
 */
describe('the availability gates', () => {
  it('refuses when AI assistance is switched off', async () => {
    await setSettings({ llmEnabled: false, llmProvider: 'openrouter' });
    await expect(getLlmContext()).rejects.toBeInstanceOf(LlmDisabledError);
  });

  it('asks for a key on a provider that needs one', async () => {
    await setSettings({ llmEnabled: true, llmProvider: 'openrouter' });
    await requestApiHostPermission(originForProvider('openrouter'));

    await expect(getLlmContext()).rejects.toMatchObject({ reason: 'no-key' });
  });

  it('does not fire the no-key gate for a local provider', async () => {
    await setSettings({ llmEnabled: true, llmProvider: 'ollama' });
    await requestApiHostPermission(originForProvider('ollama'));

    const context = await getLlmContext();
    expect(context.provider.id).toBe('ollama');
    expect(context.credentials.apiKey).toBeUndefined();
    expect(context.model('drafting')).toBe('llama3.2');
  });

  it('lets a keyless provider store a base URL and nothing else', async () => {
    // An Ollama on another machine is a URL and no key at all.
    await setApiKey('ollama', '', 'http://box.local:11434');
    await setSettings({ llmEnabled: true, llmProvider: 'ollama' });
    await requestApiHostPermission(originForProvider('ollama', 'http://box.local:11434'));

    const context = await getLlmContext();
    expect(context.credentials.baseUrl).toBe('http://box.local:11434');
    // Never an empty string — that would put a bare `Bearer ` on the wire.
    expect(context.credentials.apiKey).toBeUndefined();
  });

  it('never sends a key to the vendor that did not issue it', async () => {
    await setApiKey('openrouter', 'sk-or-test');
    await setSettings({ llmEnabled: true, llmProvider: 'groq' });
    await requestApiHostPermission(originForProvider('groq'));

    await expect(getLlmContext()).rejects.toMatchObject({ reason: 'wrong-provider' });
  });

  it('refuses without the host permission for the origin it would call', async () => {
    await setApiKey('groq', 'gsk-test');
    await setSettings({ llmEnabled: true, llmProvider: 'groq' });
    // Granted by an earlier test in this file — permissions are per-profile and
    // outlive a single call, which is exactly why this has to be taken away
    // explicitly rather than assumed absent.
    await revokeApiHostPermission(originForProvider('groq'));

    await expect(getLlmContext()).rejects.toMatchObject({ reason: 'no-permission' });
  });

  it('routes a role through the configured provider and model', async () => {
    await setApiKey('groq', 'gsk-test');
    await setSettings({
      llmEnabled: true,
      llmProvider: 'groq',
      llmModels: { groq: { drafting: 'llama-3.3-70b-versatile' } },
    });
    await requestApiHostPermission(originForProvider('groq'));

    const fetchMock = stubFetch({ choices: [{ message: { content: 'drafted' } }] });
    const result = await complete('drafting', REQUEST);

    expect(sentUrl(fetchMock)).toContain('api.groq.com');
    expect(sentBody(fetchMock).model).toBe('llama-3.3-70b-versatile');
    expect(result.text).toBe('drafted');
  });

  it('reports a transport failure as a provider error, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(PROVIDERS.groq.complete({ ...REQUEST, model: 'm' }, { apiKey: 'k' })).rejects.toBeInstanceOf(
      LlmRequestError,
    );
  });
});
