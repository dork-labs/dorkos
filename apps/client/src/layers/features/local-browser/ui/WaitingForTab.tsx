import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { localBrowserStateKey } from '@/layers/entities/local-browser';
import { OpenChatTabs } from './OpenChatTabs';
import { BrowserPanelActions } from './BrowserPanelActions';

/** State 1.12 never closes anything until the person chooses the named idle chat. */
export function WaitingForTab({
  state,
  sessionId,
  agentName,
}: {
  state: LocalBrowserPersonState;
  sessionId: string;
  agentName: string | null;
}) {
  const transport = useTransport();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const idle = state.idleTabToClose;
  const close = async () => {
    if (!idle) return;
    setBusy(true);
    setError(false);
    try {
      await transport.closeIdleLocalBrowserTab(idle.sessionId, sessionId);
      await client.invalidateQueries({ queryKey: localBrowserStateKey(sessionId) });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1 text-sm break-words">
        <p>All 6 tabs are in use by other chats.</p>
        <p>{agentName || 'Your agent'} will wait until one is free.</p>
      </div>
      {error && (
        <p role="alert" className="text-sm">
          Couldn’t close that tab. Check open tabs and try again.
        </p>
      )}
      <BrowserPanelActions
        primary={
          idle && (
            <Button
              disabled={busy}
              onClick={() => void close()}
              className="h-auto min-h-11 w-full py-2 text-left whitespace-normal transition-none min-[480px]:w-auto md:h-auto"
            >
              Close the tab in {idle.title}
            </Button>
          )
        }
      >
        <OpenChatTabs tabs={state.openChatTabs ?? []} label="See open tabs" />
      </BrowserPanelActions>
    </div>
  );
}
