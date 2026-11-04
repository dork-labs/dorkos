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
 * waiting on "Confirm it's you" stays off and the second line says so.
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
        onClick={onOpen}
        className="focus-ring flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left"
      >
        <span
          className={cn('flex min-w-0 flex-1 items-center gap-3', !server.enabled && 'opacity-55')}
        >
          <ServerMark />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{server.name}</span>
            {!waiting && !patch.isError && <DetailLine server={server} nameOf={nameOf} />}
            {(waiting || patch.isError) && <RowOutcome waiting={waiting} error={patch.error} />}
          </span>
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

/** The row's second line: what's in the way first, then who gets it. */
function DetailLine({
  server,
  nameOf,
}: {
  server: GlobalMcpServerView;
  nameOf: McpServerRowProps['nameOf'];
}) {
  const [first, ...rest] = server.warnings;
  return (
    <span className="text-muted-foreground line-clamp-2 block text-xs">
      {!server.enabled && 'Off · '}
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
  if (waiting) {
    return (
      <span role="status" className="text-muted-foreground block text-xs">
        Confirm it’s you…
      </span>
    );
  }
  if (wasNotConfirmed(error)) {
    return (
      <span role="status" className="block text-xs">
        Not confirmed. Nothing changed.
      </span>
    );
  }
  return (
    <span role="alert" className="text-destructive block text-xs">
      {changeError(error)}
    </span>
  );
}
