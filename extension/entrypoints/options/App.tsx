import { useCallback, useEffect, useState } from "react";
import type { Profile } from "@autofill/core";
import { sendToBackground } from "@/shared/messaging";
import { Banner } from "@/ui/components";
import { useSessionStatus } from "@/ui/hooks/useSession";
import { ActivityPanel } from "@/ui/options/ActivityPanel";
import { AiPanel } from "@/ui/options/AiPanel";
import { ProfileEditor } from "@/ui/options/ProfileEditor";
import { SettingsPanel } from "@/ui/options/SettingsPanel";
import { VaultGate } from "@/ui/options/VaultGate";

type Tab = "profile" | "ai" | "settings" | "activity";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "ai", label: "AI" },
  { id: "settings", label: "Settings" },
  { id: "activity", label: "Activity" },
];

/**
 * Where the toolbar button works.
 *
 * The extension only injects on the host allow-list (§6.5), so on any other
 * page the button has nothing to talk to. Saying which sites those are is the
 * difference between "it does nothing" and "not this page".
 */
function HowToUse() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div className="mb-6 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm dark:border-indigo-900 dark:bg-indigo-950">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-semibold text-indigo-900 dark:text-indigo-100">
            How to fill an application
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-indigo-900/90 dark:text-indigo-100/90">
            <li>Fill in your profile below and save it.</li>
            <li>Open a job application on one of the supported sites.</li>
            <li>Click the AutoFill icon in your toolbar.</li>
          </ol>
          <p className="mt-2 text-indigo-900/80 dark:text-indigo-100/80">
            Supported: Greenhouse, Lever, Ashby, SmartRecruiters, Workday,
            iCIMS, Taleo. On any other page the button opens this editor
            instead. AutoFill never submits an application for you.
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 text-indigo-700 hover:text-indigo-900 dark:text-indigo-300"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function App() {
  const { status, error, setStatus, refresh } = useSessionStatus();
  const [tab, setTab] = useState<Tab>("profile");
  const [profile, setProfile] = useState<Profile | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await sendToBackground("profile:get"));
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
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">AutoFill</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Local-first job application autofill. Never auto-submits.
            </p>
          </div>
        </header>

        {error && <Banner tone="error">{error}</Banner>}
        {status?.unlocked && <HowToUse />}
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
                      ? "bg-indigo-600 text-white"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </nav>

            {loadError && <Banner tone="error">{loadError}</Banner>}

            {tab === "profile" &&
              (profile ? (
                <ProfileEditor
                  profile={profile}
                  onChange={setProfile}
                  onSaved={() => void loadProfile()}
                />
              ) : (
                <p className="text-sm text-slate-500">Loading profile…</p>
              ))}

            {tab === "ai" && <AiPanel />}
            {tab === "settings" && (
              <SettingsPanel onLocked={() => void refresh()} />
            )}
            {tab === "activity" && <ActivityPanel />}
          </VaultGate>
        )}
      </div>
    </div>
  );
}
