# AutoFill

A browser extension that fills job application forms from a profile you maintain
once. You click **Fill**, it detects every field, maps each one to your data,
fills it, and shows you what it filled and what it could not. You review, fix
anything wrong, and submit yourself.

**It never auto-submits.** That is architectural, not a setting — see
[§ No auto-submit](#no-auto-submit).

Design documents: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/WEB.md](docs/WEB.md)

---

## Status

Every milestone in ARCHITECTURE.md §9 is implemented.

| M | Scope | State |
|---|-------|-------|
| **M0** | WXT skeleton, Zod schema, profile editor, encrypted IndexedDB | ✅ |
| **M1** | Scanner + Tier 0/1 mapping + fill executor + Greenhouse & Lever adapters | ✅ |
| **M2** | Verifier, review overlay, learned overrides | ✅ |
| **M3** | Tier 2 embeddings + Tier 3 LLM mapping + cache | ✅ |
| **M4** | Answer Bank + LLM drafts for free-text | ✅ |
| **M5** | Workday, iCIMS, shadow DOM, multi-step wizards | ✅ |
| **M6** | Résumé parsing → profile bootstrap | ✅ |
| **M6** | Optional sync | ✅ server side — see [`api/`](api/) |

Beyond the milestone table, §6.8's audit log, §10's accuracy tracking and §11's
90-day profile-drift nudge are implemented.

WEB.md: **W1** (`packages/core`), **W2** (MUK/DEK hierarchy, Recovery Kit,
passphrase rotation) and **W3** (the sync service in [`api/`](api/)) are done.
**W4–W8** are blocked — see [Known gaps](#known-gaps).

Both expensive tiers degrade rather than fail. No embedding model on disk and no
API key means the cascade runs Tier 0 → Tier 1 and reports the rest as ⬜
skipped, which is a worse fill but never a broken one.

---

## Getting started

```bash
npm install          # installs both workspaces and runs `wxt prepare`
npm run fetch:model  # optional: ~23MB of Tier 2 embedding assets
npm run dev          # Chrome, with HMR for the content script
npm run build        # .output/chrome-mv3
npm run build:firefox
npm test             # Vitest — unit + fixture integration
npm run test:e2e     # Playwright — needs a browser and a live posting, see below
npm run typecheck
npm run lint
```

Then load `extension/.output/chrome-mv3` as an unpacked extension, open the
options page, set a passphrase, **save the Recovery Kit**, and fill in your
profile.

### Optional: AI assistance

Tiers 0 and 1 need nothing. The two expensive tiers are opt-in:

- **Tier 2 (on-device)** — `npm run fetch:model` downloads a quantized
  MiniLM-L6-v2 into `extension/public/`. It runs offline, costs nothing per
  field, and matches reworded labels the rule table misses.
- **Tier 3 and answer drafts** — Options → **AI** → paste your own Anthropic API
  key. The key is encrypted with your passphrase, the host permission for
  `api.anthropic.com` is optional and requested from that button, and requests
  go directly from your browser to Anthropic with no intermediary.

---

## Layout

```
AutoFill/
├── docs/                        # the design documents this implements
├── packages/
│   └── core/                    # shared, DOM-free, chrome-free (WEB.md §9)
│       └── src/
│           ├── schema/          # Zod profile, canonical keys, migrations, resolver
│           ├── crypto/          # derive, wrap, seal, open, recovery, vault
│           └── util/            # text, hash, date
├── extension/
│   ├── wxt.config.ts
│   ├── entrypoints/
│   │   ├── background.ts        # service worker — orchestrator
│   │   ├── content.ts           # scanner + filler + overlay
│   │   ├── options/             # React: profile editor, settings, activity
│   │   └── sidepanel/           # React: live fill status
│   ├── src/
│   │   ├── core/
│   │   │   ├── scanner/         # DOM walk, labels, descriptors, page context
│   │   │   ├── mapping/         # tiers 0-3, cascade, corpus, plan builder
│   │   │   ├── filler/          # native setters, per-kind strategies, guards
│   │   │   ├── verifier/        # post-fill diffing
│   │   │   ├── learning/        # override capture
│   │   │   ├── answers/         # Answer Bank + draft flow
│   │   │   ├── session/         # the per-page fill session
│   │   │   └── orchestrator/    # worker-side: profile + cascade + plan
│   │   ├── adapters/            # 7 ATS adapters, registry, repeating, multi-step
│   │   ├── llm/                 # client, BYO key, prompts, Zod response schemas
│   │   ├── documents/           # résumé text extraction (pdf.js)
│   │   ├── storage/             # Dexie, vault/session, blobs, overrides, audit
│   │   ├── shared/              # types, message contract, hosts, logger
│   │   └── ui/                  # overlay (shadow DOM), components, options
│   └── tests/
│       ├── unit/
│       └── e2e/
│           ├── fixtures/        # saved application markup — the regression suite
│           └── specs/           # Playwright, against a live board
├── api/                         # zero-knowledge sync service (WEB.md W3)
│   ├── src/{auth,routes}/       # Hono on Cloudflare Workers
│   ├── schema.sql               # D1, verbatim from WEB.md §8
│   └── tests/                   # 58 tests in real workerd
├── scripts/fetch-model.mjs      # Tier 2 embedding assets
└── eslint.config.js             # architectural guards, not just style
```

`packages/core` exists because the crypto, schema and projector must be
byte-identical across clients (WEB.md §9). It is adopted from the start rather
than extracted later, since a retrofit would mean rewriting every import.

---

## How a fill works

```
scan → describe → map (in the worker) → fill → verify → review → learn
```

1. **Scan** ([`core/scanner`](extension/src/core/scanner)) walks the document,
   open shadow roots and same-origin frames, and emits a `FieldDescriptor` per
   control. Labels resolve through the seven-signal ladder of §3.1; every signal
   that resolves feeds the `labelBlob`, because a weak signal often disambiguates
   a strong one.
2. **Map** ([`core/mapping`](extension/src/core/mapping)) runs the cascade in the
   service worker. Tier 0 is user overrides then ATS adapters; Tier 1 is the
   `autocomplete` attribute then an ordered rule table; Tier 2 is on-device
   embeddings; Tier 3 is one batched LLM call. A field exits at the first tier
   that clears its bar. Tiers 0 and 1 run per field because they are pure
   lookups; **2 and 3 run once over everything still unknown**, because the
   embedder batches far better than N single labels and §11 requires one LLM
   request per site rather than per field.
3. **Plan** resolves canonical keys against the decrypted profile. **This is the
   only place a profile value enters the pipeline**, and it runs where the key
   lives — the content script receives values only for the fields it is about to
   fill.
4. **Fill** ([`core/filler`](extension/src/core/filler)) writes through the
   prototype `value` setter, dispatches `input` + `change`, and blurs. Sequential,
   30–80 ms jitter.
5. **Verify** ([`core/verifier`](extension/src/core/verifier)) re-reads every
   field and classifies it ✅ / ⚠️ / ❌ / ⬜.
6. **Review** — a closed shadow-DOM panel lists everything that is not ✅.
7. **Learn** — editing a row writes `(hostname, signature) → canonicalKey` at
   confidence 1.00, so Tier 0 catches it on the next application to that site.

Free-text questions ("Why do you want to work here?") leave that pipeline at
step 3 and go to the **Answer Generator**
([`core/answers`](extension/src/core/answers)): the Answer Bank is checked first
— a hit is free and instant — and only a miss reaches the model. Drafts are
never written silently; they appear in the overlay as editable text and take one
click to accept, which is also what stores them for next time.

### Why the native setter

`el.value = x` does not work on React. React caches the last value it set on the
node; a direct assignment leaves that cache stale, `onChange` never fires, and
the field reverts on the next render or submits empty. Calling the *prototype's*
setter bypasses the tracker. It is applied unconditionally — it is correct on
plain HTML, Vue and Angular too. `native-setter.ts` is the only place values are
written.

<a id="no-auto-submit"></a>
### No auto-submit

Every synthetic click in the filler goes through `safeClick`, which throws
`AutoSubmitBlockedError` on a submit control. There is no setting, no
confirmation dialog and no code path around it. `form.submit()` and
`requestSubmit()` are banned by an ESLint rule, and the invariant is covered by
unit tests.

---

## Security

| | |
|---|---|
| **Local-first** | Profile, documents and answers live in IndexedDB on your machine. No backend is required. |
| **Encrypted at rest** | AES-GCM via WebCrypto. The key is derived from your passphrase with PBKDF2-SHA256 at 600,000 iterations. |
| **Key hierarchy** | Passphrase → MUK (wraps) → DEK (encrypts). Changing your passphrase re-wraps one row instead of re-encrypting everything. |
| **Recovery Kit** | 8 groups of 4 base32 characters, shown once at setup. There is no password reset; the server could not help even if there were one. |
| **PII never reaches an LLM for mapping** | Tier 3 sends field labels and options, never values — enforced by an explicit allowlist in [`toMappableField`](extension/src/llm/field-mapping.ts) and covered by tests. Answer drafting *does* send profile context, and says so next to the toggle that enables it. |
| **Your own key, no intermediary** | The Anthropic key is sealed with your DEK. `api.anthropic.com` is an **optional** host permission, requested from a button and revoked when you remove the key. |
| **Least privilege** | `activeTab` + explicit host permissions for known ATS domains. No `<all_urls>`. |
| **Audit log** | Every fill records site, timestamp and counts — never labels or values. Viewable and clearable in Settings. |

### Two deliberate deviations, stated plainly

**1. Where the unlock key lives.** ARCHITECTURE.md §6.2 asks for
"service-worker memory only". Manifest V3 evicts an idle service worker after
about 30 seconds, which would mean re-typing the passphrase for every fill. The
`CryptoKey` is therefore held in a module variable *and* mirrored into
`chrome.storage.session`, which is memory-backed, cleared when the browser
closes, unreadable from content scripts, and never written to disk. This widens
the boundary from "worker memory" to "extension-process memory". Anything
stronger costs a passphrase prompt per fill, which nobody would use. See
[`storage/session.ts`](extension/src/storage/session.ts).

**2. What is left unencrypted.** `overrides` and `mappingCache` are stored in the
clear. They hold hostnames, field signatures and canonical *key names* — no
profile values — and Tier 0 is specified at ~0 ms, which a per-lookup decrypt
would not be. `profile`, `documents` and `answerBank` are always encrypted.

---

## Testing

```bash
npm test
```

337 tests: 279 unit and fixture tests in the workspace, plus 58 API tests that
run inside a real `workerd` against real D1, KV and R2.

```bash
npm test        # both suites
npm run test:unit
npm run test:api
```

- **Unit** — label resolution against DOM snippets; the rule table against a
  labelled corpus; option and date normalisation; the crypto round-trip; the
  no-auto-submit invariant; the Tier 3 payload allowlist; résumé-merge
  idempotence; per-site accuracy maths.
- **Fixture integration** — saved application markup in
  [`extension/tests/e2e/fixtures/`](extension/tests/e2e/fixtures/), run through
  the real pipeline with the mapping output asserted. This is the regression
  suite: **every bug found in the wild becomes a fixture.**
- **Adapter integrity** — every selector in all seven adapters is parsed, and
  every mapped value is checked against the canonical vocabulary. A typo in a
  Workday selector fails at build time rather than on someone's application.
- **API integration** — the sync service runs in real `workerd`, not against
  mocks. The two things most likely to be wrong there are the per-user `seq`
  counter under D1's batch semantics and the tenant-isolation predicate on every
  query, and neither is observable against a fake database.

```bash
npx playwright install chromium
npm run build
AUTOFILL_E2E_URL='https://job-boards.greenhouse.io/…' npm run test:e2e
```

The Playwright suite ([`tests/e2e/specs/`](extension/tests/e2e/specs/)) drives a
real board in a real browser and asserts the DOM *after* the page has had time
to re-render — the one layer that catches framework-revert bugs. It is excluded
from `npm test` because it needs a browser download, headed mode (MV3 extensions
do not load headless), and a live posting; without `AUTOFILL_E2E_URL` it skips.
**It has not been executed in this environment** — no browser binary and no live
posting to point it at.

### Architectural lint rules

`eslint.config.js` enforces what the docs said to enforce rather than trust:

- `packages/core` may not touch `chrome.*`, the DOM, or import `wxt`/`dexie`/React (WEB.md §9)
- `localStorage` and `sessionStorage` are banned everywhere (WEB.md §12)
- `form.submit()` / `requestSubmit()` are banned in the extension (ARCHITECTURE.md §6.7)

---

## Adding an ATS adapter

Adapters are accelerators, never requirements — the generic cascade is the floor,
and a stale selector must degrade to it rather than break the page. Coverage is
deliberately uneven for that reason: Greenhouse, Lever, Ashby, SmartRecruiters
and Workday map real selectors, while iCIMS and Taleo generate their ids per
tenant, so their adapters claim the page, record the quirks, and let labels do
the work.

1. Add the host pattern to [`src/shared/hosts.ts`](extension/src/shared/hosts.ts).
   That one list feeds both `host_permissions` and the content-script matches.
2. Write `src/adapters/<name>.ts` implementing `AtsAdapter`, and register it in
   `ADAPTERS`. The registry test will check your selectors parse and your keys
   are real.
3. Save a form capture into `tests/e2e/fixtures/` and assert the mapping.

For a Tier 2 miss — a field whose label is worded in a way the embedder does not
recognise — the cheapest fix is usually a phrasing in
[`mapping/corpus.ts`](extension/src/core/mapping/corpus.ts), not a new selector.

---

<a id="known-gaps"></a>
## Known gaps

- **`docs/TRACKING.md` is missing**, and it is load-bearing for the rest of
  WEB.md. The event *schema* is TRACK §3.3 and the projector (`deriveStatus`) is
  TRACK §3.4; the web routes are the queue and board of TRACK §8 and the
  analytics of TRACK §10. So `packages/core/tracker` and **W4–W8** — the sync
  client and the web app — are unspecified and unimplemented.
  - The **server** (W3) is deliberately unaffected: it stores opaque envelopes,
    so it never needs to know what an event *is*. That is why it could be built
    without the missing document.
- **The LLM-proxy half of §7's optional backend is not built.** The LLM client
  accepts a `baseUrl` override, so a proxy can be pointed at once one exists;
  nothing serves that endpoint today. Direct browser → Anthropic with the user's
  own key is the documented default anyway (§6.4).
- **Nothing here has been run in a browser.** Everything is typechecked, linted,
  unit- and fixture-tested, and both targets build — but no Chrome has loaded
  the extension. The Tier 2 embedding path in particular (onnxruntime WASM
  inside an MV3 service worker) is implemented to spec and unverified at
  runtime; it fails closed if the assets or the runtime are unavailable.
- **Résumé parsing handles PDF and plain text.** `.docx` is a zip of XML and
  would need another dependency; it is not worth one until someone asks.
- **The overlay uses a hand-written stylesheet, not Tailwind.** Tailwind v4's
  preflight and `:root` custom properties do not cross a shadow boundary
  reliably, and total isolation is the whole point of that panel. The options
  page and side panel are ordinary documents and do use Tailwind.
- **The Firefox build targets MV3 explicitly** (`--mv3`); WXT would otherwise
  default that target to MV2.
