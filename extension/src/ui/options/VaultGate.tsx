import { useState, type ReactNode } from 'react';
import type { RecoveryCodeDto, SessionStatus } from '@/shared/messages';
import { sendToBackground } from '@/shared/messaging';
import { Banner, Button, Card, TextField } from '@/ui/components';

/**
 * The lock screen (ARCHITECTURE.md §6.2, WEB.md §3.3).
 *
 * Three states: no vault yet (create one), locked (unlock), unlocked (render the
 * app). Creating a vault shows the Recovery Kit **once**, and the flow does not
 * complete until the user confirms they saved it — there is no password reset,
 * and pretending otherwise produces a support ticket with no resolution.
 */
export function VaultGate({
  status,
  onStatusChange,
  children,
}: {
  status: SessionStatus;
  onStatusChange: (status: SessionStatus) => void;
  children: ReactNode;
}) {
  if (status.unlocked) return <>{children}</>;
  return status.hasVault ? (
    <UnlockForm onStatusChange={onStatusChange} />
  ) : (
    <CreateVaultForm onStatusChange={onStatusChange} />
  );
}

function UnlockForm({ onStatusChange }: { onStatusChange: (status: SessionStatus) => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = useRecovery
        ? await sendToBackground('session:unlock-recovery', { code: recoveryCode })
        : await sendToBackground('session:unlock', { passphrase });
      onStatusChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setPassphrase('');
    }
  };

  return (
    <Card className="mx-auto max-w-md">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Unlock AutoFill</h1>
      <p className="mt-1 mb-4 text-sm text-slate-500 dark:text-slate-400">
        Your profile is encrypted on this device. It stays unlocked until you close the browser.
      </p>

      <div className="grid gap-4">
        {useRecovery ? (
          <TextField
            label="Recovery code"
            value={recoveryCode}
            onChange={setRecoveryCode}
            placeholder="K7M2 9QXF R4TP 8WBN 3JHD 5VZC 6LYS 2EAG"
            span
          />
        ) : (
          <TextField label="Passphrase" type="password" value={passphrase} onChange={setPassphrase} span />
        )}

        {error && <Banner tone="error">{error}</Banner>}

        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => setUseRecovery(!useRecovery)}>
            {useRecovery ? 'Use passphrase instead' : 'Use recovery code'}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CreateVaultForm({ onStatusChange }: { onStatusChange: (status: SessionStatus) => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [kit, setKit] = useState<RecoveryCodeDto | undefined>();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (passphrase.length < 10) {
      setError('Use at least 10 characters. This passphrase is the only thing protecting your profile.');
      return;
    }
    if (passphrase !== confirm) {
      setError('The two passphrases do not match.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const { recoveryCode } = await sendToBackground('session:create', { passphrase });
      setKit(recoveryCode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setPassphrase('');
      setConfirm('');
    }
  };

  const finish = async () => {
    onStatusChange(await sendToBackground('session:status'));
  };

  if (kit) {
    return (
      <Card className="mx-auto max-w-md">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Your Recovery Kit</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          This is the only way back in if you forget your passphrase. Nobody can reset it for you.
        </p>

        <pre className="my-4 rounded-lg border border-slate-300 bg-slate-50 p-4 text-center font-mono text-base tracking-widest text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100">
          {kit.formatted.slice(0, 19)}
          {'\n'}
          {kit.formatted.slice(20)}
        </pre>

        <Banner tone="warn">
          Print this or write it down. Do not store it in the same password manager as your passphrase.
        </Banner>

        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          <span className="text-sm text-slate-700 dark:text-slate-300">
            I have saved my recovery code somewhere safe.
          </span>
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(kit.formatted)}>
            Copy
          </Button>
          <Button variant="primary" disabled={!saved} onClick={() => void finish()}>
            Continue
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-md">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Set up AutoFill</h1>
      <p className="mt-1 mb-4 text-sm text-slate-500 dark:text-slate-400">
        Choose a passphrase. Your profile is encrypted with it on this device and never leaves unless you
        turn on sync.
      </p>

      <div className="grid gap-4">
        <TextField label="Passphrase" type="password" value={passphrase} onChange={setPassphrase} span />
        <TextField label="Confirm passphrase" type="password" value={confirm} onChange={setConfirm} span />
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : 'Create vault'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
