import { useCallback, useState } from 'react';
import { Loader2, ShieldAlert, Sparkles } from 'lucide-react';
import { Badge, Button, FieldCard, FieldCardContent, Skeleton } from '@/layers/shared/ui';
import { useSettingsDeepLink } from '@/layers/shared/model';
import {
  useAgentMcpServers,
  useMcpConfig,
  useEnableAgentMcpServer,
  useDisableAgentMcpServer,
  useImportAgentMcpServer,
  useRemoveAgentMcpServer,
  useTestAgentMcpServer,
} from '@/layers/entities/agent';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import type { AgentManifest, AgentRuntime } from '@dorkos/shared/mesh-schemas';
import type {
  AgentMcpTestResult,
  CapabilityApprovalRequired,
  McpServerEntry,
} from '@dorkos/shared/transport';
import { AddMcpServerForm, TRANSPORTS, type TransportKind } from './AddMcpServerForm';
import { McpStatusChip } from './McpStatusChip';
import { ManagedServerRow } from './ManagedServerRow';

/**
 * Transport kinds each runtime can actually run a managed server over.
 *
 * Interim until a per-transport runtime capability exists (DOR-892): Codex and
 * OpenCode have no SSE transport, so an SSE server added to one of those agents
 * is silently dropped at turn time. Every other runtime accepts the full set.
 */
const SUPPORTED_TRANSPORTS_BY_RUNTIME: Partial<Record<AgentRuntime, readonly TransportKind[]>> = {
  codex: ['stdio', 'http'],
  opencode: ['stdio', 'http'],
};

/** Transport kinds the Add form should offer for a given agent runtime. */
function supportedTransportsFor(runtime: AgentRuntime): readonly TransportKind[] {
  return SUPPORTED_TRANSPORTS_BY_RUNTIME[runtime] ?? TRANSPORTS;
}

interface DiscoveredServerRowProps {
  /** The discovered entry from `.mcp.json` / live status. */
  entry: McpServerEntry;
  /** The agent the server would be imported into. */
  agentId: string;
  /** Display label for the agent, used in the confirm copy. */
  agentLabel: string;
  /** Whether the agent's runtime can run DorkOS-managed servers (gates Import). */
  canImport: boolean;
}

/**
 * One discovered (read-only) server from `.mcp.json` / live status with no
 * managed match. When the runtime can manage servers, it offers a one-click
 * Import that promotes the server into the managed (editable) store through the
 * same operator-approval flow as Add: `mcp.import` returns `approval_required`
 * first, the operator confirms, and the granted retry writes it — after which
 * the managed list and the discovered roster both refresh and the row moves.
 */
function DiscoveredServerRow({ entry, agentId, agentLabel, canImport }: DiscoveredServerRowProps) {
  const importServer = useImportAgentMcpServer();
  const [pending, setPending] = useState<CapabilityApprovalRequired | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const result = await importServer.mutateAsync({ input: { agentId, name: entry.name } });
      if (result.status === 'approval_required') setPending(result.approval);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import the server.');
    }
  }, [importServer, agentId, entry.name]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    setError(null);
    try {
      const result = await importServer.mutateAsync({
        input: { agentId, name: entry.name },
        approval: pending,
      });
      // On success the row moves to managed via query invalidation; nothing to
      // reset here because this component unmounts with the discovered list.
      if (result.status !== 'ok') setError('The import still needs approval. Try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import the server.');
    }
  }, [importServer, agentId, entry.name, pending]);

  if (pending) {
    return (
      <div className="border-border/60 my-1.5 space-y-3 rounded-md border p-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Manage &ldquo;{entry.name}&rdquo; for {agentLabel}?
            </p>
            <p className="text-muted-foreground text-xs">
              This brings the {entry.type} server from this project&rsquo;s config under DorkOS
              management, so you can enable, disable, and edit it here.
            </p>
          </div>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPending(null)}
            disabled={importServer.isPending}
            className="focus-visible:ring-2"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={confirm}
            disabled={importServer.isPending}
            className="focus-visible:ring-2"
          >
            {importServer.isPending ? 'Importing…' : 'Confirm & manage'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <McpStatusChip statusKey={entry.status} />
        <span className="min-w-0 truncate text-sm">{entry.name}</span>
        <span className="text-muted-foreground/50 text-xs">{entry.type}</span>
        <Badge variant="outline" className="text-muted-foreground ml-auto text-xs font-normal">
          discovered
        </Badge>
        {canImport && (
          <Button
            variant="ghost"
            size="sm"
            onClick={start}
            disabled={importServer.isPending}
            aria-label={`Manage ${entry.name}`}
            className="focus-visible:ring-2"
          >
            {importServer.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <>
                <Sparkles className="size-3.5" />
                Manage
              </>
            )}
          </Button>
        )}
      </div>
      {error && <p className="text-destructive pl-4 text-xs">{error}</p>}
    </div>
  );
}

interface AgentMcpServersProps {
  /** The agent whose managed servers are shown. */
  agent: AgentManifest;
  /** Absolute path to the agent's workspace (for the live-status join). */
  projectPath: string;
}

/**
 * Cross-link to the inbound MCP direction (plan D7): this section gives THIS
 * agent tools FROM other MCP servers; letting OTHER apps use DorkOS itself as
 * an MCP server is the opposite direction, in Settings → Tools, not here.
 */
function InboundMcpCrossLink() {
  const { open } = useSettingsDeepLink();

  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      Want other apps to use DorkOS as an MCP server instead? That is the other direction.{' '}
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs"
        onClick={() => open('tools', 'external-mcp')}
      >
        See Settings → Tools
      </Button>
    </p>
  );
}

/**
 * The managed MCP servers section of the Agent Hub Toolkit: managed servers
 * (editable, joined with live status by name), discovered servers (read-only),
 * and a gated Add affordance. Add is disabled for runtimes that cannot run
 * DorkOS-managed servers (OpenCode today, DOR-893) — the roster still shows.
 */
export function AgentMcpServers({ agent, projectPath }: AgentMcpServersProps) {
  const managed = useAgentMcpServers(agent.id);
  const { data: liveConfig } = useMcpConfig(projectPath, agent.runtime);
  const caps = useCapabilitiesForRuntime(agent.runtime);
  const canAdd = caps?.supportsManagedMcpServers ?? true;

  const enableServer = useEnableAgentMcpServer();
  const disableServer = useDisableAgentMcpServer();
  const removeServer = useRemoveAgentMcpServer();
  const testServer = useTestAgentMcpServer();

  const [testResults, setTestResults] = useState<Record<string, AgentMcpTestResult>>({});
  const [testingName, setTestingName] = useState<string | null>(null);

  const handleToggle = useCallback(
    (name: string, enabled: boolean) => {
      const mutation = enabled ? enableServer : disableServer;
      mutation.mutate({ agentId: agent.id, name });
    },
    [agent.id, enableServer, disableServer]
  );

  const handleRemove = useCallback(
    (name: string) => {
      removeServer.mutate({ agentId: agent.id, name });
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    },
    [agent.id, removeServer]
  );

  const handleTest = useCallback(
    async (name: string) => {
      setTestingName(name);
      try {
        const result = await testServer.mutateAsync({ agentId: agent.id, name });
        setTestResults((prev) => ({ ...prev, [name]: result }));
      } finally {
        setTestingName(null);
      }
    },
    [agent.id, testServer]
  );

  // A just-added remote server is probed once, unasked. Only the probe knows
  // whether it wants a sign-in, and until something asks, the row can only say
  // "Unknown" — so the person would have to guess that Test is the next step
  // (DOR-985). A local stdio server needs no sign-in, so it is left alone.
  const handleAdded = useCallback(
    ({ name, transport }: { name: string; transport: TransportKind }) => {
      // `.catch` because this probe is unattended: nobody clicked it, so nothing
      // is awaiting its rejection, and the mutation's own error surface has
      // already reported the failure. Without it a throwing probe becomes an
      // unhandled rejection.
      if (transport !== 'stdio') void handleTest(name).catch(() => {});
    },
    [handleTest]
  );

  const managedServers = managed.data ?? [];
  const managedNames = new Set(managedServers.map((s) => s.name));
  const liveByName = new Map((liveConfig?.servers ?? []).map((s) => [s.name, s]));
  const discovered = (liveConfig?.servers ?? []).filter((s) => !managedNames.has(s.name));
  const busy = enableServer.isPending || disableServer.isPending || removeServer.isPending;

  return (
    <section className="space-y-3" aria-label="MCP servers">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">MCP Servers</h3>
        {canAdd && (
          <AddMcpServerForm
            agentId={agent.id}
            agentLabel={agent.displayName ?? agent.name}
            supportedTransports={supportedTransportsFor(agent.runtime)}
            onAdded={handleAdded}
          />
        )}
      </div>

      <InboundMcpCrossLink />

      {!canAdd && (
        <p className="text-muted-foreground text-xs">
          This agent&rsquo;s runtime can&rsquo;t run DorkOS-managed MCP servers yet. Any servers
          below show read-only status.
        </p>
      )}

      {managed.isLoading ? (
        <FieldCard>
          <FieldCardContent className="space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </FieldCardContent>
        </FieldCard>
      ) : managed.isError ? (
        <FieldCard>
          <FieldCardContent className="flex items-center justify-between gap-2">
            <p className="text-destructive text-sm">Couldn&rsquo;t load managed servers.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => managed.refetch()}
              className="focus-visible:ring-2"
            >
              Retry
            </Button>
          </FieldCardContent>
        </FieldCard>
      ) : managedServers.length === 0 && discovered.length === 0 ? (
        <FieldCard>
          <FieldCardContent>
            <p className="text-muted-foreground text-sm">
              No MCP servers yet.{' '}
              {canAdd
                ? 'Add one to give this agent tools from an external server.'
                : 'This runtime can’t run managed servers.'}
            </p>
          </FieldCardContent>
        </FieldCard>
      ) : (
        <FieldCard>
          <FieldCardContent>
            {managedServers.map((server) => (
              <ManagedServerRow
                key={server.name}
                server={server}
                agentId={agent.id}
                live={liveByName.get(server.name)}
                testResult={testResults[server.name]}
                testing={testingName === server.name}
                busy={busy}
                onToggle={handleToggle}
                onTest={handleTest}
                onRemove={handleRemove}
              />
            ))}
            {discovered.map((entry) => (
              <DiscoveredServerRow
                key={entry.name}
                entry={entry}
                agentId={agent.id}
                agentLabel={agent.displayName ?? agent.name}
                canImport={canAdd}
              />
            ))}
          </FieldCardContent>
        </FieldCard>
      )}
    </section>
  );
}
