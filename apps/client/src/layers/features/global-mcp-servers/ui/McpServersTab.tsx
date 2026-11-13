import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useGlobalMcpServers } from '@/layers/entities/global-mcp';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { Button, focusPageHeading, Skeleton } from '@/layers/shared/ui';
import { formFromServer } from '../lib/server-form';
import { AddServerDialog } from './AddServerDialog';
import { McpServerRow } from './McpServerRow';
import { RemoveServerDialog } from './RemoveServerDialog';
import { ServerSheet } from './ServerSheet';

/**
 * What sits over the list: the sheet for a server, the question about removing it, or the Add
 * form holding it again under a new name (DOR-4262).
 */
type Open =
  | { kind: 'sheet'; name: string }
  | { kind: 'remove'; name: string }
  | { kind: 're-add'; name: string }
  | null;

/** A server that went but left a saved key behind: how many it held decides the wording. */
interface KeyLeft {
  name: string;
  several: boolean;
}

interface McpServersTabProps {
  /** A server whose sheet should open once the list has it, from a link such as the Inbox's. */
  openServer?: string;
  /** Called once that link is used, found or not, so the address can drop it. */
  onServerOpened?: () => void;
}

/**
 * Connections → MCP servers: the servers a person adds once for every agent. Every change here is
 * a person's, and the server decides which of them need "Confirm it's you".
 */
export function McpServersTab({ openServer, onServerOpened }: McpServersTabProps = {}) {
  const servers = useGlobalMcpServers();
  const agents = useRegisteredAgents();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Open>(
    openServer === undefined ? null : { kind: 'sheet', name: openServer }
  );
  // A link opens its server's sheet as it arrives, even with the tab already showing. A server
  // the list lacks opens nothing, like a sheet whose server was just removed.
  const [linked, setLinked] = useState(openServer);
  if (openServer !== linked) {
    setLinked(openServer);
    if (openServer !== undefined) setOpen({ kind: 'sheet', name: openServer });
  }
  const [keyLeft, setKeyLeft] = useState<KeyLeft | null>(null);
  // The row that opened the sheet, to hand focus back to, or the heading once it is gone.
  const opener = useRef<HTMLElement | null>(null);
  const list = servers.data ?? [];
  const current = open ? list.find((server) => server.name === open.name) : undefined;

  // Once the list is in, the link has done its job, and the address can drop it.
  useEffect(() => {
    if (openServer !== undefined && servers.isSuccess) onServerOpened?.();
  }, [openServer, servers.isSuccess, onServerOpened]);

  const nameOf = (agentId: string) => {
    const agent = agents.data?.agents.find((candidate) => candidate.id === agentId);
    return agent ? (agent.displayName ?? agent.name) : undefined;
  };

  const returnFocus = (event: Event) => {
    event.preventDefault();
    const target = opener.current;
    if (target?.isConnected) target.focus();
    else void focusPageHeading();
  };

  return (
    <section aria-labelledby="mcp-servers-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="mcp-servers-heading" className="text-sm font-semibold">
          For all your agents
        </h2>
        <Button
          variant="secondary"
          size="sm"
          className="max-sm:h-11"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-(--size-icon-sm)" aria-hidden />
          Add server
        </Button>
      </div>

      {keyLeft && (
        <div role="alert" className="bg-status-warning-bg space-y-2 rounded-lg p-3 text-sm">
          <p className="font-medium">{keyLeft.name} is removed</p>
          <p>
            {keyLeft.several
              ? 'Its keys weren’t deleted from this computer. If in doubt, revoke them at the service.'
              : 'Its key wasn’t deleted from this computer. If in doubt, revoke it at the service.'}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:h-11"
            onClick={() => setKeyLeft(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {servers.isPending && <Skeleton className="h-14 w-full rounded-lg" />}

      {servers.isError && (
        <div role="alert" className="space-y-2 text-sm">
          <p>Couldn’t load your servers.</p>
          <Button
            variant="outline"
            size="sm"
            className="max-sm:h-11"
            onClick={() => servers.refetch()}
          >
            Try again
          </Button>
        </div>
      )}

      {servers.isSuccess &&
        (list.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No servers yet. Add one and every agent can use its tools.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Every agent gets these unless a row says otherwise.
            </p>
            <ul className="space-y-0.5">
              {list.map((server) => (
                <McpServerRow
                  key={server.name}
                  server={server}
                  nameOf={nameOf}
                  onOpen={() => {
                    opener.current = document.activeElement as HTMLElement | null;
                    setOpen({ kind: 'sheet', name: server.name });
                  }}
                />
              ))}
            </ul>
          </>
        ))}

      <div className="text-muted-foreground space-y-1 text-xs">
        <p>Changes reach every chat on its next message.</p>
        <p>A server added for one agent lives in that agent’s Toolkit.</p>
      </div>

      {adding && <AddServerDialog onClose={() => setAdding(false)} />}

      {open?.kind === 'sheet' && current && (
        <ServerSheet
          server={current}
          onClose={() => setOpen(null)}
          onRemove={() => setOpen({ kind: 'remove', name: current.name })}
          onReAdd={() => setOpen({ kind: 're-add', name: current.name })}
          onCloseAutoFocus={returnFocus}
        />
      )}

      {/* The same Add, refused and confirmed the same way: added first, so nothing is lost if
          it is cancelled, and only then the old one's own Remove (DOR-4262). */}
      {open?.kind === 're-add' && current && (
        <AddServerDialog
          initial={formFromServer(current)}
          replacing={current.name}
          onClose={() => setOpen((now) => (now?.kind === 're-add' ? null : now))}
          onAdded={() => setOpen({ kind: 'remove', name: current.name })}
        />
      )}

      {open?.kind === 'remove' && current && (
        <RemoveServerDialog
          server={current}
          onClose={() => setOpen(null)}
          onCloseAutoFocus={returnFocus}
          onRemoved={({ keysLeft }) => {
            if (keysLeft) {
              setKeyLeft({
                name: current.name,
                several:
                  [...current.env, ...current.headers].filter((field) => field.secret).length > 1,
              });
            }
            setOpen(null);
          }}
        />
      )}
    </section>
  );
}
