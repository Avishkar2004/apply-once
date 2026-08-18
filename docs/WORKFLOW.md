# AutoFill — Workflow

How the product works at runtime, and how you work on it.

Design of record: [ARCHITECTURE.md](ARCHITECTURE.md).
The sync/web design (`WEB.md`) was removed from the tree; source comments still
cite it as `WEB.md §n` and it is recoverable with
`git show 89e8100:docs/WEB.md`.

---

## 1. Runtime workflow — what happens when you click Fill

```
scan → describe → map → plan → fill → verify → review → learn
```

| # | Step | Where | What it does |
|---|------|-------|--------------|
| 1 | **Scan** | [`core/scanner`](../extension/src/core/scanner) (content script) | Walks the document, open shadow roots and same-origin frames. Emits one `FieldDescriptor` per control; labels resolve through the seven-signal ladder, and every signal that resolves feeds the `labelBlob`. |
| 2 | **Map** | [`core/mapping`](../extension/src/core/mapping) (service worker) | Runs the four-tier cascade. Each field exits at the first tier that clears its confidence bar. |
| 3 | **Plan** | [`mapping/plan.ts`](../extension/src/core/mapping/plan.ts) | Resolves canonical keys against the decrypted profile. **The only place a profile value enters the pipeline** — the content script receives values only for the fields it is about to fill. |
| 4 | **Fill** | [`core/filler`](../extension/src/core/filler) | Writes through the prototype `value` setter, dispatches `input` + `change`, blurs. Sequential, 30–80 ms jitter. |
| 5 | **Verify** | [`core/verifier`](../extension/src/core/verifier) | Re-reads every field and classifies it ✅ / ⚠️ / ❌ / ⬜. |
| 6 | **Review** | [`ui/overlay`](../extension/src/ui/overlay) | Closed shadow-DOM panel lists everything that is not ✅. You fix and submit yourself. |
| 7 | **Learn** | [`core/learning`](../extension/src/core/learning) | Editing a row writes `(hostname, signature) → canonicalKey` at confidence 1.00, so Tier 0 catches it next time. |

### The mapping cascade (step 2)

| Tier | Source | Cost | Runs |
|------|--------|------|------|
| **0** | User overrides, then ATS adapters | ~0 ms | per field |
| **1** | `autocomplete` attribute, then an ordered rule table | ~0 ms | per field |
| **2** | On-device MiniLM embeddings | local compute | **once over all unknowns** |
| **3** | One batched LLM call | network + tokens | **once over all unknowns** |

Tiers 0 and 1 are pure lookups, so per-field is fine. Tiers 2 and 3 batch
because the embedder batches far better than N single labels, and the design
requires one LLM request per site rather than per field.

Both expensive tiers **degrade rather than fail**. No model on disk and no API
key means the cascade runs 0 → 1 and reports the rest as ⬜ skipped — a worse
fill, never a broken one.

### The free-text branch

Questions like "Why do you want to work here?" leave the pipeline at step 3 and
go to [`core/answers`](../extension/src/core/answers):

1. Check the **Answer Bank** — a hit is free and instant.
2. Only a miss reaches the model ([`llm/answer-draft.ts`](../extension/src/llm/answer-draft.ts)).
3. The draft appears in the overlay as **editable text**, never written silently.
4. Accepting it with one click is also what stores it for next time.

### The no-form branch

If the posting has no form, [`core/email`](../extension/src/core/email) detects
the apply-by-email address, drafts the mail, and tracks it.

### The sync loop (optional)

[`packages/core/src/sync/loop.ts`](../packages/core/src/sync/loop.ts), shared by
every client:

```
1. Push anything local the server has not acknowledged  (chunks of 500)
2. Pull everything new                                  (max 50 pages per run)
3. Rebuild projections for applications whose events changed
```

Rows are stored **sealed**, so the loop moves opaque envelopes and never holds
the key — sync works with the vault locked. The server ([`api/`](../api/))
stores bytes it cannot decrypt.

### Two invariants you cannot work around

- **Never auto-submits.** Every synthetic click goes through `safeClick`, which
  throws `AutoSubmitBlockedError` on a submit control. `form.submit()` and
  `requestSubmit()` are banned by ESLint and covered by unit tests.
- **No PII to the LLM for mapping.** Tier 3 sends labels and options, never
  values — enforced by an allowlist in
  [`toMappableField`](../extension/src/llm/field-mapping.ts). Answer *drafting*
  does send profile context, and says so next to the toggle that enables it.

---

## 2. Development workflow

### Setup (once)

```bash
npm install          # both workspaces + `wxt prepare`
npm run fetch:model  # optional, ~23MB of Tier 2 embedding assets
```

### The loop

```bash
npm run dev          # Chrome + HMR on the content script
```

Load `extension/.output/chrome-mv3` as an unpacked extension, open Options, set
a passphrase, **save the Recovery Kit**, fill in your profile.

There is no password reset. Losing the passphrase and the Recovery Kit loses the
vault — the server could not help even if it wanted to.

### Before you commit — all four must pass

```bash
npm run typecheck    # tsc across every workspace
npm run lint         # architectural guards, not just style
npm test             # 279 unit/fixture + 58 API tests in real workerd
npm run build        # the target actually builds
```

`eslint.config.js` enforces what the docs said to enforce rather than trusting
it: `packages/core` may not touch `chrome.*`, the DOM, or import
`wxt`/`dexie`/React; `localStorage`/`sessionStorage` are banned everywhere;
`form.submit()` is banned in the extension.

### Targeted test runs

```bash
npm run test:unit    # Vitest — extension + core
npm run test:api     # api/, inside real workerd against D1, KV and R2
npm run test:watch
```

### E2E (deliberately not in `npm test`)

```bash
npx playwright install chromium
npm run build
AUTOFILL_E2E_URL='https://job-boards.greenhouse.io/...' npm run test:e2e
```

Excluded because it needs a browser download, headed mode (MV3 extensions do not
load headless), and a live posting. Without the env var it skips.

### Shipping

```bash
npm run build          # .output/chrome-mv3
npm run build:firefox  # MV3 explicitly; WXT would default this target to MV2
npm run zip
npm run zip:firefox

npm run db:local --workspace api   # apply schema.sql to local D1
npm run deploy   --workspace api   # wrangler deploy
```

---

## 3. Common tasks

### A field maps wrong on a real site

1. Save the form's markup into [`extension/tests/e2e/fixtures/`](../extension/tests/e2e/fixtures/).
2. Assert the correct mapping in a test. **Every bug found in the wild becomes a fixture.**
3. Fix the cheapest tier that could have caught it — usually a phrasing in
   [`mapping/corpus.ts`](../extension/src/core/mapping/corpus.ts), not a new
   selector.

### Adding an ATS adapter

1. Add the host pattern to [`shared/hosts.ts`](../extension/src/shared/hosts.ts) —
   that one list feeds both `host_permissions` and the content-script matches.
2. Write `src/adapters/<name>.ts` implementing `AtsAdapter` and register it in
   `ADAPTERS`. The registry test checks your selectors parse and your keys exist.
3. Save a fixture and assert the mapping.

Adapters are accelerators, never requirements. A stale selector must degrade to
the generic cascade, not break the page.

### Changing the profile schema

Edit [`packages/core/src/schema/profile.ts`](../packages/core/src/schema/profile.ts)
and add a migration in
[`migrations.ts`](../packages/core/src/schema/migrations.ts). Existing vaults are
encrypted with the user's key, so the migration runs client-side after unlock.

### Changing crypto

Not casually. Changing the PBKDF2 iteration count in
[`crypto/derive.ts`](../packages/core/src/crypto/derive.ts) **invalidates every
existing vault**.

---

## 4. Where things live

```
packages/core/     shared, DOM-free, chrome-free — schema, crypto, sync, util
extension/
  entrypoints/     background (orchestrator), content (scan/fill/overlay),
                   options, sidepanel
  src/core/        scanner → mapping → filler → verifier → learning → answers
  src/adapters/    7 ATS adapters + registry, repeating, multi-step
  src/llm/         client, BYO key, prompts, Zod response schemas
  src/storage/     Dexie, vault/session, blobs, overrides, audit log
api/               zero-knowledge sync service — Hono on Cloudflare Workers
docs/              this file + ARCHITECTURE.md
```

`packages/core` exists because the crypto, schema and projector must be
byte-identical across clients.

---

## 5. Known gaps that shape the workflow

- **`docs/TRACKING.md` is missing** and load-bearing. The event schema and the
  projector live there, so `packages/core/tracker` and the sync client plus web
  app (W4–W8) are unspecified. The **server** is unaffected: it stores opaque
  envelopes and never needs to know what an event is.
- **Nothing here has been run in a browser.** Everything typechecks, lints,
  tests and builds — no Chrome has loaded it. The Tier 2 path (onnxruntime WASM
  in an MV3 service worker) is implemented to spec and unverified at runtime; it
  fails closed.
- **Résumé parsing handles PDF and plain text.** `.docx` needs another
  dependency and is not worth one yet.
- **The overlay uses a hand-written stylesheet, not Tailwind** — Tailwind v4's
  preflight and `:root` custom properties do not cross a shadow boundary
  reliably, and total isolation is the point of that panel.
