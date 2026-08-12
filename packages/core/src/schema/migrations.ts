import { PROFILE, type Profile } from './profile';

/**
 * Profile schema versioning.
 *
 * `Profile.schemaVersion` is persisted with the record. On read, `migrateProfile`
 * walks every registered step from the stored version up to
 * `CURRENT_SCHEMA_VERSION`, then validates once at the end.
 *
 * Rules for adding a version:
 *  - bump `CURRENT_SCHEMA_VERSION`
 *  - add a `MIGRATIONS[n]` that transforms a v`n` object into a v`n+1` object
 *  - never edit an existing migration; write a new one
 */
export const CURRENT_SCHEMA_VERSION = 1;

type RawProfile = Record<string, unknown>;
type Migration = (raw: RawProfile) => RawProfile;

/** Keyed by the version being migrated *from*. */
const MIGRATIONS: Record<number, Migration> = {
  // 1: (raw) => ({ ...raw, schemaVersion: 2, /* ... */ }),
};

export class ProfileVersionError extends Error {
  constructor(readonly storedVersion: number) {
    super(
      `Profile was written by a newer version of AutoFill (schema v${storedVersion}, this build understands v${CURRENT_SCHEMA_VERSION}). Update the extension before continuing.`,
    );
    this.name = 'ProfileVersionError';
  }
}

/**
 * Bring a stored profile up to the current schema and validate it.
 * Throws `ProfileVersionError` for future versions rather than guessing —
 * silently dropping fields it does not understand would corrupt the record.
 */
export function migrateProfile(raw: unknown): Profile {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('Stored profile is not an object');
  }

  let current = { ...(raw as RawProfile) };
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 1;

  if (version > CURRENT_SCHEMA_VERSION) throw new ProfileVersionError(version);

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new Error(`Missing profile migration from schema v${version}`);
    }
    current = step(current);
    version += 1;
  }

  current.schemaVersion = CURRENT_SCHEMA_VERSION;
  return PROFILE.parse(current);
}
