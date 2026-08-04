import { useCallback, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Badge, Button, FieldCard, FieldCardContent, Skeleton, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  useAgentMcpServers,
  useMcpConfig,
  useEnableAgentMcpServer,
  useDisableAgentMcpServer,
  useRemoveAgentMcpServer,
  useTestAgentMcpServer,
} from '@/layers/entities/agent';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import type { AgentManifest, ManagedMcpServer } from '@dorkos/shared/mesh-schemas';
import type { AgentMcpTestResult, McpServerEntry } from '@dorkos/shared/transport';
import { AddMcpServerForm } from './AddMcpServerForm';

// MCP status indicator colors, keyed by the live status a runtime reports.
const MCP_STATUS_COLORS: Partial<Record<string, string>> = {
  connected: 'bg-green-500',
  failed: 'bg-red-500',
  'needs-auth': 'bg-amber-500',
  pending: 'bg-amber-500',
  disabled: 'bg-muted-foreground/20',
};

/** A colored status dot for a server's live connection state. */
function StatusDot({ statusKey }: { statusKey: string | undefined }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        MCP_STATUS_COLORS[statusKey ?? ''] ?? 'bg-muted-foreground/40'
      )}
      aria-hidden
    />
  );
}

interface ManagedServerRowProps {
  server: ManagedMcpServer;
  live: McpServerEntry | undefined;
  testResult: AgentMcpTestResult | undefined;
  testing: boolean;
  busy: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onTest: (name: string) => void;
  onRemove: (name: string) => void;
}

/** One managed (editable) server: status, name, transport, enable switch, Test, Remove. */
function ManagedServerRow({
  server,
  live,
  testResult,
  testing,
  busy,
  onToggle,
  onTest,
  onRemove,
}: ManagedServerRowProps) {
  const statusKey = server.enabled ? live?.status : 'disabled';
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <StatusDot statusKey={statusKey} />
        <span className="min-w-0 truncate text-sm">{server.name}</span>
        <span className="text-muted-foreground/50 text-xs">{server.connection.transport}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onTest(server.name)}
            disabled={testing || busy}
            className="focus-visible:ring-2"
          >
            {testing ? <Loader2 className="size-3 animate-spin" /> : 'Test'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRemove(server.name)}
            disabled={busy}
            aria-label={`Remove ${server.name}`}
            className="focus-visible:ring-2"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Switch
            checked={server.enabled}
            onCheckedChange={(next) => onToggle(server.name, next)}
            disabled={busy}
            aria-label={`Enable ${server.name}`}
          />
        </div>
      </div>
      {testResult && (
        <p
          className={cn(
            'pl-4 text-xs',
            testResult.ok ? 'text-muted-foreground' : 'text-destructive'
          )}
        >
          {testResult.ok
            ? `Connected — ${testResult.toolCount ?? 0} tool${testResult.toolCount === 1 ? '' : 's'}.`
            : `Failed — ${testResult.error ?? 'could not connect.'}`}
        </p>
      )}
    </div>
  );
}

/** One discovered (read-only) server from `.mcp.json` / live status with no managed match. */
function DiscoveredServerRow({ entry }: { entry: McpServerEntry }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <StatusDot statusKey={entry.status} />
      <span className="min-w-0 truncate text-sm">{entry.name}</span>
      <span className="text-muted-foreground/50 text-xs">{entry.type}</span>
      <Badge variant="outline" className="text-muted-foreground ml-auto text-xs font-normal">
        discovered
      </Badge>
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
          <AddMcpServerForm agentId={agent.id} agentLabel={agent.displayName ?? agent.name} />
        )}
      </div>

      {!canAdd && (
        <p className="text-muted-foreground text-xs">
          This agent&rsquo;s runtime (OpenCode) can&rsquo;t run DorkOS-managed MCP servers yet. Any
          servers below show read-only status.
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
              <DiscoveredServerRow key={entry.name} entry={entry} />
            ))}
          </FieldCardContent>
        </FieldCard>
      )}
    </section>
  );
}
