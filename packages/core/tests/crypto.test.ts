import { describe, expect, it } from 'vitest';
import {
  createVault,
  formatRecoveryCode,
  normalizeRecoveryCode,
  open,
  openJson,
  rotatePassphrase,
  seal,
  sealJson,
  unlockVault,
  unlockVaultWithRecoveryCode,
  utf8,
  WrongPassphraseError,
} from '../src/crypto/index';

/**
 * PBKDF2 at 600k iterations takes ~800ms per derivation by design (WEB.md §6.2),
 * so these tests use a reduced iteration count where the number itself is not
 * what is under test, and a full-strength vault only once.
 */

describe('vault', () => {
  it('creates, unlocks and round-trips data', async () => {
    const { vault, dek, recoveryCode } = await createVault('correct horse battery staple');

    expect(vault.wrappedDek.byteLength).toBe(40); // AES-KW of a 256-bit key
    expect(recoveryCode.canonical).toHaveLength(32);
    expect(recoveryCode.formatted.split(' ')).toHaveLength(8);

    const sealed = await sealJson(dek, 'profile', 'primary', { hello: 'world' });
    expect(await openJson(dek, 'profile', 'primary', sealed)).toEqual({ hello: 'world' });

    const reopened = await unlockVault(vault, 'correct horse battery staple');
    expect(await openJson(reopened, 'profile', 'primary', sealed)).toEqual({ hello: 'world' });
  }, 30_000);

  it('rejects the wrong passphrase', async () => {
    const { vault } = await createVault('the right one');
    await expect(unlockVault(vault, 'the wrong one')).rejects.toBeInstanceOf(WrongPassphraseError);
  }, 30_000);

  it('unlocks with the recovery code when the passphrase is lost', async () => {
    const { vault, dek, recoveryCode } = await createVault('forgotten already');
    const sealed = await sealJson(dek, 'profile', 'primary', { keep: 'me' });

    const recovered = await unlockVaultWithRecoveryCode(vault, recoveryCode.formatted);
    expect(await openJson(recovered, 'profile', 'primary', sealed)).toEqual({ keep: 'me' });
  }, 40_000);

  it('rotates the passphrase without touching stored data', async () => {
    const { vault, dek } = await createVault('first passphrase');
    const sealed = await sealJson(dek, 'profile', 'primary', { untouched: true });

    const rotated = await rotatePassphrase(vault, 'first passphrase', 'second passphrase');

    // Same ciphertext, new wrap — the whole point of the DEK indirection.
    expect(rotated.wrappedDek).not.toEqual(vault.wrappedDek);
    expect(rotated.wrappedDekRecovery).toEqual(vault.wrappedDekRecovery);

    const dek2 = await unlockVault(rotated, 'second passphrase');
    expect(await openJson(dek2, 'profile', 'primary', sealed)).toEqual({ untouched: true });
    await expect(unlockVault(rotated, 'first passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
  }, 60_000);
});

describe('envelope', () => {
  it('binds context as additional data so ciphertext cannot be replayed', async () => {
    const { dek } = await createVault('binding test');
    const sealed = await seal(dek, 'profile', 'primary', utf8('secret'));

    // Same key, different record id → must not decrypt.
    await expect(open(dek, 'profile', 'other', sealed)).rejects.toBeTruthy();
    // Same key, different record kind → must not decrypt.
    await expect(open(dek, 'document', 'primary', sealed)).rejects.toBeTruthy();
  }, 30_000);

  it('uses a fresh IV per seal', async () => {
    const { dek } = await createVault('iv test');
    const a = await seal(dek, 'profile', 'primary', utf8('same plaintext'));
    const b = await seal(dek, 'profile', 'primary', utf8('same plaintext'));
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  }, 30_000);
});

describe('recovery code', () => {
  it('normalises whatever the user typed', () => {
    const canonical = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    expect(normalizeRecoveryCode(formatRecoveryCode(canonical))).toBe(canonical);
    expect(normalizeRecoveryCode(canonical.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode('abcd-efgh ijkl mnop qrst uvwx yz23 4567')).toBe(canonical);
  });

  it('rejects codes of the wrong length', () => {
    expect(normalizeRecoveryCode('TOO SHORT')).toBeNull();
  });
});
