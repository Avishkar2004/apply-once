import {
  createEmptyProfile,
  CURRENT_SCHEMA_VERSION,
  migrateProfile,
  openJson,
  PROFILE,
  sealJson,
  type Profile,
} from '@autofill/core';
import { db, PROFILE_RECORD_ID } from './db';
import { requireDek } from './session';

/**
 * The profile, encrypted at rest (ARCHITECTURE.md §6.2).
 *
 * Reads always run through `migrateProfile`, so an older record on disk is
 * brought forward before anything else sees it, and a record from a *newer*
 * build throws rather than being silently truncated.
 */

export async function readProfile(): Promise<Profile> {
  const record = await db().profile.get(PROFILE_RECORD_ID);
  if (!record) return createEmptyProfile(CURRENT_SCHEMA_VERSION);

  const dek = await requireDek();
  const raw = await openJson<unknown>(dek, 'profile', PROFILE_RECORD_ID, {
    iv: record.iv,
    ciphertext: record.ciphertext,
  });
  return migrateProfile(raw);
}

export async function writeProfile(profile: Profile): Promise<Profile> {
  const dek = await requireDek();
  const validated = PROFILE.parse({
    ...profile,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  });

  const { iv, ciphertext } = await sealJson(dek, 'profile', PROFILE_RECORD_ID, validated);
  await db().profile.put({
    id: PROFILE_RECORD_ID,
    iv,
    ciphertext,
    updatedAt: validated.updatedAt!,
  });
  return validated;
}

/** True when a profile record exists on disk, regardless of lock state. */
export async function hasProfile(): Promise<boolean> {
  return (await db().profile.get(PROFILE_RECORD_ID)) !== undefined;
}
