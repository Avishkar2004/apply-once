import { fromBase64, open, seal, sha256Hex, toBase64 } from '@autofill/core';
import { db } from './db';
import { requireDek } from './session';

/**
 * Résumé / cover-letter blobs, encrypted at rest.
 *
 * Blobs are content-addressed by the SHA-256 of the *plaintext* (WEB.md §2), so
 * re-uploading the same file is idempotent and, later, syncs as the same object.
 * The hash is over the plaintext by design; hashing ciphertext would produce a
 * different id per upload and defeat deduplication.
 */

export interface StoredBlobMeta {
  blobId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export async function putBlob(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<StoredBlobMeta> {
  const dek = await requireDek();
  const blobId = await sha256Hex(bytes);
  const { iv, ciphertext } = await seal(dek, 'document', blobId, bytes);

  const record = {
    blobId,
    iv,
    ciphertext,
    filename,
    mimeType,
    byteSize: bytes.byteLength,
    createdAt: new Date().toISOString(),
  };
  await db().documents.put(record);

  const { iv: _iv, ciphertext: _ct, ...meta } = record;
  return meta;
}

export async function putBlobBase64(
  base64: string,
  filename: string,
  mimeType: string,
): Promise<StoredBlobMeta> {
  return putBlob(fromBase64(base64), filename, mimeType);
}

export async function getBlob(blobId: string): Promise<{ bytes: Uint8Array; meta: StoredBlobMeta }> {
  const record = await db().documents.get(blobId);
  if (!record) throw new Error(`No stored document ${blobId}`);
  const dek = await requireDek();
  const bytes = await open(dek, 'document', blobId, { iv: record.iv, ciphertext: record.ciphertext });
  const { iv: _iv, ciphertext: _ct, ...meta } = record;
  return { bytes, meta };
}

/** For the message boundary, which is JSON-only. */
export async function getBlobBase64(
  blobId: string,
): Promise<{ base64: string; filename: string; mimeType: string }> {
  const { bytes, meta } = await getBlob(blobId);
  return { base64: toBase64(bytes), filename: meta.filename, mimeType: meta.mimeType };
}

export async function deleteBlob(blobId: string): Promise<void> {
  await db().documents.delete(blobId);
}
