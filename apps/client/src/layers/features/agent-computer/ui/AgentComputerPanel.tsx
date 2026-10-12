import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ComputerPhase,
  ComputerSession,
  ComputerStatus,
} from '@dorkos/shared/computer-schemas';
import { useComputer, COMPUTER_QUERY_KEY } from '@/layers/entities/computer';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { ComputerViewer } from './ComputerViewer';

const PHASE_LABELS: Record<ComputerPhase, string> = {
  disabled: 'Off',
  unsupported: 'Unavailable',
  missing: 'Not created',
  provisioning: 'Setting up…',
  stopped: 'Stopped',
  starting: 'Starting…',
  ready: 'Ready',
  stopping: 'Stopping…',
  failed: 'Needs attention',
  uncertain: 'Needs attention',
};

export interface AgentComputerPanelProps {
  onOpenSession: (session: ComputerSession) => void;
}

/** Lifecycle controls for the single persistent experimental computer. */
export function AgentComputerPanel({ onOpenSession }: AgentComputerPanelProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const computer = useComputer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [viewing, setViewing] = useState(false);
  const status = computer.data;
  const transitional = status && ['provisioning', 'starting', 'stopping'].includes(status.phase);

  const action = async (run: () => Promise<ComputerStatus | void>) => {
    setBusy(true);
    setError(false);
    try {
      const next = await run();
      if (next) queryClient.setQueryData(COMPUTER_QUERY_KEY, next);
      await queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-slot="agent-computer-panel" aria-label="Agent computer" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Agent computer</h3>
        <span role="status" className="text-muted-foreground text-xs">
          {status ? PHASE_LABELS[status.phase] : 'Connecting…'}
        </span>
      </div>
      {(error || computer.isError) && (
        <p role="alert" className="text-destructive text-sm">
          Couldn’t reach the computer. Reconnect and try again.
        </p>
      )}
      {status?.phase === 'unsupported' && (
        <p className="text-muted-foreground text-sm">Requires an Apple Silicon Mac.</p>
      )}
      {status?.phase === 'disabled' && (
        <p className="text-muted-foreground text-sm">Turn on Agent computer in Experiments.</p>
      )}
      {status?.phase === 'missing' && (
        <p className="text-muted-foreground text-sm">Create a separate computer for your agent.</p>
      )}
      {status?.phase === 'provisioning' && (
        <p className="text-muted-foreground text-sm">Downloading and setting up the computer…</p>
      )}
      {status?.phase === 'stopped' && (
        <p className="text-muted-foreground text-sm">Its files and sign-ins are kept.</p>
      )}
      {status?.phase === 'uncertain' && (
        <p role="alert" className="text-sm">
          Couldn’t confirm its state. Reconnect before continuing.
        </p>
      )}
      {status?.error?.code === 'cleanup-uncertain' && status.phase !== 'uncertain' && (
        <p role="alert" className="text-sm">
          Couldn’t confirm its state. Reconnect before continuing.
        </p>
      )}
      {status?.phase === 'failed' && (
        <p role="alert" className="text-sm">
          Couldn’t set up the computer. Try again.
        </p>
      )}
      {status?.error?.code === 'sign-in-required' && (
        <p className="text-sm">Sign in before chatting.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {status?.phase === 'missing' && (
          <Button disabled={busy} onClick={() => void action(() => transport.createComputer())}>
            Create computer
          </Button>
        )}
        {status?.phase === 'failed' && (
          <Button disabled={busy} onClick={() => void action(() => transport.createComputer())}>
            Try again
          </Button>
        )}
        {status?.phase === 'stopped' && (
          <Button disabled={busy} onClick={() => void action(() => transport.startComputer())}>
            Start
          </Button>
        )}
        {status?.ready && status.phase === 'ready' && (
          <>
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  onOpenSession(await transport.createComputerSession());
                })
              }
            >
              Chat
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const next = await transport.signInComputer();
                  setViewing(true);
                  return next;
                })
              }
            >
              Sign in
            </Button>
            <Button variant="outline" onClick={() => setViewing(true)}>
              View
            </Button>
          </>
        )}
        {status &&
          ['ready', 'provisioning', 'starting', 'failed', 'uncertain'].includes(status.phase) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void action(() => transport.stopComputer())}
            >
              Stop
            </Button>
          )}
        {!transitional && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await computer.refetch();
              })
            }
          >
            Reconnect
          </Button>
        )}
      </div>
      {viewing && status?.ready && status.phase === 'ready' && (
        <ComputerViewer
          key={status.generation}
          generation={status.generation}
          onClose={() => setViewing(false)}
        />
      )}
    </section>
  );
}
