/**
 * The connector services built on the registered providers: sign-in refresh,
 * lifecycle, management, reconciliation, usage, managed mirrors, event
 * subscriptions and grants, operator queries and principals.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/connector-services
 */
import { SignInRefresher } from '../../services/connectors/resources/sign-in-refresh.js';
import { createConnectorAccess } from '../../services/connectors/access/connector-access.js';
import { configManager } from '../../services/core/config-manager.js';
import { ConnectorAuthenticationFlowService } from '../../services/connectors/resources/authentication-flow-service.js';
import { logger } from '../../lib/logger.js';
import { ConnectorLifecycleService } from '../../services/connectors/resources/lifecycle-service.js';
import { ConnectorManagementActionService } from '../../services/connectors/management-action-service.js';
import { ConnectorManagementReviewService } from '../../services/connectors/management-review-service.js';
import { applyTrustedStoresAtBoot } from '../../services/mesh/seed-open-mesh.js';
import { ConnectorUsageStore } from '../../services/connectors/execution/usage-store.js';
import { ManagedUsageMirrorService } from '../../services/connectors/execution/managed-usage-mirror-service.js';
import { getCloudLinkManager } from '../../services/core/auth/cloud-link.js';
import { ManagedConnectorCloudError } from '../../services/core/auth/cloud-link-client.js';
import type { ConnectorOwnerAuthority } from '../../services/connectors/principal/server-principal.js';
import { ConnectorSubscriptionService } from '../../services/connectors/events/subscription-service.js';
import { ConnectorEventGrantService } from '../../services/connectors/events/grant-service.js';
import { ConnectorEventSessionSourceAdapter } from '../../services/connectors/events/session-source-adapter.js';
import { CanonicalConnectorEventSessionTarget } from '../../services/connectors/events/session-target.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { ManagedConnectorEventPullService } from '../../services/connectors/events/managed-pull-service.js';
import { ConnectorAppActionsService } from '../../services/connectors/resources/app-actions-service.js';
import { CatalogLogoService } from '../../services/connectors/resources/catalog-logos.js';
import { ConnectorOperatorQueryService } from '../../services/connectors/resources/operator-query-service.js';
import { ConnectorExecutionAuthorizationService } from '../../services/connectors/execution/authorization-service.js';
import { ConnectorProgramPrincipalService } from '../../services/connectors/principal/program-principal-service.js';
import { ConnectorRuntimePrincipalService } from '../../services/connectors/principal/runtime-principal-service.js';
import { CanonicalConnectorRuntimeAuthorityResolver } from '../../services/connectors/principal/runtime-authority-resolver.js';
import { connectorThreadKeys } from '../../services/connectors/principal/thread-keys.js';
import { CanonicalConnectorAgentRequestAuthority } from '../../services/connectors/agent-request-authority.js';
import { ConnectorAgentRequestSourceAdapter } from '../../services/connectors/agent-request-service.js';
import { DocBatchAdmission } from '../../services/canvas/doc-channel/delivery/batch-admission.js';
import { privateDocTurnBudget } from '../../services/canvas/doc-channel/delivery/final-budget.js';
import { setPrivateSessionMessageAcceptanceService } from '../../services/session/index.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { WireConnectorEventsAndApprovalsResult } from './connector-events-approvals.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { WireRoomsResult } from './rooms.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link wireConnectorServices} reads from the startup steps before it. */
export interface WireConnectorServicesInput {
  connectorRegistry: WireCoreStoresResult['connectorRegistry'];
  connectorBootstrapper: WireConnectorEventsAndApprovalsResult['connectorBootstrapper'];
  db: OpenConfigAndDatabaseResult['db'];
  connectorBootEpoch: WireCoreStoresResult['connectorBootEpoch'];
  managedConnectorAuthority: WireConnectorEventsAndApprovalsResult['managedConnectorAuthority'];
  activityService: WireCoreStoresResult['activityService'];
  connectorAuthorityCleanup: WireCoreStoresResult['connectorAuthorityCleanup'];
  connectorOwner: WireCoreStoresResult['connectorOwner'];
  roomService: WireRoomsResult['roomService'];
  resolveOperatorAuthorId: WireRoomsResult['resolveOperatorAuthorId'];
  connectorEventSubscriptions: WireConnectorEventsAndApprovalsResult['connectorEventSubscriptions'];
  connectorEventSettings: WireConnectorEventsAndApprovalsResult['connectorEventSettings'];
  connectorEventIngress: WireConnectorEventsAndApprovalsResult['connectorEventIngress'];
  managedCloudProviderInstanceId: WireConnectorEventsAndApprovalsResult['managedCloudProviderInstanceId'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  docChannelRuntimePrincipals: WireRoomsResult['docChannelRuntimePrincipals'];
  docChannelHttp: WireConnectorEventsAndApprovalsResult['docChannelHttp'];
  canvasDocuments: WireRoomsResult['canvasDocuments'];
  messageQueueStore: WireCoreStoresResult['messageQueueStore'];
}

/**
 * Wire the connector services over the registered providers.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function wireConnectorServices(refs: ServerRefs, built: WireConnectorServicesInput) {
  const {
    connectorRegistry,
    connectorBootstrapper,
    db,
    connectorBootEpoch,
    managedConnectorAuthority,
    activityService,
    connectorAuthorityCleanup,
    connectorOwner,
    roomService,
    resolveOperatorAuthorId,
    connectorEventSubscriptions,
    connectorEventSettings,
    connectorEventIngress,
    managedCloudProviderInstanceId,
    dorkHome,
    docChannelRuntimePrincipals,
    docChannelHttp,
    canvasDocuments,
    messageQueueStore,
  } = built;
  // Sign-ins can end at the service without DorkOS taking part: list each
  // way's accounts every 15 minutes (and when the owner opens Connections) so
  // an expired sign-in stops showing as working.
  const connectorSignIns = new SignInRefresher({
    registry: connectorRegistry,
    ways: connectorBootstrapper,
  });
  connectorSignIns.start();
  refs.stopConnectorFreshness = () => {
    connectorSignIns.stop();
    connectorBootstrapper.stop();
  };
  const grantAccess = createConnectorAccess({
    db,
    registry: connectorRegistry,
    bootEpoch: connectorBootEpoch,
    agents: () => refs.meshCore?.list() ?? [],
    managedAuthority: managedConnectorAuthority,
    activity: activityService,
    config: configManager,
  });
  const { reconciliation: connectorReconciliation, levels: connectorLevels } = grantAccess;
  const connectorAuthenticationFlows = new ConnectorAuthenticationFlowService({
    db,
    registry: connectorRegistry,
    sharing: grantAccess.sharing,
  });
  const interruptedConnectorStarts = connectorAuthenticationFlows.invalidateInterruptedStarts();
  if (interruptedConnectorStarts > 0) {
    logger.warn('[Connectors] Invalidated interrupted authentication starts', {
      count: interruptedConnectorStarts,
    });
  }
  const connectorLifecycle = new ConnectorLifecycleService({
    db,
    registry: connectorRegistry,
    authenticationFlows: connectorAuthenticationFlows,
    authorityCleanup: connectorAuthorityCleanup,
    managed: managedConnectorAuthority,
  });
  const connectorManagementActions = new ConnectorManagementActionService({
    db,
    registry: connectorRegistry,
    authorityCleanup: connectorAuthorityCleanup,
    lifecycle: connectorLifecycle,
    managedAuthority: managedConnectorAuthority,
  });
  const connectorManagementReviews = new ConnectorManagementReviewService({
    db,
    registry: connectorRegistry,
    authenticationFlows: connectorAuthenticationFlows,
    actions: connectorManagementActions,
    bootEpoch: connectorBootEpoch,
    resolveAgent: (_owner, agentId) => {
      if (!refs.meshCore?.getProjectPath(agentId)) return undefined;
      const agent = refs.meshCore.get(agentId);
      return agent ? { displayName: agent.displayName ?? agent.name } : undefined;
    },
  });
  // A level ("Read") follows its app's actions (ADR 260929-071355).
  connectorLevels.start();
  const stopSignInFreshness = refs.stopConnectorFreshness;
  refs.stopConnectorFreshness = () => {
    stopSignInFreshness?.();
    connectorLevels.stop();
  };
  // The Trusted defaults that live outside config.json, once per install
  // (spec `trusted-by-default-flip` §5.3, §5.6): our agents may message each
  // other across projects, and an app nobody was given is shared with every
  // agent. A person who narrows either later keeps their choice.
  await applyTrustedStoresAtBoot(configManager, logger, {
    mesh: refs.meshCore,
    relayReady: refs.relayCore !== undefined,
    connections: grantAccess.sharing,
  });
  const connectorUsage = new ConnectorUsageStore(db);
  const recoveredConnectorAttempts = connectorUsage.recoverPending(new Date().toISOString());
  if (recoveredConnectorAttempts > 0) {
    logger.warn('[Connectors] Recovered interrupted execution attempts', {
      count: recoveredConnectorAttempts,
    });
  }
  const managedUsageMirrors = new ManagedUsageMirrorService({
    db,
    cloud: getCloudLinkManager(),
    onRecoveryError: (attemptId, error) => {
      logger.warn('[Connectors] Managed receipt recovery deferred', {
        attemptId,
        error: error instanceof Error ? error.name : 'unknown_error',
        ...(error instanceof ManagedConnectorCloudError
          ? { code: error.code, status: error.status }
          : {}),
      });
    },
  });
  getCloudLinkManager().setManagedReceiptObserver((receipt) =>
    managedUsageMirrors.observe(receipt)
  );
  const connectorOwnsAgent = (owner: ConnectorOwnerAuthority, agentId: string): boolean =>
    owner.kind === connectorOwner.kind &&
    owner.kind === 'local_install' &&
    owner.installationId === connectorOwner.installationId &&
    refs.meshCore?.getProjectPath(agentId) !== undefined;
  const connectorEventDestinations = {
    authorize: (
      owner: ConnectorOwnerAuthority,
      agentId: string,
      destination: import('@dorkos/shared/connector-event-schemas').ConnectorEventDestination
    ): boolean => {
      if (!connectorOwnsAgent(owner, agentId)) return false;
      if (destination.kind === 'agent') return destination.id === agentId;
      if (destination.kind === 'room') {
        const room = roomService.getRoom(destination.id, resolveOperatorAuthorId());
        const agentPath = refs.meshCore?.getProjectPath(agentId);
        return Boolean(
          room &&
          !room.archived &&
          agentPath &&
          roomService
            .listAgentMembers(destination.id)
            .some((member) => member.agentPath === agentPath)
        );
      }
      const binding = refs.adapterManager?.getBindingStore()?.getById(destination.id);
      return Boolean(
        binding &&
        binding.agentId === agentId &&
        binding.enabled &&
        binding.canInitiate &&
        binding.chatId &&
        refs.adapterManager
          ?.listAdapters()
          .some((adapter) => adapter.config.id === binding.adapterId && adapter.config.enabled)
      );
    },
  };
  const connectorEventService = new ConnectorSubscriptionService(
    connectorEventSubscriptions,
    connectorRegistry,
    connectorEventDestinations
  );
  const managedEventConsent = {
    reconcile: (id: string, version: number, signal: AbortSignal) =>
      managedConnectorAuthority.reconcileEventSubscription(id, version, signal),
    ready: (id: string, version: number) =>
      managedConnectorAuthority.eventSubscriptionReady(id, version),
    stage: (id: string, version: number) =>
      managedConnectorAuthority.stageEventSubscriptionChange(id, version),
  };
  const connectorEventGrants = new ConnectorEventGrantService(
    connectorEventSubscriptions,
    connectorEventService,
    connectorEventDestinations,
    managedEventConsent
  );
  const connectorEventSessionSource = new ConnectorEventSessionSourceAdapter(
    connectorEventSubscriptions,
    connectorEventSettings,
    managedEventConsent,
    new CanonicalConnectorEventSessionTarget({
      db,
      sessions: runtimeRegistry,
      ownsAgent: connectorOwnsAgent,
    }),
    connectorBootEpoch
  );
  const connectorEventPull = new ManagedConnectorEventPullService(
    getCloudLinkManager(),
    connectorEventIngress,
    () => {
      const linkGeneration = getCloudLinkManager().managedConnectorMaterialDigest();
      if (!linkGeneration) return undefined;
      const row = db.$client
        .prepare(
          "SELECT execution_config_generation FROM connector_provider_instances WHERE id = ? AND mode = 'managed' AND status = 'available'"
        )
        .get(managedCloudProviderInstanceId) as { execution_config_generation: number } | undefined;
      return row
        ? {
            providerInstanceId: managedCloudProviderInstanceId,
            providerGeneration: row.execution_config_generation,
            linkGeneration,
          }
        : undefined;
    }
  );
  const connectorAppActions = new ConnectorAppActionsService({
    db,
    registry: connectorRegistry,
    dorkHome,
  });
  // A logo's source is looked up in the kept app lists only, never listed.
  const catalogLogos = new CatalogLogoService({
    dorkHome,
    logoUrlFor: (serviceSlug) => connectorRegistry.keptLogoUrl(serviceSlug),
  });
  const connectorOperatorQueries = new ConnectorOperatorQueryService({
    db,
    registry: connectorRegistry,
    keptLogos: () => catalogLogos.keptServiceIds(),
    recoverManagedProvider: () => connectorBootstrapper.recoverManagedCloud(),
    appConnections: () => connectorBootstrapper.appConnections(),
    wayHealth: (providerInstanceId, toolkit) =>
      connectorBootstrapper.wayHealth(providerInstanceId, toolkit),
    ...(refs.adapterManager && { relay: refs.adapterManager }),
    agentOwnership: { ownsAgent: connectorOwnsAgent },
    managedUsage: getCloudLinkManager(),
    sessions: {
      resolveSessionAgent: async (owner, sessionId) => {
        if (
          owner.kind !== connectorOwner.kind ||
          owner.kind !== 'local_install' ||
          owner.installationId !== connectorOwner.installationId
        ) {
          return undefined;
        }
        const agentPath = await runtimeRegistry.getSessionAgentPath(sessionId);
        const agent = agentPath ? refs.meshCore?.getByPath(agentPath) : undefined;
        return agent ? { agentId: agent.id } : undefined;
      },
    },
  });
  const connectorAuthorization = new ConnectorExecutionAuthorizationService(
    db,
    connectorRegistry,
    { ownsAgent: connectorOwnsAgent },
    (providerInstanceId, toolkit) => connectorBootstrapper.wayHealth(providerInstanceId, toolkit)
  );
  const connectorProgramPrincipals = new ConnectorProgramPrincipalService(db);
  const connectorRuntimePrincipals = refs.meshCore
    ? new ConnectorRuntimePrincipalService({
        db,
        authority: new CanonicalConnectorRuntimeAuthorityResolver({
          sessions: runtimeRegistry,
          mesh: refs.meshCore,
          owner: connectorOwner,
        }),
        threadKeys: connectorThreadKeys,
      })
    : undefined;
  if (connectorRuntimePrincipals) await connectorRuntimePrincipals.initializeBoot();
  docChannelRuntimePrincipals.current = connectorRuntimePrincipals;

  const requestAuthority =
    connectorRuntimePrincipals && refs.meshCore
      ? new CanonicalConnectorAgentRequestAuthority({
          db,
          sessions: runtimeRegistry,
          mesh: refs.meshCore,
          owner: connectorOwner,
        })
      : undefined;
  const existingPrivateSources = requestAuthority
    ? [
        new ConnectorAgentRequestSourceAdapter(
          db,
          requestAuthority,
          connectorBootEpoch,
          connectorEventGrants
        ),
        connectorEventSessionSource,
      ]
    : [];
  const docBatchAdmission = new DocBatchAdmission({
    db,
    store: docChannelHttp.channels,
    grants: docChannelHttp.grants,
    lifecycle: canvasDocuments.lifecycle,
    queue: messageQueueStore,
    bootEpoch: connectorBootEpoch,
    existingSources: existingPrivateSources,
    beforeClaim: privateDocTurnBudget,
  });
  const recoveredPrivateAttempts = docBatchAdmission.initializeBoot();
  const privateAcceptance = docBatchAdmission.acceptance;
  setPrivateSessionMessageAcceptanceService(privateAcceptance);
  if (recoveredPrivateAttempts > 0)
    logger.warn('[session messages] Quarantined interrupted private messages', {
      count: recoveredPrivateAttempts,
    });
  const docDispatchLifetime = new AbortController();
  return {
    connectorSignIns,
    connectorReconciliation,
    connectorAuthenticationFlows,
    connectorLifecycle,
    connectorManagementReviews,
    connectorUsage,
    managedUsageMirrors,
    connectorOwnsAgent,
    connectorEventDestinations,
    connectorEventService,
    managedEventConsent,
    connectorEventGrants,
    connectorEventSessionSource,
    connectorEventPull,
    connectorAppActions,
    catalogLogos,
    connectorOperatorQueries,
    connectorAuthorization,
    connectorProgramPrincipals,
    connectorRuntimePrincipals,
    requestAuthority,
    docBatchAdmission,
    privateAcceptance,
    docDispatchLifetime,
  };
}

/** What {@link wireConnectorServices} hands the steps after it. */
export type WireConnectorServicesResult = Awaited<ReturnType<typeof wireConnectorServices>>;
