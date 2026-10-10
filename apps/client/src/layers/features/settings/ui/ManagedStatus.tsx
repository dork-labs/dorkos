import { useState } from 'react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  remoteAccessDotTone,
  remoteAccessHeading,
  useRemoteAccessActions,
  type ManagedRemoteAccess,
  type TunnelState,
} from '@/layers/entities/tunnel';
import { TunnelConnected } from './TunnelConnected';

/** Props for {@link ManagedStatus}. */
export interface ManagedStatusProps {
  /** Where remote access is, from the shared store. */
  state: TunnelState;
  /** The address, only while it can be used. */
  url: string | null;
  /** The report's managed view. */
  managed: ManagedRemoteAccess;
  /** The open chat, for the chat-link button. */
  activeSessionId: string | null;
  /** The dialog's latency probe, `null` when not measured. */
  latencyMs: number | null;
}

/** States in which there is something for "Close now" to close. */
const CLOSABLE: ReadonlySet<TunnelState> = new Set(['connected', 'starting', 'reconnecting']);

/**
 * Remote access from DorkOS, once this computer is set up for it (DOR-2086).
 *
 * The same heading and dot every other surface shows for the state, then only
 * what is true: the address while it can be used, "Always available" only when
 * DorkOS Cloud says so, the reason when something needs a person, and a note
 * when Cloud could not be reached, in which case everything above is this
 * computer's own last-known account.
 *
 * Turning it off is the mode choice above. Here are the two managed-only
 * actions: close it now (the choice stays), and remove it from this computer.
 */
export function ManagedStatus({
  state,
  url,
  managed,
  activeSessionId,
  latencyMs,
}: ManagedStatusProps) {
  const actions = useRemoteAccessActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (write: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    write()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Couldn’t change remote access. Try again.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3" data-testid="managed-status" data-state-name={state}>
      <div className="flex items-center gap-2">
        <span
          className={cn('inline-block size-2 shrink-0 rounded-full', remoteAccessDotTone(state))}
          aria-hidden
        />
        <p className="text-sm font-medium">{remoteAccessHeading(state)}</p>
      </div>

      <div className="text-muted-foreground space-y-1 text-xs">
        {managed.alwaysAvailable && <p>Always available</p>}
        {state === 'asleep' && <p>Your address stays the same.</p>}
        {managed.reason && (
          <p className={cn(state === 'blocked' && 'text-status-warning-fg')}>{managed.reason}</p>
        )}
        {managed.cloudStale && (
          <p data-testid="managed-status-stale">
            Couldn’t reach DorkOS Cloud. Showing the last known state.
          </p>
        )}
      </div>

      {url && <TunnelConnected url={url} activeSessionId={activeSessionId} latencyMs={latencyMs} />}

      <div className="flex flex-wrap gap-2">
        {CLOSABLE.has(state) && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(actions.closeNow)}>
            Close now
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(actions.withdraw)}>
          Remove from this computer
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
