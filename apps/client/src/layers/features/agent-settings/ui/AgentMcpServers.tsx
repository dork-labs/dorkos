import { useCallback, useRef, useState } from 'react';
import { Button, FieldCard, FieldCardContent, Skeleton } from '@/layers/shared/ui';
import { useSettingsDeepLink } from '@/layers/shared/model';
import {
  useAgentMcpServers,
  useMcpConfig,
  useEnableAgentMcpServer,
  useDisableAgentMcpServer,
  useRemoveAgentMcpServer,
  useTestAgentMcpServer,
} from '@/layers/entities/agent';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import type { AgentManifest, AgentRuntime } from '@dorkos/shared/mesh-schemas';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { AddMcpServerForm, TRANSPORTS, type TransportKind } from './AddMcpServerForm';
import type { StampedTestResult } from '../lib/mcp-server-state';
import { initialCardOrder, replayFrozenOrder } from '../lib/mcp-card-order';
import { ManagedMcpServerCard } from './ManagedMcpServerCard';
import { DiscoveredMcpServerCard } from './DiscoveredMcpServerCard';

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
 * The managed MCP servers section of the profile's Tools & MCP page: managed servers
 * (editable, joined with live status by name), servers the runtime loads from
 * elsewhere, and a gated Add affordance. Add is disabled for runtimes that cannot
 * run DorkOS-managed servers (OpenCode today, DOR-893) — the roster still shows.
 *
 * **The order is sorted once and then frozen** (spec `mcp-server-cards-redesign`
 * §2.2). Cards that need you are on top when the panel opens; from then on a card
 * changing state changes its chip, its sentence and its button, never its
 * position — because a card someone is mid-sign-in on must not move out from
 * under them. The next mount sorts again.
 */
export function AgentMcpServers({ agent, projectPath }: AgentMcpServersProps) {
  const managed = useAgentMcpServers(agent.id);
  const live = useMcpConfig(projectPath, agent.runtime);
  const liveConfig = live.data;
  const caps = useCapabilitiesForRuntime(agent.runtime);
  const canAdd = caps?.supportsManagedMcpServers ?? true;

  const enableServer = useEnableAgentMcpServer();
  const disableServer = useDisableAgentMcpServer();
  const removeServer = useRemoveAgentMcpServer();
  const testServer = useTestAgentMcpServer();

  // Probe results, each stamped with when it landed. The stamp is what keeps a
  // card honest: a probe is a fact about one moment, and both the listing and the
  // card's own sign-in flow can learn a newer one. The rule that weighs them lives
  // with the card's other precedence rules (`liveTestResult`), because it needs a
  // fact only the card has — whether ITS sign-in just landed.
  const [testResults, setTestResults] = useState<Record<string, StampedTestResult>>({});
  const [testingName, setTestingName] = useState<string | null>(null);
  // The most recently added server, so the unattended probe below can tell the
  // add form whether THAT server turned out to need a sign-in (DOR-1004).
  const [lastAdded, setLastAdded] = useState<string | null>(null);

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
        setTestResults((prev) => ({ ...prev, [name]: { result, at: Date.now() } }));
      } finally {
        setTestingName(null);
      }
    },
    [agent.id, testServer]
  );

  // A just-added remote server is probed once, unasked. Only the probe knows
  // whether it wants a sign-in, and until something asks, the card can only say
  // "Not checked yet" — so the person would have to guess that Test is the next
  // step (DOR-985). A local stdio server needs no sign-in, so it is left alone.
  const handleAdded = useCallback(
    ({ name, transport }: { name: string; transport: TransportKind }) => {
      setLastAdded(name);
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

  // The freeze itself: the first render where BOTH queries have settled captures
  // the order, and every render after replays it. A ref, not state — capturing an
  // order must not itself cause a render, and the value is read during the same
  // render that writes it. Servers that appear later are APPENDED, never
  // inserted, so nothing already on screen moves.
  //
  // Waiting for both is the whole correctness of the sort, not politeness. The
  // two sources land independently — the manifest is a file read, the runtime's
  // status goes through the runtime — and freezing on whichever arrived first
  // sorted only that half. Managed-first (the likely race) meant no runtime-only
  // state could ever reach the attention band: a server the runtime reports as
  // failed was appended AFTER the freeze, below every working card, which is
  // precisely the card the sort exists to lift.
  const frozenOrder = useRef<string[] | null>(null);
  const bothSettled = !managed.isPending && !live.isPending;
  const byName = new Map<string, { kind: 'managed' | 'discovered'; index: number }>();
  managedServers.forEach((server, index) => byName.set(server.name, { kind: 'managed', index }));
  discovered.forEach((entry, index) => byName.set(entry.name, { kind: 'discovered', index }));

  if (frozenOrder.current === null && bothSettled && byName.size > 0) {
    frozenOrder.current = initialCardOrder({
      managed: managedServers,
      live: liveByName,
      discovered,
    });
  }
  const present = [...managedServers.map((s) => s.name), ...discovered.map((s) => s.name)];
  const { ordered, added } = replayFrozenOrder({ frozen: frozenOrder.current ?? [], present });
  if (added.length > 0 && frozenOrder.current !== null) {
    frozenOrder.current = [...ordered, ...added];
  }
  const cardOrder = [...ordered, ...added];

  /** Render one card by name, in whichever kind it currently is. */
  function renderCard(name: string) {
    const slot = byName.get(name);
    if (!slot) return null;
    if (slot.kind === 'managed') {
      const server = managedServers[slot.index]!;
      return (
        <ManagedMcpServerCard
          key={server.name}
          server={server}
          agentId={agent.id}
          live={liveByName.get(server.name)}
          testResult={testResults[server.name]}
          rosterUpdatedAt={managed.dataUpdatedAt}
          testing={testingName === server.name}
          busy={busy}
          onToggle={handleToggle}
          onTest={handleTest}
          onRemove={handleRemove}
        />
      );
    }
    const entry = discovered[slot.index] as McpServerEntry;
    return (
      <DiscoveredMcpServerCard
        key={entry.name}
        entry={entry}
        agentId={agent.id}
        agentLabel={agent.displayName ?? agent.name}
        canImport={canAdd}
      />
    );
  }

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
            oauthDetectedFor={
              lastAdded && testResults[lastAdded]?.result.needsAuth === true ? lastAdded : null
            }
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
      ) : cardOrder.length === 0 ? (
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
          <FieldCardContent>{cardOrder.map(renderCard)}</FieldCardContent>
        </FieldCard>
      )}
    </section>
  );
}
