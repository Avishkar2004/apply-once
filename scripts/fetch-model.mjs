#!/usr/bin/env node
/**
 * Fetch the Tier 2 embedding assets into `extension/public/`.
 *
 * ARCHITECTURE.md §7 specifies `@xenova/transformers` with a quantized
 * MiniLM-L6-v2 (~23MB), and §12.2 records the reason: "23MB of install weight
 * buys offline operation, zero latency, and no per-field cost."
 *
 * The assets are deliberately **not** committed — they are large, immutable,
 * and reproducible. Run this once after cloning:
 *
 *     npm run fetch:model
 *
 * Without them, Tier 2 reports itself unavailable and the mapping cascade runs
 * Tier 1 → Tier 3. Nothing breaks; unknown fields are just less well mapped.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`;

const PUBLIC_DIR = resolve(process.cwd(), 'extension/public');
const MODEL_DIR = join(PUBLIC_DIR, 'models', MODEL_ID);
const WASM_DIR = join(PUBLIC_DIR, 'wasm');

/** Exactly what transformers.js opens for a quantized feature-extraction pipeline. */
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

/** onnxruntime-web ships these next to its entry point. */
const WASM_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd.wasm',
  'ort-wasm.wasm',
  'ort-wasm-threaded.wasm',
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  if (await exists(destination)) {
    console.log(`  ✓ ${destination.replace(PUBLIC_DIR, 'public')} (cached)`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true });

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText} — ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));

  const { size } = await stat(destination);
  console.log(`  ↓ ${destination.replace(PUBLIC_DIR, 'public')} (${(size / 1e6).toFixed(1)} MB)`);
}

async function copyRuntimeWasm() {
  const require = createRequire(import.meta.url);
  let ortDir;
  try {
    ortDir = dirname(require.resolve('onnxruntime-web/package.json'));
  } catch {
    console.log('  ! onnxruntime-web not installed — skipping wasm copy');
    return;
  }

  const { copyFile } = await import('node:fs/promises');
  await mkdir(WASM_DIR, { recursive: true });
  for (const file of WASM_FILES) {
    const source = join(ortDir, 'dist', file);
    if (!(await exists(source))) continue;
    await copyFile(source, join(WASM_DIR, file));
    console.log(`  ✓ public/wasm/${file}`);
  }
}

console.log(`Fetching ${MODEL_ID} into extension/public/models …`);
for (const file of MODEL_FILES) {
  await download(`${HF_BASE}/${file}`, join(MODEL_DIR, file));
}

console.log('Copying onnxruntime wasm …');
await copyRuntimeWasm();

console.log('\nDone. Tier 2 (local embeddings) will initialise on the next fill.');
