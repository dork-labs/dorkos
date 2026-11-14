import { useState } from 'react';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

/** Popup presence does not introduce a new state or give the agent its held page back. */
export function HeldChatTab({
  state,
  agentName,
}: {
  state: LocalBrowserPersonState;
  agentName: string | null;
}) {
  const transport = useTransport();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const show = async () => {
    if (!state.selectedTabId || !state.sessionId) return;
    setBusy(true);
    setFailed(false);
    try {
      await transport.selectLocalBrowserTab(state.selectedTabId, state.sessionId);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm break-words">
        {agentName || 'Your agent'} needs you to sign in to {state.handoff?.site}.
      </p>
      <p className="text-sm">It can’t see this tab until you hand it back.</p>
      {failed && (
        <p role="alert" className="text-sm">
          Couldn’t show the window. Try again.
        </p>
      )}
      <Button
        onClick={() => void show()}
        disabled={busy}
        className="min-h-11 w-full whitespace-normal transition-none min-[480px]:w-auto"
      >
        Show window
      </Button>
    </div>
  );
}
