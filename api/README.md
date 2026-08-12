# AutoFill sync service

Zero-knowledge sync for the AutoFill event log. Implements **W3** of
[docs/WEB.md](../docs/WEB.md) §4, §7 and §8, and the sync half of
ARCHITECTURE.md §7's optional backend.

> "Deliberately small. It stores opaque bytes and hands them back."
> — WEB.md §8

The server cannot read anything it stores. Event payloads and blobs are AES-GCM
ciphertext sealed with a key derived on the client from a passphrase that never
leaves the device. §10: *"The server cannot learn which companies, which roles,
what you wrote, or whether you were rejected."*

---

## Endpoints

```
GET    /health

GET    /auth/salt?email=          → { salt }          fake-but-stable for unknown accounts
POST   /auth/signup               → 201 + session cookie
POST   /auth/login                → { salt, wrappedDek } + session cookie
POST   /auth/rotate               → re-wrap the DEK; signs out other devices
POST   /auth/logout
POST   /auth/logout-all

POST   /sync/push    { events }   → { assigned: [{id, seq}], highWater }
GET    /sync/pull    ?since&limit → { events, highWater, more }
GET    /sync/status               → { events, bytes, highWater, webAccess }

PUT    /blob/:hash   <bytes>      → 201 | 204 (already present)
GET    /blob/:hash                → encrypted bytes
DELETE /blob/:hash                → 204

GET    /account                   → { userId, email, webAccess, quota }
POST   /account/web-access        → { webAccess }
DELETE /account                   → deletes events, blobs and the account
```

Everything except `/health`, `/auth/salt`, `/auth/signup` and `/auth/login`
requires the session cookie. `/sync/*` and `/blob/*` additionally require web
access to be on.

---

## Setup

```bash
wrangler d1 create autofill
wrangler r2 bucket create autofill-blobs
wrangler kv namespace create SESSIONS
# paste the ids into wrangler.toml

wrangler secret put SERVER_SECRET     # 32+ random bytes
npm run db:remote                     # apply schema.sql
npm run deploy
```

Local development:

```bash
npm run db:local
npm run dev
npm test                              # 58 tests in real workerd
```

---

## How the protocol works

**Two endpoints and a watermark** (§4.2). Push is idempotent on the event id, so
a client that crashes mid-push simply pushes again and gets the original `seq`
back. Pull is a cursor walk; each client keeps its own `highWater` and there is
no server-side per-device state to corrupt.

`seq` comes from a per-user counter bumped in the same D1 batch as the insert.
§8: *"D1 serializes writes per database, so this is safe without additional
locking."* One batch is one implicit transaction, so a partial push cannot leave
the counter out of step with the rows.

There is no conflict handler because there are no conflicts. The event log is a
grow-only set with client-generated UUIDv7 ids; merge is union-then-dedup-by-id.
Ordering for correctness comes from `occurredAt` *inside* the ciphertext — never
from `seq`, which only reflects upload order.

---

## Security notes

| | |
|---|---|
| **Tenant isolation** | Every SQL statement is scoped by `user_id`; R2 keys are `${userId}/${hash}`. Two accounts can hold the same event id or blob hash independently — the primary key is `(user_id, id)`, not `id`. |
| **Auth key** | Received over TLS, stored only as a PBKDF2 hash with its own salt. The MUK — the half that actually decrypts anything — is never transmitted. |
| **Account-existence oracle** | `/auth/salt` returns a deterministic `HMAC(SERVER_SECRET, email)` salt for unknown accounts, and login burns an equivalent PBKDF2 derivation so latency does not answer the question either. |
| **Rate limiting** | 10 login attempts per 15 minutes, counted per account *and* per IP. |
| **Web access off** | §10's fourth mitigation for the JS-delivery problem: an account switch that makes the server refuse all sync reads. `/account` stays reachable so it is not a one-way door. |
| **Quota** | 50,000 events / 50 MB per account, enforced at push from running counters rather than `COUNT(*)`. |

### Documented deviation: PBKDF2, not scrypt

§3.1 says the server stores "a scrypt hash" of the auth key. The Workers runtime
has no scrypt, and a pure-JS scrypt on the request path is a CPU-time DoS. This
uses PBKDF2-SHA256 at 100k iterations instead.

The substitution is sound *for this specific value*: the auth key is not a human
password but 256 bits of high-entropy output from a 600k-iteration client-side
PBKDF2. There is no dictionary to attack, so memory-hardness buys nothing here.
What the server-side hash defends against is a breached database yielding a
directly-replayable bearer token, and any preimage-resistant KDF does that.

If scrypt is ever wanted, the honest way is a WASM build behind its own binding,
not a JS loop in a request handler.

---

## What this service deliberately does not do

- **No server-side search.** It cannot index ciphertext. Search runs on the
  client over the decrypted projection (§6.3), which also means the server never
  learns what you searched for.
- **No projection.** The `Application` row is derived on each client by folding
  the event log. The server never computes one.
- **No profile.** §5: the profile does not sync. The most sensitive object never
  leaves the machine.
- **No email beyond identity.** No marketing, and no email-based recovery —
  email cannot recover an account, only the Recovery Kit can.

---

## Not implemented

The sync **client** (W4) and the web app (W5–W8) are not built. They need the
event schema and the `deriveStatus` projector from `docs/TRACKING.md`, which is
missing from this repository. This service is deliberately usable without them:
it stores opaque envelopes, so it does not need to know what an event *is*.
