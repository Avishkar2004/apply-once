import { useCallback, useEffect, useState } from 'react';
import type { Profile } from '@autofill/core';
import { sendToBackground } from '@/shared/messaging';
import { Banner } from '@/ui/components';
import { useSessionStatus } from '@/ui/hooks/useSession';
import { ActivityPanel } from '@/ui/options/ActivityPanel';
import { AiPanel } from '@/ui/options/AiPanel';
import { ProfileEditor } from '@/ui/options/ProfileEditor';
import { SettingsPanel } from '@/ui/options/SettingsPanel';
import { VaultGate } from '@/ui/options/VaultGate';

type Tab = 'profile' | 'ai' | 'settings' | 'activity';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'ai', label: 'AI' },
  { id: 'settings', label: 'Settings' },
  { id: 'activity', label: 'Activity' },
];

export function App() {
  const { status, error, setStatus, refresh } = useSessionStatus();
  const [tab, setTab] = useState<Tab>('profile');
  const [profile, setProfile] = useState<Profile | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await sendToBackground('profile:get'));
      setLoadError(undefined);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (status?.unlocked) void loadProfile();
  }, [status?.unlocked, loadProfile]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">AutoFill</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Local-first job application autofill. Never auto-submits.
            </p>
          </div>
        </header>

        {error && <Banner tone="error">{error}</Banner>}
        {!status ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <VaultGate status={status} onStatusChange={setStatus}>
            <nav className="mb-6 flex gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => setTab(entry.id)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    tab === entry.id
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </nav>

            {loadError && <Banner tone="error">{loadError}</Banner>}

            {tab === 'profile' &&
              (profile ? (
                <ProfileEditor profile={profile} onChange={setProfile} onSaved={() => void loadProfile()} />
              ) : (
                <p className="text-sm text-slate-500">Loading profile…</p>
              ))}

            {tab === 'ai' && <AiPanel />}
            {tab === 'settings' && <SettingsPanel onLocked={() => void refresh()} />}
            {tab === 'activity' && <ActivityPanel />}
          </VaultGate>
        )}
      </div>
    </div>
  );
}
