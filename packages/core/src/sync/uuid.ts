/**
 * UUIDv7 — time-ordered, client-generated identifiers (WEB.md §2).
 *
 * "An append-only log with UUIDv7 ids is a **grow-only set**: merge is
 * union-then-dedup-by-id. Order-independent, no clock skew, no last-writer-wins,
 * no conflict resolution to write or debug."
 *
 * v7 rather than v4 because the leading 48 bits are a millisecond timestamp, so
 * ids sort roughly chronologically. That makes the primary key index
 * append-friendly instead of scattering writes across the B-tree — which is why
 * the sync table can carry hundreds of thousands of rows on D1 without care.
 *
 * Ordering for *correctness* still comes from `occurredAt` inside the ciphertext
 * (§4.1); this is a storage-locality property, not a clock the projector trusts.
 *
 * Layout (RFC 9562):
 *   48 bits  unix_ts_ms
 *    4 bits  version (7)
 *   12 bits  rand_a
 *    2 bits  variant (0b10)
 *   62 bits  rand_b
 */

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian millisecond timestamp.
  const timestamp = BigInt(now);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  // Version 7 in the high nibble of byte 6; variant 0b10 in the top bits of byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = (index: number) => HEX[bytes[index]!]!;
  return (
    `${hex(0)}${hex(1)}${hex(2)}${hex(3)}-${hex(4)}${hex(5)}-${hex(6)}${hex(7)}-` +
    `${hex(8)}${hex(9)}-${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** The embedded millisecond timestamp. Diagnostics and GC only — never ordering. */
export function uuidv7Timestamp(uuid: string): number | undefined {
  if (!isUuidv7(uuid)) return undefined;
  return Number(BigInt(`0x${uuid.slice(0, 8)}${uuid.slice(9, 13)}`));
}
