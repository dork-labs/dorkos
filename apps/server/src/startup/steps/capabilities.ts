/**
 * The capability registry and what reads it: extension agent tools, approval
 * subject resolvers, the tier gate, trust-stop changes and connector program
 * execution.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/capabilities
 */
import type { McpCapabilityDeps } from '../../services/mesh/mcp-capability-deps.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { composeDorkOsCapabilityRegistry } from '../../services/core/self-description/dorkos-registry.js';
import { logger } from '../../lib/logger.js';
import { auditCapabilityDeps } from '../../services/audit/index.js';
import { AgentCompactionService } from '../../services/session/agent-compaction/agent-compaction-service.js';
import * as heartbeats from '../../services/heartbeats/index.js';
import {
  createCapabilityAttributionObserver,
  createCapabilityGateAuditObserver,
  ensureInSessionAgentIdentity,
  getAgentIdentityService,
} from '../../services/core/agent-identity/index.js';
import { wireCapabilitiesChangedBroadcast } from '../../services/core/streams/live-change-broadcasts.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { initApprovalSubjectResolvers } from '../../services/core/approvals/index.js';
import { initCapabilityTierGate } from '../../services/core/capabilities/index.js';
import { onTrustStopChange } from '../../services/core/operator/config-write.js';
import {
  recordPermissionChange,
  agentRequestWriter,
  personWriter,
} from '../../services/core/permissions/index.js';
import {
  AgentIdentitySnapshotPrincipalPort,
  startConnectorRuntimeMcpListener,
  createAgentRuntimeMcpServer,
} from '../../services/runtimes/connector-mcp/index.js';
import { createConnectorRuntimeMcpServer } from '../../services/connectors/execution/runtime-mcp-server.js';
import { resolveToolVisibilityFor } from '../../services/runtimes/shared/permission-tool-filter.js';
import { compactionToolsHiddenFor } from '../../services/session/agent-compaction/compaction-capabilities.js';
import {
  connectorRuntimeConsumer,
  connectorRuntimeHeaders,
} from '../../services/runtimes/connector-tools.js';
import { connectorThreadKeys } from '../../services/connectors/principal/thread-keys.js';
import { isConnectorRuntimeCapabilityId } from '../../services/connectors/runtime-capability-scope.js';
import { env } from '../../env.js';
import type {
  ConnectorRuntimeRequestProbe,
  ConnectorRuntimeExecutionProbe,
} from '../../routes/test-control.js';
import { ConnectorEventAccessQueryService } from '../../services/connectors/events/access-query-service.js';
import type { WireConnectorEventsAndApprovalsResult } from './connector-events-approvals.js';
import type { MountCoreRoutesResult } from './core-routes.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { WireConnectorServicesResult } from './connector-services.js';
import type { WireDocDeliveryResult } from './doc-delivery.js';
import type { WireRoomsResult } from './rooms.js';
import type { WireSessionServicesResult } from './session-services.js';
import type { WireMcpTasksAndSkillsResult } from './mcp-tasks-skills.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link composeCapabilities} reads from the startup steps before it. */
export interface ComposeCapabilitiesInput {
  docChannelHttp: WireConnectorEventsAndApprovalsResult['docChannelHttp'];
  permissionService: MountCoreRoutesResult['permissionService'];
  connectorRegistry: WireCoreStoresResult['connectorRegistry'];
  connectorOperatorQueries: WireConnectorServicesResult['connectorOperatorQueries'];
  connectorAuthorization: WireConnectorServicesResult['connectorAuthorization'];
  connectorBroker: WireDocDeliveryResult['connectorBroker'];
  connectorAccess: WireDocDeliveryResult['connectorAccess'];
  connectorHolds: WireDocDeliveryResult['connectorHolds'];
  roomService: WireRoomsResult['roomService'];
  roomMerges: WireRoomsResult['roomMerges'];
  auditLog: WireCoreStoresResult['auditLog'];
  auditAccounts: WireCoreStoresResult['auditAccounts'];
  agentPauses: WireCoreStoresResult['agentPauses'];
  chatMessaging: WireSessionServicesResult['chatMessaging'];
  commitments: WireSessionServicesResult['commitments'];
  activityService: WireCoreStoresResult['activityService'];
  roomStore: WireRoomsResult['roomStore'];
  approvalService: WireConnectorEventsAndApprovalsResult['approvalService'];
  connectorRuntimePrincipals: WireConnectorServicesResult['connectorRuntimePrincipals'];
  connectorOwner: WireCoreStoresResult['connectorOwner'];
  deps: WireMcpTasksAndSkillsResult['deps'];
  connectorRoutes: MountCoreRoutesResult['connectorRoutes'];
  connectorProgramPrincipals: WireConnectorServicesResult['connectorProgramPrincipals'];
  connectorEventSubscriptions: WireConnectorEventsAndApprovalsResult['connectorEventSubscriptions'];
  connectorOwnsAgent: WireConnectorServicesResult['connectorOwnsAgent'];
  managedEventConsent: WireConnectorServicesResult['managedEventConsent'];
  connectorOwnerBoundary: MountCoreRoutesResult['connectorOwnerBoundary'];
}

/**
 * Compose the capability registry and wire everything that reads it.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function composeCapabilities(refs: ServerRefs, built: ComposeCapabilitiesInput) {
  const {
    docChannelHttp,
    permissionService,
    connectorRegistry,
    connectorOperatorQueries,
    connectorAuthorization,
    connectorBroker,
    connectorAccess,
    connectorHolds,
    roomService,
    roomMerges,
    auditLog,
    auditAccounts,
    agentPauses,
    chatMessaging,
    commitments,
    activityService,
    roomStore,
    approvalService,
    connectorRuntimePrincipals,
    connectorOwner,
    deps,
    connectorRoutes,
    connectorProgramPrincipals,
    connectorEventSubscriptions,
    connectorOwnsAgent,
    managedEventConsent,
    connectorOwnerBoundary,
  } = built;
  // ── Capability Registry (spec `capability-registry`) ─────────────────────
  // Compose the single registry now that its dependency bags are settled:
  // `mcpToolDeps` (operator handles) and `marketplaceMcpDeps` (marketplace
  // bundle) have their final values, so every capability whose domain is
  // enabled is present. Composing all domains together is what gives cross-domain
  // duplicate detection, and `composeDorkOsCapabilityRegistry` asserts each
  // enabled domain's deps at this point — a wiring bug fails the boot, not the
  // first request. Both MCP servers (via the closures above) and the catalog
  // route below share this one instance.
  // The attribution observer records an Activity event for every invocation
  // made by an agent that presented an identity token (spec `agent-trust`
  // §3.1). Unattributed calls write nothing, so the no-token path is unchanged.
  //
  // The MCP-server-management domain (spec `mcp-server-management` §5): the
  // eight `mcp.*` verbs over the same service the injection factory reads, so a
  // server added through the gated capability is what the next session injects.
  // Built here (not inline) so `meshCore` narrows for the fallback closure.
  // Present only when meshCore initialized (the service needs the agent registry
  // to resolve workspace paths). `resolveDiscoveredFallback` backs `mcp.import`
  // when a workspace `.mcp.json` cannot resolve a name: the agent's own runtime
  // may hold an already-captured connection from a prior turn (claude-code's
  // cache). Resolved lazily and only on the file miss, so it never runs for the
  // common `.mcp.json` case.
  let mcpDeps: McpCapabilityDeps | undefined;
  if (refs.agentMcpServerService && refs.meshCore) {
    const agentRegistry = refs.meshCore.agentRegistry;
    mcpDeps = {
      service: refs.agentMcpServerService,
      agents: agentRegistry,
      // The OAuth engine backing `mcp.signin`/`mcp.poll_signin` (DOR-942); the
      // same instance the injection token provider reads and the callback route
      // completes into.
      ...(refs.agentMcpOAuthService && { oauth: refs.agentMcpOAuthService }),
      resolveDiscoveredFallback: (agentId: string, name: string) => {
        const agent = agentRegistry.get(agentId);
        if (!agent) return null;
        const runtime = runtimeRegistry.has(agent.runtime)
          ? runtimeRegistry.get(agent.runtime)
          : runtimeRegistry.getDefault();
        return runtime.getMcpServerConfig?.(agent.projectPath, name) ?? null;
      },
    };
  }
  refs.capabilityRegistry = composeDorkOsCapabilityRegistry(
    {
      logger,
      docChannelDownstream: docChannelHttp.downstream,
      docChannelGrantDeps: {
        service: docChannelHttp.grants,
        authorization: docChannelHttp.authorization,
      },
      // An agent's approved `change_permission` writes through the same owner
      // Settings does (spec `agent-permissions` D9).
      permissionService,
      ...(refs.mcpToolDeps && { operatorDeps: refs.mcpToolDeps }),
      ...(refs.marketplaceMcpDeps && { marketplaceDeps: refs.marketplaceMcpDeps }),
      // Ordinary MCP surfaces expose only provider-neutral discovery. Private
      // account management stays in owner routes, while exact operation calls
      // use the authenticated internal connector listener below.
      connectorDeps: {
        registry: connectorRegistry,
        catalog: (input) =>
          connectorOperatorQueries.catalog({
            ...input,
            includeAuthenticationSetup: false,
          }),
        ...(refs.adapterManager && { relay: refs.adapterManager }),
      },
      connectorExecutionDeps: {
        authorization: connectorAuthorization,
        broker: connectorBroker,
        access: connectorAccess,
        ...(refs.connectorAgentRequests && { requests: refs.connectorAgentRequests }),
        holds: connectorHolds,
      },
      // The MCP-server-management domain — its deps are built above so the
      // `mcp.import` fallback closure narrows `meshCore`.
      ...(mcpDeps && { mcpDeps }),
      // The rooms domain (room-participation spec §10.2, §10.3): the verbs an
      // agent has in the rooms it belongs to. The SAME service instances the
      // REST routes and the trigger dispatcher hold — one set of membership
      // rules, one cascade guard, one budget, one merge queue, whichever surface
      // reaches them.
      roomDeps: { rooms: roomService, merges: roomMerges },
      // How a saved note learns which room it was written in (DOR-632). The
      // room service answers for the CALLING session, so the label is derived
      // rather than supplied — a model that could name its own provenance could
      // make a poisoned note claim it came from somewhere trustworthy.
      memoryDeps: { roomLabelForSession: (id: string) => roomService.roomLabelForSession(id) },
      // An agent asking for its own conversation to be summarized (DOR-2732).
      // Built here, once: its once-an-hour budget must outlive the per-session
      // tool servers that reach it.
      // `audit.verify`: anyone may check the audit log's chain (spec `audit-trail`).
      auditDeps: auditCapabilityDeps(auditLog, auditAccounts, runtimeRegistry),
      // `agent.pause` / `agent.resume`: anyone may stop any agent (spec `audit-trail` PR5).
      agentPauseDeps: { pauses: agentPauses },
      // Chats messaging chats (spec `spin-off-chats`).
      chatMessageDeps: chatMessaging,
      // What agents promised (spec `heartbeats` §12): an agent records its
      // own, and anyone reads every agent's list.
      commitmentDeps: commitments.capabilityDeps,
      sessionCompactionDeps: {
        compaction: new AgentCompactionService({
          resolveRuntime: (sessionId: string) => runtimeRegistry.resolveForSession(sessionId),
        }),
      },
    },
    // A beat's direct room posts and chat sends are counted (spec `heartbeats` §8).
    heartbeats.withBeatBypassCount(createCapabilityAttributionObserver(activityService))
  );
  // A running extension's tools join and leave the registry (DOR-2685); every
  // open window re-fetches the catalog and the permissions page when they do.
  wireCapabilitiesChangedBroadcast(refs.capabilityRegistry, eventFanOut);
  // Extensions started at boot, before the registry existed: hand every
  // running one's tools over now, and every later start hands its own over
  // as it starts. An uninstall clears the removed extension's per-tool
  // permission settings through the one permission writer (DOR-2685).
  refs.extensionManager?.attachAgentTools({
    registry: refs.capabilityRegistry,
    forgetToolPermissions: (extensionId, extensionName) =>
      permissionService.forgetExtensionActions(extensionId, extensionName),
  });
  // Arm tier enforcement (spec `agent-trust` §3.2) now that both the approval
  // primitive and the Activity feed exist. The gate runs INSIDE `registry.invoke`
  // (DOR-467), so every surface that reaches a capability through the registry is
  // gated by construction rather than by remembering to be; the legacy marketplace
  // routes, which own their own effect, reach the same gate through
  // `authorizeCapability`. Until this call the gate REFUSES destructive
  // invocations rather than allowing them, so a wiring mistake here fails loudly
  // instead of silently opening the gate.
  // Teach the approval card to name what it is about to act on (DOR-1929). The
  // registries are the ones the tools' own handlers already use, so a card names
  // a thing exactly when the call that follows would find it.
  //
  // Wired beside the tier gate rather than inside it: this is legibility, not
  // enforcement, and the two fail in opposite directions on purpose. An unwired
  // tier gate REFUSES; unwired resolvers just leave the raw ids on the card, the
  // way they read before this existed. Nothing here may ever be able to block a
  // call — a card that cannot look up a name must still be a card.
  initApprovalSubjectResolvers({
    // `displayName` falls back to the slug, exactly as every other agent surface
    // resolves a name. Both come from the agent's own `agent.json`, so both are
    // agent-editable — which is why the card shows the id beside the name.
    agent: (id) => {
      const agent = refs.meshCore?.get(id);
      return agent ? (agent.displayName ?? agent.name) : undefined;
    },
    task: (id) => {
      const task = refs.taskStore?.getTask(id);
      return task ? (task.displayName ?? task.name) : undefined;
    },
    // What a person calls the room: `#slug` for a channel, the title otherwise,
    // the same rule the client's `roomDisplayTitle` follows.
    room: (id) => {
      const room = roomStore.getRoom(id);
      if (!room) return undefined;
      return room.kind === 'channel' && room.slug ? `#${room.slug}` : room.title;
    },
  });
  initCapabilityTierGate({
    approvals: approvalService,
    onAttempt: createCapabilityGateAuditObserver(activityService),
  });
  // Wire the permission half of the same gate (spec `agent-permissions` D6):
  // the live `permissions` config section, read per call like everything else
  // this gate decides on. The agent's own overrides are read fresh off its
  // manifest file by the default source.
  // A Files & commands stop moved through a general config door (the Runtimes
  // settings, `PATCH /api/config`, or a config patch a person approved) is a
  // permission change like any other, so it lands in the permission history
  // (spec `agent-permissions` D10). The preset writes its stop itself and
  // records it with the preset, so it does not come through here.
  onTrustStopChange((moves, write) => {
    void recordPermissionChange(activityService, {
      changes: moves.map((move) => ({
        target: { kind: 'default' },
        key: { kind: 'files', ...(move.runtime ? { runtime: move.runtime } : {}) },
        before: move.before,
        after: move.after,
      })),
      surface: write.writer.kind === 'agent' ? 'agent-request' : 'api',
      // A general config door cannot say who is behind it; an agent's patch
      // reached a trust stop only because a person approved it on a card.
      writer:
        write.writer.kind === 'agent'
          ? agentRequestWriter({ name: write.writer.agentName ?? 'An agent' })
          : personWriter('local-trust'),
    });
  });
  if (connectorRuntimePrincipals) {
    const agentScopedRuntimePrincipals = new AgentIdentitySnapshotPrincipalPort({
      principals: connectorRuntimePrincipals,
      snapshotIdentity: ensureInSessionAgentIdentity,
      identityWasRevoked: async (agentPath) =>
        (await getAgentIdentityService()?.describeAgent(agentPath))?.inactive === 'revoked',
    });
    refs.connectorRuntimeMcpListener = await startConnectorRuntimeMcpListener({
      principals: agentScopedRuntimePrincipals,
      serverFactory: (principal) =>
        createConnectorRuntimeMcpServer(refs.capabilityRegistry!, principal),
      agentServerFactory: async (principal) => {
        const identity = await agentScopedRuntimePrincipals.identityFor(principal);
        if (!identity) return null;
        // What a Blocked permission hides from this agent (spec
        // `agent-permissions` D15), read fresh for this turn.
        const visibility = await resolveToolVisibilityFor(identity.agentPath, {
          inactive: Boolean(identity.inactive),
        });
        // A runtime that cannot summarize on request is not offered the tool
        // that asks it to (DOR-2732).
        const claims = principal.claims;
        const runtimeCaps =
          claims.kind === 'runtime'
            ? runtimeRegistry
                .listRuntimes()
                .find((runtime) => runtime.type === claims.runtime)
                ?.getCapabilities()
            : undefined;
        const hidden = runtimeCaps
          ? new Set([...visibility.hiddenToolNames, ...compactionToolsHiddenFor(runtimeCaps)])
          : visibility.hiddenToolNames;
        return createAgentRuntimeMcpServer(refs.capabilityRegistry!, principal, identity, hidden);
      },
    });
    for (const runtime of runtimeRegistry.listRuntimes()) {
      connectorRuntimeConsumer(runtime)?.setConnectorRuntimeTools({
        principals: agentScopedRuntimePrincipals,
        threadKeys: connectorThreadKeys,
        listenerUrl: refs.connectorRuntimeMcpListener.url,
        agentToolsUrl: refs.connectorRuntimeMcpListener.agentUrl,
        isConnectorCapabilityId: isConnectorRuntimeCapabilityId,
        accessSnapshot: (agentId, sessionId) =>
          connectorAccess.accessSnapshot(connectorOwner, agentId, sessionId),
      });
    }
    if (env.DORKOS_TEST_RUNTIME) {
      const callRuntimeConnectorTool = async (input: {
        readonly sessionId: string;
        readonly agentPath: string;
        readonly signal: AbortSignal;
        readonly name: 'connectors.request_connection' | 'connectors.execute_read';
        readonly arguments: Record<string, unknown>;
      }) => {
        await runtimeRegistry.persistSessionRuntime(
          input.sessionId,
          'claude-code',
          { kind: 'test-harness' },
          input.agentPath
        );
        let ownsBinding = true;
        const binding = await connectorRuntimePrincipals.openTurn(
          {
            runtime: 'claude-code',
            canonicalSessionId: input.sessionId,
            agentPath: input.agentPath,
            canonicalCwd: input.agentPath,
            signal: input.signal,
          },
          { isCurrent: () => ownsBinding && !input.signal.aborted }
        );
        const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
          import('@modelcontextprotocol/sdk/client/index.js'),
          import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
        ]);
        const client = new Client(
          { name: 'dorkos-e2e-connector-request', version: '1.0.0' },
          { capabilities: {} }
        );
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(refs.connectorRuntimeMcpListener!.url), {
              requestInit: {
                headers: connectorRuntimeHeaders({
                  bearer: binding.bearer,
                  runtime: 'claude-code',
                  canonicalCwd: input.agentPath,
                }),
              },
            })
          );
          return await client.callTool(
            {
              name: input.name,
              arguments: input.arguments,
            },
            undefined,
            { signal: input.signal, timeout: 120_000 }
          );
        } finally {
          ownsBinding = false;
          await client.close().catch(() => {});
          await connectorRuntimePrincipals.revoke(binding.bindingId, 'turn_terminal');
        }
      };
      const runtimeRequestProbe: ConnectorRuntimeRequestProbe = (input) =>
        callRuntimeConnectorTool({
          ...input,
          name: 'connectors.request_connection',
          arguments: { ...input.request },
        });
      const runtimeExecutionProbe: ConnectorRuntimeExecutionProbe = (input) =>
        callRuntimeConnectorTool({
          ...input,
          name: 'connectors.execute_read',
          arguments: { ...input.target },
        });
      if (deps.testControl) {
        deps.testControl.connectorRequestProbe = () => runtimeRequestProbe;
        deps.testControl.connectorExecutionProbe = () => runtimeExecutionProbe;
      }
    }
    logger.info('[Connectors] Runtime execution listener initialized');
  }
  connectorRoutes.execution = {
    connectorRegistry,
    capabilities: refs.capabilityRegistry,
    authorization: connectorAuthorization,
    access: connectorAccess,
    programPrincipals: connectorProgramPrincipals,
    eventAccess: new ConnectorEventAccessQueryService(
      connectorEventSubscriptions,
      { ownsAgent: connectorOwnsAgent },
      connectorProgramPrincipals,
      managedEventConsent
    ),
    ...connectorOwnerBoundary,
  };
  // GET /api/capabilities/catalog — the self-description catalog. (The bare
  // `/api/capabilities` path already serves the per-runtime capability matrix, a
  // different, client-facing contract; the registry catalog lives one segment
  // deeper.) Declared as the `capabilities.list` capability's `http` surface so it
  // projects into OpenAPI (task 2.5).
  //
  // POST /api/capabilities/:id/invoke — the generic capability dispatch endpoint
  // (task 2.4). Dispatches through the same composed registry, so every
  // capability is reachable by id; it rides the `/api` chain's session gate,
  // giving it the standard `/api/*` auth posture — not the tokenless `/mcp`
  // read-only carve-out — so mutating capabilities are never reachable
  // tokenlessly. Both are served from the Hono `/api` app (`http/hono-api.ts`).
  deps.capabilities = refs.capabilityRegistry;
  logger.info(
    `[Capabilities] Registry composed (${refs.capabilityRegistry.capabilities.length} capabilities); catalog at GET /api/capabilities/catalog, invoke at POST /api/capabilities/:id/invoke`
  );

  // Inject relay into every registered runtime (a no-op for all runtimes today;
  // the method survives on the interface for future relay-aware runtimes).
  // Registry-wide rather than default-only: a relay-aware runtime needs the
  // relay whether or not it happens to be `runtimes.default`.
  if (refs.relayCore) {
    for (const runtime of runtimeRegistry.listRuntimes()) {
      runtime.setRelay?.(refs.relayCore);
    }
  }
}
