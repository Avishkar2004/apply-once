import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { FillSession } from '@/shared/types';
import { registerHandlers, sendToBackground, sendToTab } from '@/shared/messaging';
import { Banner, Button, Card } from '@/ui/components';
import { useSessionStatus } from '@/ui/hooks/useSession';

/**
 * The side panel — live fill status (ARCHITECTURE.md §8).
 *
 * The content script broadcasts each completed fill; if the panel is open it
 * catches it, and if it is not the message is simply dropped. The panel is a
 * mirror, never a participant in the fill itself.
 */
export function App() {
  const { status, refresh } = useSessionStatus();
  const [session, setSession] = useState<FillSession | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(
    () =>
      registerHandlers({
        'panel:session': ({ session: incoming }) => {
          setSession(incoming);
          return { ok: true as const };
        },
      }),
    [],
  );

  const fillActiveTab = async () => {
    setError(undefined);
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.id !== 'number') throw new Error('No active tab.');
      await sendToTab(tab.id, 'content:fill');
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'NoResponse'
          ? 'AutoFill does not run on this page. Open an application on a supported job board.'
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  };

  return (
    <div className="min-h-screen space-y-4 bg-slate-50 p-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header>
        <h1 className="text-lg font-semibold">AutoFill</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400">Never auto-submits. Review &amp; submit.</p>
      </header>

      {status && !status.unlocked && (
        <Card>
          <p className="mb-3 text-sm">AutoFill is locked.</p>
          <Button
            variant="primary"
            onClick={() => {
              void sendToBackground('ui:open-options').then(refresh);
            }}
          >
            Unlock
          </Button>
        </Card>
      )}

      {error && <Banner tone="warn">{error}</Banner>}

      <Button variant="primary" onClick={() => void fillActiveTab()} disabled={!status?.unlocked}>
        Fill this application
      </Button>

      {session ? (
        <Card>
          <p className="text-sm font-medium">
            {session.hostname}
            {session.adapter && <span className="ml-2 text-xs text-slate-400">{session.adapter}</span>}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <Stat label="✅ Filled" value={session.summary.filled} />
            <Stat label="⚠️ Check" value={session.summary.lowConfidence} />
            <Stat label="❌ Failed" value={session.summary.rejected} />
            <Stat label="⬜ Skipped" value={session.summary.skipped} />
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            {(session.summary.durationMs / 1000).toFixed(1)}s · {new Date(session.startedAt).toLocaleTimeString()}
          </p>
        </Card>
      ) : (
        <p className="text-sm text-slate-500">No fill yet in this session.</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
