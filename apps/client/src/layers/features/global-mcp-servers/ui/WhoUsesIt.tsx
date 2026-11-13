import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
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
import { cn } from '@/layers/shared/lib';
import { Badge, Button } from '@/layers/shared/ui';
import { changeError } from '../lib/server-lines';

/** How long "Atlas now asks first." stays where its row was. */
export const MADE_TO_ASK_MS = 4000;
/** How long that line takes to collapse once it goes. */
const COLLAPSE_MS = 200;

interface WhoUsesItProps {
  /** The server whose sheet is open. */
  server: string;
}

/** A row a person just made ask, shown in place for a moment. */
interface MadeToAsk {
  key: string;
  agentName: string;
  /** Where its row was in the list. */
  index: number;
  collapsing: boolean;
}

/** One standing yes, as the list keys it. */
function keyOf(allow: Pick<GlobalMcpStandingAllow, 'agentId' | 'rule'>): string {
  return `${allow.agentId}:${allow.rule}`;
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
 * Why "Make it ask" was refused, naming the agent. The name is the server's record of the row,
 * never anything read from the settings file it left alone.
 */
function refusal(error: unknown, agentName: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'not-a-real-file') {
    return `${agentName}’s settings file isn’t a plain file in its folder, so it was left alone.`;
  }
  if (code === 'unreadable') return `${agentName}’s settings file couldn’t be read.`;
  return changeError(error);
}

/**
 * "Who uses it without asking" and "What it can do" (DOR-4118): each agent's standing yes for
 * this server, with Make it ask, and the tools the server lists, checked when the sheet opens.
 *
 * Tool names and descriptions are the server's own text, rendered as plain text and nothing else.
 * Nothing here truncates: names and rules wrap, however long.
 */
export function WhoUsesIt({ server }: WhoUsesItProps) {
  const tools = useGlobalMcpServerTools(server);
  const allows = useGlobalMcpStandingAllows(server);
  const undo = useUndoGlobalMcpStandingAllow();
  const reducedMotion = useReducedMotion();
  const [madeToAsk, setMadeToAsk] = useState<MadeToAsk[]>([]);
  const [said, setSaid] = useState('');
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const later = (ms: number, run: () => void) => {
    const id = setTimeout(() => {
      timers.current.delete(id);
      run();
    }, ms);
    timers.current.add(id);
  };

  // A row made to ask leaves at once, even before the list is read again.
  const gone = new Set(madeToAsk.map((row) => row.key));
  const held = (allows.data ?? []).filter((allow) => !gone.has(keyOf(allow)));

  const makeItAsk = (allow: GlobalMcpStandingAllow, index: number) => {
    const key = keyOf(allow);
    undo.mutate(
      { name: server, agentId: allow.agentId, rule: allow.rule },
      {
        onSuccess: () => {
          setMadeToAsk((rows) => [
            ...rows,
            { key, agentName: allow.agentName, index, collapsing: false },
          ]);
          setSaid(`${allow.agentName} now asks first.`);
          later(MADE_TO_ASK_MS, () =>
            setMadeToAsk((rows) =>
              rows.map((row) => (row.key === key ? { ...row, collapsing: true } : row))
            )
          );
          later(MADE_TO_ASK_MS + (reducedMotion ? 0 : COLLAPSE_MS), () =>
            setMadeToAsk((rows) => rows.filter((row) => row.key !== key))
          );
        },
      }
    );
  };

  type Row =
    | { kind: 'allow'; allow: GlobalMcpStandingAllow; index: number }
    | { kind: 'made-to-ask'; row: MadeToAsk };
  const rows: Row[] = held.map((allow, index) => ({ kind: 'allow', allow, index }));
  for (const row of [...madeToAsk].sort((a, b) => a.index - b.index)) {
    rows.splice(Math.min(row.index, rows.length), 0, { kind: 'made-to-ask', row });
  }

  return (
    <>
      <section aria-labelledby="who-uses-it" className="space-y-2">
        <h3 id="who-uses-it" className="text-sm font-medium">
          Who uses it without asking
        </h3>
        {allows.isPending ? (
          <p className="text-muted-foreground text-sm">Reading agents’ folders…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">No one. Every agent asks first.</p>
        ) : (
          <ul className="divide-border divide-y rounded-lg border text-sm">
            {rows.map((row) =>
              row.kind === 'made-to-ask' ? (
                <li
                  key={`made-to-ask:${row.row.key}`}
                  aria-hidden
                  data-slot="made-to-ask"
                  className={cn(
                    'text-muted-foreground overflow-hidden px-3 [overflow-wrap:anywhere] transition-[max-height,opacity,padding] duration-200 ease-in motion-reduce:transition-none',
                    row.row.collapsing ? 'max-h-0 py-0 opacity-0' : 'max-h-24 py-2'
                  )}
                >
                  {row.row.agentName} now asks first.
                </li>
              ) : (
                <AllowRow
                  key={`${row.allow.agentId}:${row.allow.file}:${row.allow.rule}`}
                  allow={row.allow}
                  busy={undo.isPending}
                  failed={
                    undo.isError &&
                    undo.variables !== undefined &&
                    keyOf(undo.variables) === keyOf(row.allow)
                      ? refusal(undo.error, row.allow.agentName)
                      : null
                  }
                  onMakeItAsk={() => makeItAsk(row.allow, row.index)}
                />
              )
            )}
          </ul>
        )}
        <p aria-live="polite" className="sr-only">
          {said}
        </p>
        {held.length > 0 && (
          <p className="text-muted-foreground text-xs">These may not apply to untrusted folders.</p>
        )}
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
        {tools.data?.status !== 'not-checked' && (
          <p className="text-muted-foreground text-xs">
            Read from the server when this opens. Nothing here changes what runs.
          </p>
        )}
      </section>
    </>
  );
}

interface AllowRowProps {
  allow: GlobalMcpStandingAllow;
  busy: boolean;
  /** Why the last Make it ask on this row was refused, if it was. */
  failed: string | null;
  onMakeItAsk: () => void;
}

/** One agent's standing yes: who, how far it reaches, and Make it ask where that can reach. */
function AllowRow({ allow, busy, failed, onMakeItAsk }: AllowRowProps) {
  // Make it ask writes only the agent's own settings.local.json; settings.json is shared.
  const local = allow.file === 'settings.local.json';
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p className="font-medium">{allow.agentName}</p>
        <p className="text-muted-foreground text-xs">{reach(allow)} · in its project</p>
        {!local && <p className="text-muted-foreground text-xs">Set in settings.json</p>}
        {failed !== null && (
          <p role="alert" className="text-destructive mt-1 text-xs">
            {failed}
          </p>
        )}
      </div>
      {local && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 max-sm:h-11"
          disabled={busy}
          aria-label={`Make ${allow.agentName} ask first: ${reach(allow)}`}
          onClick={onMakeItAsk}
        >
          Make it ask
        </Button>
      )}
    </li>
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

/**
 * One tool, stacked at every width: its name and New today, its description, and who uses it
 * without asking, if anyone does. All plain text, all wrapping.
 */
function ToolRow({ tool, users }: { tool: GlobalMcpCheckedTool; users: string[] }) {
  return (
    <li className="space-y-0.5 px-3 py-2 [overflow-wrap:anywhere]">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-mono">{tool.name}</span>
        {tool.isNew && <Badge tone="warning">New today</Badge>}
      </p>
      {tool.description !== '' && (
        <p className="text-muted-foreground text-xs">{tool.description}</p>
      )}
      {users.length > 0 && (
        <p className="text-muted-foreground text-xs">Used without asking by {users.join(', ')}</p>
      )}
    </li>
  );
}
