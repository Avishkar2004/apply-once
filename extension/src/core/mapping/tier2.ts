import { browser } from 'wxt/browser';
import type { CanonicalKey } from '@autofill/core';
import type { FieldDescriptorDto } from '@/shared/types';
import { CONFIDENCE } from '@/shared/types';
import { createLogger } from '@/shared/logger';
import { db } from '@/storage/db';
import { buildCorpus, CORPUS_VERSION, type CorpusEntry } from './corpus';

const log = createLogger('mapping/tier2');

/**
 * Tier 2 — local embeddings (ARCHITECTURE.md §3.2).
 *
 * "A quantized MiniLM (~23MB) runs in the service worker via `transformers.js`.
 * Canonical field labels are embedded once at install and cached. Cosine-match
 * the `labelBlob` against them."
 *
 *   score ≥ 0.82 → accept
 *   0.60–0.82    → accept but mark low confidence (amber in the overlay)
 *   < 0.60       → fall through to Tier 3
 *
 * §12.2 is explicit that the 23MB buys offline operation and zero per-field
 * cost. The model is therefore loaded from extension-local files, never from
 * the network at fill time — `env.allowRemoteModels` is off. Run
 * `npm run fetch:model` once to place the assets; without them Tier 2 reports
 * itself unavailable and the cascade goes straight from Tier 1 to Tier 3.
 *
 * Loading is **never** on the critical path of a fill: `warmEmbeddings()`
 * returns whatever is ready right now and kicks off initialisation in the
 * background, so the first fill after install is fast and merely dumber.
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const VECTOR_CACHE_KEY = `tier2:vectors:${MODEL_ID}:v${CORPUS_VERSION}`;

/** MiniLM-L6-v2 produces 384-dimensional sentence embeddings. */
const DIMENSIONS = 384;

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  corpus: CorpusEntry[];
  vectors: Float32Array[];
}

type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable';

let state: LoadState = 'idle';
let embedder: Embedder | undefined;

/**
 * The embedder if it is resident, `undefined` otherwise — starting a background
 * load on first call. Callers must treat `undefined` as "Tier 2 is skipped this
 * time", not as an error.
 */
export async function warmEmbeddings(): Promise<Embedder | undefined> {
  if (state === 'ready') return embedder;
  if (state === 'idle') {
    state = 'loading';
    void initialise().catch((error: unknown) => {
      state = 'unavailable';
      log.info('local embeddings unavailable; Tier 2 disabled', error);
    });
  }
  return undefined;
}

/** Test seam / options-page reset. */
export function __resetEmbeddingsForTests(): void {
  state = 'idle';
  embedder = undefined;
}

export function embeddingsState(): LoadState {
  return state;
}

/**
 * WXT types `runtime.getURL` against the known contents of `public/`, which the
 * model assets are not part of until `npm run fetch:model` has run.
 */
function publicUrl(path: string): string {
  return browser.runtime.getURL(path as Parameters<typeof browser.runtime.getURL>[0]);
}

async function initialise(): Promise<void> {
  // Imported lazily so the ~1MB runtime is not parsed on every worker start.
  const { env, pipeline } = await import('@xenova/transformers');

  // Offline by contract (§12.2). Assets ship with the extension.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = publicUrl('models/');
  // A service worker has no worker pool to spawn threads into.
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = publicUrl('wasm/');

  const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });

  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const flat = output.data as Float32Array;
    return texts.map((_, index) => flat.slice(index * DIMENSIONS, (index + 1) * DIMENSIONS));
  };

  const corpus = buildCorpus();
  const vectors = await loadOrBuildVectors(corpus, embed);

  embedder = { embed, corpus, vectors };
  state = 'ready';
  log.info(`Tier 2 ready — ${corpus.length} canonical phrases embedded`);
}

/** Embed the corpus once and keep it; it changes only when the build does. */
async function loadOrBuildVectors(
  corpus: CorpusEntry[],
  embed: (texts: string[]) => Promise<Float32Array[]>,
): Promise<Float32Array[]> {
  const cached = await db().meta.get(VECTOR_CACHE_KEY);
  const stored = cached?.value as { count: number; bytes: Uint8Array } | undefined;

  if (stored && stored.count === corpus.length) {
    const floats = new Float32Array(
      stored.bytes.buffer.slice(
        stored.bytes.byteOffset,
        stored.bytes.byteOffset + stored.bytes.byteLength,
      ) as ArrayBuffer,
    );
    return corpus.map((_, index) => floats.slice(index * DIMENSIONS, (index + 1) * DIMENSIONS));
  }

  log.info(`embedding ${corpus.length} canonical phrases (first run)`);
  const vectors = await embed(corpus.map((entry) => entry.phrase));

  const packed = new Float32Array(vectors.length * DIMENSIONS);
  vectors.forEach((vector, index) => packed.set(vector, index * DIMENSIONS));
  await db().meta.put({
    key: VECTOR_CACHE_KEY,
    value: { count: corpus.length, bytes: new Uint8Array(packed.buffer) },
  });

  return vectors;
}

/**
 * Cosine similarity. The pipeline normalises its output, so the dot product is
 * the cosine — no division needed.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Match a batch of fields against the canonical corpus.
 *
 * Returns only hits at or above the documented floor; the cascade applies the
 * accept/low-confidence split, and the overlay colours anything under
 * `CONFIDENCE.reviewThreshold` amber.
 */
export async function matchByEmbedding(
  source: Embedder,
  fields: FieldDescriptorDto[],
): Promise<ReadonlyMap<string, { key: CanonicalKey; score: number }>> {
  const hits = new Map<string, { key: CanonicalKey; score: number }>();
  if (fields.length === 0) return hits;

  const queries = fields.map((field) => searchTextFor(field));
  const encoded = await source.embed(queries);

  fields.forEach((field, index) => {
    const vector = encoded[index];
    if (!vector) return;

    let best: { key: CanonicalKey; score: number } | undefined;
    source.vectors.forEach((candidate, entryIndex) => {
      const score = cosine(vector, candidate);
      if (!best || score > best.score) {
        best = { key: source.corpus[entryIndex]!.key, score };
      }
    });

    if (best && best.score >= CONFIDENCE.embeddingFloor) hits.set(field.id, best);
  });

  return hits;
}

/**
 * What actually gets embedded. The section heading is prepended because it is
 * the disambiguator §11 calls for — "Start date" alone is ambiguous, "education
 * start date" is not.
 */
function searchTextFor(field: FieldDescriptorDto): string {
  const parts = [field.sectionHeading, field.displayLabel || field.labelBlob].filter(Boolean);
  return parts.join(' ').toLowerCase().slice(0, 200);
}
