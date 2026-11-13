import type {
  GlobalMcpCheckedTool,
  GlobalMcpStandingAllow,
  GlobalMcpToolsCheck,
} from '@dorkos/shared/global-mcp-schemas';
import {
  useGlobalMcpServerTools,
  useGlobalMcpStandingAllows,
  useUndoGlobalMcpStandingAllow,
} from '@/layers/entities/global-mcp';
import { Badge, Button } from '@/layers/shared/ui';
import { changeError } from '../lib/server-lines';

interface WhoUsesItProps {
  /** The server whose sheet is open. */
  server: string;
}

/** "create_issue only" or "Every tool, including new ones". */
function reach(allow: GlobalMcpStandingAllow): string {
  return allow.breadth === 'server' ? 'Every tool, including new ones' : `${allow.tool} only`;
}

/** The agents that may use one tool without asking, by name. */
function usersOf(tool: string, allows: readonly GlobalMcpStandingAllow[]): string[] {
  const names = allows
    .filter((allow) => allow.breadth === 'server' || allow.tool === tool)
    .map((allow) => allow.agentName);
  return [...new Set(names)];
}

/**
 * "Who uses it without asking" and "What it can do" (DOR-4118): each agent's standing yes for
 * this server, with Undo, and the tools the server lists, checked when the sheet opens.
 *
 * Tool names and descriptions are the server's own text, rendered as plain text and nothing else.
 */
export function WhoUsesIt({ server }: WhoUsesItProps) {
  const tools = useGlobalMcpServerTools(server);
  const allows = useGlobalMcpStandingAllows(server);
  const undo = useUndoGlobalMcpStandingAllow();
  const held = allows.data ?? [];

  return (
    <>
      <section aria-labelledby="who-uses-it" className="space-y-2">
        <h3 id="who-uses-it" className="text-sm font-medium">
          Who uses it without asking
        </h3>
        {allows.isPending ? (
          <p className="text-muted-foreground text-sm">Reading agents’ folders…</p>
        ) : held.length === 0 ? (
          <p className="text-muted-foreground text-sm">No one. Every agent asks first.</p>
        ) : (
          <ul className="divide-border divide-y rounded-lg border text-sm">
            {held.map((allow) => (
              <li
                key={`${allow.agentId}:${allow.file}:${allow.rule}`}
                className="flex items-center gap-3 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{allow.agentName}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {reach(allow)} · in its project
                  </p>
                </div>
                {allow.file === 'settings.local.json' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="max-sm:h-11"
                    disabled={undo.isPending}
                    aria-label={`Undo ${reach(allow)} for ${allow.agentName}`}
                    onClick={() =>
                      undo.mutate({ name: server, agentId: allow.agentId, rule: allow.rule })
                    }
                  >
                    Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {undo.isError && (
          <p role="alert" className="text-destructive text-sm">
            {changeError(undo.error)}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Everyone else asks first. These may not apply to untrusted folders.
        </p>
      </section>

      <section aria-labelledby="what-it-can-do" className="space-y-2">
        <h3 id="what-it-can-do" className="text-sm font-medium">
          {tools.data?.status === 'ok'
            ? `What it can do · ${tools.data.tools.length + tools.data.omitted} tools`
            : 'What it can do'}
        </h3>
        <ToolList
          check={tools.data}
          pending={tools.isPending}
          failed={tools.isError}
          allows={held}
        />
        <p className="text-muted-foreground text-xs">
          Read from the server when this opens. Nothing here changes what runs.
        </p>
      </section>
    </>
  );
}

interface ToolListProps {
  check: GlobalMcpToolsCheck | undefined;
  pending: boolean;
  failed: boolean;
  allows: readonly GlobalMcpStandingAllow[];
}

/** The tools, or why there are none to show. */
function ToolList({ check, pending, failed, allows }: ToolListProps) {
  if (pending) return <p className="text-muted-foreground text-sm">Checking its tools…</p>;
  if (failed || check === undefined) {
    return <p className="text-muted-foreground text-sm">Couldn’t check its tools.</p>;
  }
  if (check.status === 'not-checked') {
    return (
      <p className="text-muted-foreground text-sm">Not checked yet. It’s checked once it’s on.</p>
    );
  }
  if (check.status === 'needs-sign-in') {
    return (
      <p className="text-muted-foreground text-sm">Sign in to this server to see its tools.</p>
    );
  }
  if (check.status === 'unreachable') {
    return <p className="text-muted-foreground text-sm">Couldn’t reach the server.</p>;
  }
  if (check.tools.length === 0) {
    return <p className="text-muted-foreground text-sm">It lists no tools.</p>;
  }
  return (
    <>
      <ul className="divide-border divide-y rounded-lg border text-sm">
        {check.tools.map((tool) => (
          <ToolRow key={tool.name} tool={tool} users={usersOf(tool.name, allows)} />
        ))}
      </ul>
      {check.omitted > 0 && (
        <p className="text-muted-foreground text-xs">{check.omitted} more not shown.</p>
      )}
    </>
  );
}

/** One tool: its name and description as plain text, and who uses it without asking. */
function ToolRow({ tool, users }: { tool: GlobalMcpCheckedTool; users: string[] }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span className="min-w-0 font-mono break-all">{tool.name}</span>
          {tool.isNew && <Badge tone="warning">New today</Badge>}
        </p>
        {tool.description !== '' && (
          <p className="text-muted-foreground text-xs break-words">{tool.description}</p>
        )}
      </div>
      <span className="text-muted-foreground shrink-0 text-xs">
        {users.length > 0 ? users.join(', ') : 'Asks first'}
      </span>
    </li>
  );
}
