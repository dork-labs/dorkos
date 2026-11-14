import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { localBrowserStateKey } from '@/layers/entities/local-browser';
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
  const fallen = state.handoff?.outcome === 'stopped';
  const hasIt = fallen || state.handoffTaken;
  const transport = useTransport();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (!state.sessionId) return;
    setBusy(true);
    setFailed(false);
    try {
      await action();
      await client.invalidateQueries({ queryKey: localBrowserStateKey(state.sessionId) });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const show = () => {
    if (state.selectedTabId && state.sessionId)
      void run(() => transport.selectLocalBrowserTab(state.selectedTabId!, state.sessionId!));
  };
  return (
    <div className="space-y-3">
      {fallen ? (
        <>
          <p className="text-sm break-words">
            {agentName || 'Your agent'} stopped, so this tab is yours now.
          </p>
          <p className="text-sm">It stays yours until you hand it back.</p>
          <span className="sr-only" aria-live="polite">
            {agentName || 'Your agent'} stopped. The tab is yours now.
          </span>
        </>
      ) : state.handoffTaken ? (
        <p className="text-sm break-words">
          {agentName || 'Your agent'} can’t see or use this tab until you hand it back.
        </p>
      ) : (
        <>
          <p className="text-sm break-words">
            {agentName || 'Your agent'} needs you to sign in to {state.handoff?.site}.
          </p>
          <p className="text-sm">It can’t see this tab until you hand it back.</p>
        </>
      )}
      {failed && (
        <p role="alert" className="text-sm">
          Couldn’t update the tab. Try again.
        </p>
      )}
      {hasIt && state.handoff && (
        <Button
          onClick={() => void run(() => transport.handBackLocalBrowser(state.handoff!.id))}
          disabled={busy}
          className="h-auto min-h-11 w-full py-2 whitespace-normal transition-none min-[480px]:w-auto md:h-auto"
        >
          Hand back to {agentName || 'your agent'}
        </Button>
      )}
      {!fallen && (
        <Button
          variant={state.handoffTaken ? 'ghost' : 'default'}
          onClick={show}
          disabled={busy}
          className="h-auto min-h-11 w-full py-2 whitespace-normal transition-none min-[480px]:w-auto md:h-auto"
        >
          Show window
        </Button>
      )}
      {hasIt && state.sessionId && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void run(() => transport.disconnectLocalBrowser(state.sessionId!))}
        >
          Close tab
        </Button>
      )}
    </div>
  );
}
