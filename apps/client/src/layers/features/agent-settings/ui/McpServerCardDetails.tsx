import { useState, type ReactNode } from 'react';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import type { ManagedMcpServerView, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import { signInRowCopy, sourceRowCopy } from '../lib/mcp-card-copy';
import { scopeTooltip, type McpServerScope } from '../lib/mcp-scope';

/** How many tools are listed before the rest hide behind "Show N more". */
const TOOLS_SHOWN_BY_DEFAULT = 3;

/** One tool a server exposes, as Details lists it. */
export interface McpToolSummary {
  /** The tool's name, as the agent would call it. */
  name: string;
  /** One line saying what it does, when the server described it. */
  description?: string;
}

/** One row of the definition grid. Renders nothing when it has no value. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5">
      <span className="text-muted-foreground/70 text-xs">{label}</span>
      <span className="text-muted-foreground text-xs leading-relaxed">{children}</span>
    </div>
  );
}

/** The tool list, first few rows plus a control for the rest. */
function ToolList({ tools }: { tools: readonly McpToolSummary[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? tools : tools.slice(0, TOOLS_SHOWN_BY_DEFAULT);
  const hidden = tools.length - shown.length;

  return (
    <div className="mt-1.5">
      {shown.map((tool) => (
        <div
          key={tool.name}
          className="border-border/40 flex items-baseline gap-2 border-b py-1 last:border-b-0"
        >
          <code className="text-foreground text-2xs shrink-0 font-mono">{tool.name}</code>
          {tool.description && (
            <span className="text-muted-foreground text-2xs truncate">{tool.description}</span>
          )}
        </div>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1 text-xs focus-visible:ring-2"
        >
          <ChevronRight className="size-3" aria-hidden />
          Show {hidden} more
        </button>
      )}
    </div>
  );
}

/**
 * What the Source row says, or `null` when nothing here can answer it.
 *
 * Order matters: a plugin names itself, then a connection DorkOS holds can be
 * described exactly, and only then does the scope get to speak. A card with no
 * connection and no scope says nothing rather than inventing an origin.
 *
 * @param args.scope - Where the server came from, when known.
 * @param args.pluginName - The plugin it ships with, when its name says so.
 * @param args.connection - The managed server's connection, when DorkOS holds one.
 */
function describeSource(args: {
  scope: McpServerScope | null;
  pluginName: string | null;
  connection: McpServerTransport | undefined;
}): string | null {
  const { scope, pluginName, connection } = args;
  if (scope === 'plugin' && pluginName) return `Comes with the ${pluginName} plugin`;
  if (connection) return sourceRowCopy(connection);
  return scope ? scopeTooltip(scope, pluginName) : null;
}

/** Props for {@link McpServerCardDetails}. */
export interface McpServerCardDetailsProps {
  /** The managed server's connection. Absent for a server DorkOS does not manage. */
  connection?: McpServerTransport;
  /** The listing's derived sign-in state, if any. */
  authStatus?: ManagedMcpServerView['authStatus'];
  /** Which OAuth client identity DorkOS holds for this server, when it holds one. */
  authClientOrigin?: ManagedMcpServerView['authClientOrigin'];
  /** Where the server came from, or `null` when the runtime would not say. */
  scope: McpServerScope | null;
  /** The plugin it ships with, when its name says so. */
  pluginName: string | null;
  /** The name exactly as the runtime reported it. Shown only when it was parsed. */
  rawName: string;
  /** The server's readable name, so the raw-id row can tell whether parsing changed it. */
  displayName: string;
  /** Tools the server is known to expose, or `null` when unknown. */
  toolCount?: number | null;
  /** The tools themselves — see the note on {@link McpServerCardDetails}. */
  tools?: readonly McpToolSummary[];
  /** The server's own name and version — see the note on {@link McpServerCardDetails}. */
  serverInfo?: string;
  /** How many other agents use this server — see the note on {@link McpServerCardDetails}. */
  alsoUsedBy?: string;
  /** The verbatim failure string, for a server that failed. */
  error?: string;
}

/**
 * The expanded half of a server card: how it authenticates, where it lives, what
 * it offers, and — for a failed server — exactly what it said.
 *
 * **Every row is conditional, and the layout has to read as complete without any
 * of them.** Four of the rows below describe facts the API does not carry yet
 * (the server's own name and version, tool descriptions, and "also used by" —
 * DOR-1006). They are wired now because the shape of the row is a design
 * decision that was made and should not have to be re-made, and the Dev
 * Playground exercises them; nothing renders an empty or invented value.
 *
 * The verbatim error lives here rather than on the card face: a person scanning
 * the panel needs "setup problem", and a person fixing it needs the string.
 */
export function McpServerCardDetails({
  connection,
  authStatus,
  authClientOrigin,
  scope,
  pluginName,
  rawName,
  displayName,
  toolCount,
  tools,
  serverInfo,
  alsoUsedBy,
  error,
}: McpServerCardDetailsProps) {
  const source = describeSource({ scope, pluginName, connection });

  return (
    <div className="border-border/60 mt-2 space-y-1 border-t pt-2">
      {connection && (
        <DetailRow label="Sign-in">
          <span className="inline-flex items-start gap-1.5">
            <ShieldCheck className="mt-0.5 size-3 shrink-0" aria-hidden />
            {signInRowCopy({ connection, authStatus, clientOrigin: authClientOrigin })}
          </span>
        </DetailRow>
      )}

      {source && <DetailRow label="Source">{source}</DetailRow>}

      {rawName !== displayName && (
        <DetailRow label="Raw id">
          <code className="text-2xs font-mono">{rawName}</code>
        </DetailRow>
      )}

      {serverInfo && <DetailRow label="Server">{serverInfo}</DetailRow>}

      {alsoUsedBy && <DetailRow label="Also used by">{alsoUsedBy}</DetailRow>}

      {typeof toolCount === 'number' && <DetailRow label="Tools">{toolCount}</DetailRow>}

      {tools && tools.length > 0 && <ToolList tools={tools} />}

      {error && (
        <DetailRow label="Error">
          <code className="text-2xs font-mono break-all">{error}</code>
        </DetailRow>
      )}
    </div>
  );
}
