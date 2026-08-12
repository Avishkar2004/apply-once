import { useCallback, useEffect, useState } from 'react';
import type { SessionStatus } from '@/shared/messages';
import { sendToBackground } from '@/shared/messaging';

/** Vault lock state, shared by the options page and the side panel. */
export function useSessionStatus() {
  const [status, setStatus] = useState<SessionStatus | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await sendToBackground('session:status'));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, error, refresh, setStatus };
}
