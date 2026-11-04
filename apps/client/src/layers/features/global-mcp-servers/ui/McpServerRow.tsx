import type { ReactNode } from 'react';
import type { GlobalMcpServerView } from '@dorkos/shared/global-mcp-schemas';
import { usePatchGlobalMcpServer } from '@/layers/entities/global-mcp';
import { cn } from '@/layers/shared/lib';
import { Switch } from '@/layers/shared/ui';
import { changeError, scopeLine, wasNotConfirmed } from '../lib/server-lines';
import { useConfirmWaiting } from '../model/use-confirm-waiting';
import { ServerMark } from './ServerMark';

interface McpServerRowProps {
  /** The server. */
  server: GlobalMcpServerView;
  /** An agent's name, or `undefined` for one that is gone. */
  nameOf: (agentId: string) => string | undefined;
  /** Open the server's sheet. */
  onOpen: () => void;
}

/**
 * One server: its name, who gets it, and its switch. The switch shows what is true, so a turn-on
 * waiting on "Confirm it's you" stays off and the second line says so. Opening the sheet clears what the last press came to.
 */
export function McpServerRow({ server, nameOf, onOpen }: McpServerRowProps) {
  const patch = usePatchGlobalMcpServer();
  const waiting = useConfirmWaiting(patch.isPending);

  return (
    <li
      data-testid={`mcp-server-row-${server.name}`}
      className="hover:bg-muted/50 flex items-center rounded-lg transition-colors"
    >
      <button
        type="button"
        onClick={() => {
          patch.reset();
          onOpen();
        }}
        className="focus-ring flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left"
      >
        <span className={cn('shrink-0', !server.enabled && 'opacity-55')}>
          <ServerMark />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn('block truncate text-sm font-medium', !server.enabled && 'opacity-55')}
          >
            {server.name}
          </span>
          <DetailLine
            server={server}
            nameOf={nameOf}
            outcome={
              waiting || patch.isError ? <RowOutcome waiting={waiting} error={patch.error} /> : null
            }
          />
        </span>
      </button>
      <div className="flex min-h-11 shrink-0 items-center pr-3">
        <Switch
          aria-label={`${server.name} on`}
          checked={server.enabled}
          disabled={patch.isPending}
          onCheckedChange={(enabled) => patch.mutate({ name: server.name, patch: { enabled } })}
        />
      </div>
    </li>
  );
}

/**
 * The row's second line: what the switch just came to, what's in the way, then who gets it. A
 * warning keeps its full ink on an off server: only the name and "Off" dim.
 */
function DetailLine({
  server,
  nameOf,
  outcome,
}: {
  server: GlobalMcpServerView;
  nameOf: McpServerRowProps['nameOf'];
  outcome: ReactNode;
}) {
  const [first, ...rest] = server.warnings;
  // Only a line with nothing to warn about may cut off: a notice or a warning always reads whole.
  const mayClamp = !outcome && !first && server.skippedOn.length === 0;
  return (
    <span className={cn('text-muted-foreground text-xs', mayClamp ? 'line-clamp-2' : 'block')}>
      {outcome}
      {!server.enabled && <span className="opacity-55">Off · </span>}
      {first && (
        <span className="text-status-warning-fg">
          {first.note}
          {rest.length > 0 && ` +${rest.length} more`}
          {' · '}
        </span>
      )}
      {server.skippedOn.length > 0 && (
        <>
          <span className="text-status-warning-fg">Not available to Codex or OpenCode agents</span>
          {' · '}
        </>
      )}
      {scopeLine(server.excludedAgents, nameOf)}
    </span>
  );
}

/** What pressing the switch came to: waiting, not confirmed, or the server's refusal. */
function RowOutcome({ waiting, error }: { waiting: boolean; error: unknown }) {
  if (waiting) return <span role="status">Confirm it’s you… · </span>;
  if (wasNotConfirmed(error)) {
    return (
      <span role="status" className="text-foreground">
        Not confirmed. Nothing changed. ·{' '}
      </span>
    );
  }
  return (
    <span role="alert" className="text-destructive">
      {changeError(error)} ·{' '}
    </span>
  );
}
