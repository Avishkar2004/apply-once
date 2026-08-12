import { deriveKeys, PBKDF2_ITERATIONS, SALT_BYTES } from './derive';
import { generateDek, unwrapDek, wrapDek } from './dek';
import { randomBytes } from './primitives';
import { deriveRecoveryKek, generateRecoveryCode, normalizeRecoveryCode, type RecoveryCode } from './recovery';

/**
 * The vault record — everything needed to get back to the DEK, and nothing that
 * reveals it. Persisted as-is (ARCHITECTURE.md §6.2); safe to store in plaintext
 * because every field is either public (salt) or a wrap (WEB.md §3.1).
 */
export interface VaultRecord {
  version: 1;
  /** Per-vault PBKDF2 salt for the passphrase path. */
  salt: Uint8Array;
  /** AES-KW(MUK, DEK). */
  wrappedDek: Uint8Array;
  /** Per-vault PBKDF2 salt for the recovery-code path. */
  recoverySalt: Uint8Array;
  /** AES-KW(recovery KEK, DEK). */
  wrappedDekRecovery: Uint8Array;
  iterations: number;
  createdAt: string;
}

export class VaultLockedError extends Error {
  constructor(message = 'Vault is locked') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

export class WrongPassphraseError extends Error {
  constructor(message = 'Incorrect passphrase') {
    super(message);
    this.name = 'WrongPassphraseError';
  }
}

export interface CreatedVault {
  vault: VaultRecord;
  dek: CryptoKey;
  /**
   * Shown once, at signup, and never recoverable afterwards.
   * WEB.md §3.3: signup does not complete until the user confirms they saved it.
   */
  recoveryCode: RecoveryCode;
}

export async function createVault(passphrase: string, now: () => Date = () => new Date()): Promise<CreatedVault> {
  const salt = randomBytes(SALT_BYTES);
  const recoverySalt = randomBytes(SALT_BYTES);
  const dek = await generateDek();

  const { muk, authKey } = await deriveKeys(passphrase, salt);
  authKey.fill(0); // no account yet — the auth half is unused in local-only mode

  const recoveryCode = generateRecoveryCode();
  const recoveryKek = await deriveRecoveryKek(recoveryCode.canonical, recoverySalt);

  return {
    vault: {
      version: 1,
      salt,
      wrappedDek: await wrapDek(muk, dek),
      recoverySalt,
      wrappedDekRecovery: await wrapDek(recoveryKek, dek),
      iterations: PBKDF2_ITERATIONS,
      createdAt: now().toISOString(),
    },
    dek,
    recoveryCode,
  };
}

/**
 * Unlock with the passphrase. AES-KW carries its own integrity check, so a wrong
 * passphrase surfaces as an unwrap failure — there is no separate verifier blob
 * and therefore nothing extra for an offline attacker to test against.
 */
export async function unlockVault(vault: VaultRecord, passphrase: string): Promise<CryptoKey> {
  const { muk, authKey } = await deriveKeys(passphrase, vault.salt, vault.iterations);
  authKey.fill(0);
  try {
    return await unwrapDek(muk, vault.wrappedDek);
  } catch {
    throw new WrongPassphraseError();
  }
}

/** Unlock with the Recovery Kit code instead of the passphrase. */
export async function unlockVaultWithRecoveryCode(
  vault: VaultRecord,
  code: string,
): Promise<CryptoKey> {
  const canonical = normalizeRecoveryCode(code);
  if (!canonical) throw new WrongPassphraseError('Recovery code is not the right shape');
  const kek = await deriveRecoveryKek(canonical, vault.recoverySalt, vault.iterations);
  try {
    return await unwrapDek(kek, vault.wrappedDekRecovery);
  } catch {
    throw new WrongPassphraseError('Recovery code did not unlock this vault');
  }
}

/**
 * Change the passphrase: derive a new MUK, re-wrap the *same* DEK, write one row.
 * No data is re-encrypted — that is the entire reason the DEK indirection exists.
 * A fresh salt is generated so the new passphrase does not inherit the old one's
 * KDF parameters.
 */
export async function rotatePassphrase(
  vault: VaultRecord,
  currentPassphrase: string,
  nextPassphrase: string,
): Promise<VaultRecord> {
  const dek = await unlockVault(vault, currentPassphrase);
  const salt = randomBytes(SALT_BYTES);
  const { muk, authKey } = await deriveKeys(nextPassphrase, salt);
  authKey.fill(0);
  return { ...vault, salt, wrappedDek: await wrapDek(muk, dek), iterations: PBKDF2_ITERATIONS };
}
