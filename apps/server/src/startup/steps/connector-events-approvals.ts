/**
 * Connector event intake, the approval service and its expiry sweep, the
 * document channel, and the connector provider bootstrapper.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/connector-events-approvals
 */
import { ConnectorSubscriptionStore } from '../../services/connectors/events/subscription-store.js';
import { ConnectorEventInboxStore } from '../../services/connectors/event-inbox-store.js';
import { ConnectorEventSettingsService } from '../../services/connectors/events/settings-service.js';
import { credentialProvider, credentialStore } from '../../services/core/credential-provider.js';
import { ConnectorEventIngressService } from '../../services/connectors/events/ingress-service.js';
import { logger, logError } from '../../lib/logger.js';
import type { ConnectorSignedIngress } from '../../services/connectors/events/signed-ingress.js';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import {
  resolveApprovalTtlMs,
  ApprovalService,
  startApprovalVerdictDelivery,
  runApprovalExpiryTick,
  startApprovalExpirySweep,
} from '../../services/core/approvals/index.js';
import { env } from '../../env.js';
import { createAlwaysSuggestion } from '../../services/core/permissions/index.js';
import { projectRegistry } from '../../services/projects/project-registry.js';
import { describeHookProjectionCapability } from '../../services/harness/hook-approval.js';
import { describeGlobalActivationCapability } from '../../services/marketplace/consent/ask-withheld-global-plugins.js';
import {
  describeTemplateCreationCapability,
  describeWorkspaceCreationCapability,
} from '../../services/marketplace-mcp/confirmation-provider.js';
import { DocChannelMetrics } from '../../services/observability/doc-channel-metrics.js';
import { createDocChannelHttpComposition } from '../../services/canvas/doc-channel/http-composition.js';
import { DocChannelLiveBuffer } from '../../services/canvas/doc-channel/streams/live-buffer.js';
import { subscribeCommittedDocEvents } from '../../services/canvas/doc-channel/committed-events.js';
import { setDocScopeNotificationsFactory } from '../../services/canvas/doc-channel/streams/registry.js';
import { DocScopeStream } from '../../services/canvas/doc-channel/streams/scope-stream.js';
import {
  type StandingCondition,
  getEscalationService,
} from '../../services/notifications/escalation-service.js';
import { capabilityApprovalPayload } from '../../services/notifications/emitters/capability-approval.js';
import { ManagedConnectorExecutionContextStore } from '../../services/connectors/execution/managed-execution-context.js';
import { legacyDefaultProviderInstanceId } from '../../services/connectors/legacy-connection-migration.js';
import { localDialHost } from '../../lib/local-dial-host.js';
import { ManagedAuthoritySyncService } from '../../services/connectors/resources/managed-authority-sync-service.js';
import { getCloudLinkManager } from '../../services/core/auth/cloud-link.js';
import {
  ConnectorProviderBootstrapper,
  TEST_CONNECTOR_PROVIDER_TYPE,
} from '../../services/connectors/bootstrap.js';
import { createRawMcpPendingConnectResolver } from '../../services/connectors/resources/raw-mcp-pending-connect.js';
import { configManager } from '../../services/core/config-manager.js';
import { recordConnectionsClosedByNewLink } from '../../services/connectors/app-connection-way.js';
import { ManagedCloudConnectorProvider } from '../../services/connectors/providers/managed/managed-cloud.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { WireRoomsResult } from './rooms.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link wireConnectorEventsAndApprovals} reads from the startup steps before it. */
export interface WireConnectorEventsAndApprovalsInput {
  db: OpenConfigAndDatabaseResult['db'];
  connectorBootEpoch: WireCoreStoresResult['connectorBootEpoch'];
  connectorRegistry: WireCoreStoresResult['connectorRegistry'];
  roomStore: WireRoomsResult['roomStore'];
  canvasDocuments: WireRoomsResult['canvasDocuments'];
  roomService: WireRoomsResult['roomService'];
  roomRepoStore: WireRoomsResult['roomRepoStore'];
  connectorInstallationId: WireCoreStoresResult['connectorInstallationId'];
  docChannelRuntimePrincipals: WireRoomsResult['docChannelRuntimePrincipals'];
  PORT: number;
  connectorOwner: WireCoreStoresResult['connectorOwner'];
  activityService: WireCoreStoresResult['activityService'];
}

/**
 * Wire connector events, approvals, the document channel and the connector providers.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function wireConnectorEventsAndApprovals(
  refs: ServerRefs,
  built: WireConnectorEventsAndApprovalsInput
) {
  const {
    db,
    connectorBootEpoch,
    connectorRegistry,
    roomStore,
    canvasDocuments,
    roomService,
    roomRepoStore,
    connectorInstallationId,
    docChannelRuntimePrincipals,
    PORT,
    connectorOwner,
    activityService,
  } = built;
  const connectorEventSubscriptions = new ConnectorSubscriptionStore(db);
  const connectorEventInbox = new ConnectorEventInboxStore({ db, bootEpoch: connectorBootEpoch });
  const connectorEventSettings = new ConnectorEventSettingsService(
    db,
    credentialProvider,
    credentialStore,
    async () => {
      await connectorBootstrapper.reload('composio');
    }
  );
  const connectorEventIngress = new ConnectorEventIngressService(
    connectorEventSubscriptions,
    connectorEventInbox,
    connectorEventSettings
  );

  const recoverConnectorEventDelivery = async (): Promise<void> => {
    try {
      await refs.connectorEventDelivery?.recover(AbortSignal.timeout(25_000));
    } catch {
      logger.warn('[Connections] Notification delivery deferred');
    }
  };
  // The signed webhook ingress, served from the Hono `/api` app before any
  // body is parsed (`services/connectors/events/signed-ingress.ts`).
  const connectorSignedIngress: ConnectorSignedIngress = {
    verifier: (id) =>
      connectorRegistry.resolveProviderInstance(id as ConnectorProviderInstanceId)?.events,
    accept: (id, event) => {
      const accepted = connectorEventIngress.accept(id, event);
      void recoverConnectorEventDelivery();
      return accepted;
    },
  };

  // Approval primitive (spec `agent-trust` §3.3) — one instance, injected into
  // the marketplace confirmation provider and the approvals router so they share
  // a single token lifecycle. Built after `capabilityRegistry` is declared so
  // `describeCapability` can read it lazily: the card's title and tier come from
  // the registry rather than from whoever is asking, and the registry is composed
  // from the very domains that request approvals (a static import would cycle).
  // The sweep drops rows whose window closed over a day ago; expiry itself is
  // enforced whenever a token is presented, never by this call.
  // `DORKOS_APPROVAL_TTL_MS` can only SHORTEN the window — the clamp lives in
  // `resolveApprovalTtlMs`, beside the default it clamps against (DOR-498).
  const approvalTtlMs = resolveApprovalTtlMs(env.DORKOS_APPROVAL_TTL_MS);
  const approvalService = new ApprovalService(db, {
    ...(approvalTtlMs !== undefined ? { ttlMs: approvalTtlMs } : {}),
    // A request a room's own turn raised is shown in that room (spec
    // `agent-permissions` D7). The binding follows a session's rekey, which is
    // why it is resolved when a card is read rather than stored.
    roomForSession: (sessionId) => roomStore.sessionLedger.bindingForSession(sessionId)?.roomId,
    // After three one-time Allows in a week for the same agent and action, the
    // next card suggests Always allow, until "Not now" (spec
    // `agent-permissions`). Read from the permission history in the same
    // database, when each card is read.
    suggestAlways: createAlwaysSuggestion(db),
    // The project the asking session's folder belongs to, when the registry
    // already knows it (spec `flow-multiproject` §6.2); a card never waits on git.
    projectForFolder: (cwd) => projectRegistry.peek(cwd),
    describeCapability: (capabilityId) => {
      const capability = refs.capabilityRegistry?.get(capabilityId);
      if (capability) {
        return {
          title: capability.title,
          tier: capability.tier,
          // An extension's tool names its extension, so its card can say so.
          ...(capability.source ? { source: capability.source } : {}),
        };
      }
      // Two ids that are not capabilities anyone can invoke: the card raised when
      // an installed package wants to write shell commands into a coding agent's
      // hook files (DOR-522), and the one a global package raises before its
      // programs load into every session (DOR-2306). Without these the card
      // would show the raw id.
      return (
        describeHookProjectionCapability(capabilityId) ??
        describeGlobalActivationCapability(capabilityId) ??
        describeTemplateCreationCapability(capabilityId) ??
        describeWorkspaceCreationCapability(capabilityId)
      );
    },
  });
  const docChannelMetrics = new DocChannelMetrics(db);
  const docChannelHttp = createDocChannelHttpComposition({
    db,
    documents: canvasDocuments,
    rooms: roomService,
    roomStore,
    roomRepos: roomRepoStore,
    approvals: approvalService,
    installationId: connectorInstallationId,
    runtimePrincipalCurrent: (proof) =>
      docChannelRuntimePrincipals.current?.isPrincipalCurrent(proof) ?? false,
    revalidateRuntime: (proof) =>
      docChannelRuntimePrincipals.current?.revalidatePrincipal(proof) ?? Promise.resolve(false),
  });
  const docStreamAuthority = {
    resolveScope: (scope: string) => canvasDocuments.lifecycle.resolveScope(scope),
    requireScopeCurrent: (
      scope: string,
      actor: import('../../services/canvas/doc-channel/authorization.js').DocChannelActor
    ): undefined => {
      docChannelHttp.authorization.requireScopeCurrent(scope, actor);
      return undefined;
    },
    requireDocumentCurrent: (
      documentId: string,
      scope: string,
      actor: import('../../services/canvas/doc-channel/authorization.js').DocChannelActor
    ): undefined => {
      if (docChannelHttp.authorization.requireCurrent(documentId, actor).scope !== scope)
        throw new Error('Document stream scope changed.');
      return undefined;
    },
  };
  const docLive = new DocChannelLiveBuffer(docChannelHttp.channels, docStreamAuthority);
  const disposeDocNotifications = subscribeCommittedDocEvents(db, (documentId) => {
    docLive.notifyCommitted(documentId);
    return undefined;
  });
  refs.docNotificationCleanup = () => {
    disposeDocNotifications();
    setDocScopeNotificationsFactory(undefined);
  };
  const docScopes = new DocScopeStream(
    canvasDocuments,
    docChannelHttp.service,
    docLive,
    docStreamAuthority
  );
  setDocScopeNotificationsFactory(
    (scope, caller) => (signal) => docScopes.subscribe(scope, docChannelHttp.actor(caller), signal)
  );

  // An answer given after the in-session hold gave up has to reach the agent that
  // asked, or a person ends up relaying it by hand — which is the bug DOR-1931
  // reports. The subscription lives for the life of the process; its listener does
  // nothing but hand off, because `eventFanOut` runs listeners synchronously on
  // the broadcast write path (spec `approval-verdict-delivery`).
  startApprovalVerdictDelivery(approvalService);
  // Hand back the delivery claims that only a hold in a DEAD process could still
  // hold. A hold lives in process memory and holds a turn open, so none survives
  // a restart — and without this sweep, a restart while somebody was deciding
  // reproduced the very bug this feature fixes: the person answers at minute
  // twenty and the deliverer is locked out by a hold that died an hour ago.
  try {
    const released = approvalService.releaseStaleVerdictClaims();
    if (released > 0) {
      logger.info(`[Approvals] Released ${released} verdict claim(s) stranded by a restart`);
    }
  } catch (err) {
    logger.warn('[Approvals] Failed to release stranded verdict claims (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // One expiry tick right now, then the same tick on a timer. Settling lapsed
  // approvals is what stops expiry being the one ending nothing announces: until
  // this ran, an unanswered approval emitted no event at all, and the agent that
  // asked was never told its request had lapsed (spec `approval-expiry-notice`,
  // DOR-1932).
  //
  // Run once HERE as well as on the interval, because the tick's settle-before-
  // purge order only matters after the server has been DOWN past the retention
  // window — and the interval's first tick is up to a minute away. The retention
  // purge rides along, which is also the fix for it having only ever run at boot:
  // a server up for a month never trimmed the table after its first second.
  const firstTick = runApprovalExpiryTick(approvalService);
  if (firstTick.settled > 0) {
    logger.info(`[Approvals] Settled ${firstTick.settled} approval(s) that expired unanswered`);
  }
  if (firstTick.purged > 0) {
    logger.info(`[Approvals] Purged ${firstTick.purged} long-expired approval records`);
  }
  refs.stopApprovalExpirySweep = startApprovalExpirySweep(
    approvalService,
    approvalService.expirySweepIntervalMs
  );
  // Catch the escalation ladder up on approvals that were already waiting when
  // this process started (DOR-1570) — the second standing condition that
  // outlives a restart, and the more dangerous one: an approval is an agent
  // asking to do something irreversible. Runs AFTER the purge, so nothing
  // long-expired is re-armed, and the ladder's own ledger and four-hour
  // catch-up window keep it idempotent and bounded exactly as they do for
  // parked schedules.
  //
  // No agent path is resolved here, unlike the live edge: `listPending`
  // returns the operator-facing card, which deliberately keeps
  // `requestedByPath` off the wire. The consequence is bounded — the path only
  // chooses WHICH agent's chat binding carries the message, and
  // `pickRelayAgent` falls back to the newest binding that may initiate, which
  // is the same person's phone either way.
  try {
    const stillPending: StandingCondition[] = approvalService
      .listPending()
      .map((approval) => ({
        kind: 'approval.pending' as const,
        payload: capabilityApprovalPayload(approval),
        since: Date.parse(approval.requestedAt),
      }))
      .filter((condition) => Number.isFinite(condition.since));
    getEscalationService()?.rearmFromStandingState(stillPending);
  } catch (err) {
    logger.warn('[Escalation] Could not re-arm from pending approvals', logError(err));
  }
  const managedExecutionContexts = new ManagedConnectorExecutionContextStore();
  const managedCloudProviderInstanceId = legacyDefaultProviderInstanceId(
    'dorkos-managed'
  ) as ConnectorProviderInstanceId;
  // Provider lifecycle is owned by ONE place (connector-completion spec §1):
  // boot registers raw-MCP always (from `connectors.rawMcpServers` config; the
  // empty list is valid) plus Composio/Nango when configured — silent-null when
  // unconfigured, loud NangoEncryptionKeyError refusal logged-and-skipped while
  // the server still boots. The credential routes call `reload()` after a key
  // write/delete, so saving a vendor key registers its provider live, no
  // restart required. In test mode the `test-connector` spec joins so e2e can
  // exercise the save-key step; its scripted provider is dynamic-imported
  // inside the factory (same pattern as TestModeRuntime above) so the
  // production module graph never loads it.
  const localOrigin = `http://${localDialHost(env.DORKOS_HOST)}:${PORT}`;
  if (env.DORKOS_TEST_RUNTIME) {
    const { startTestComposioFixture } =
      await import('../../services/connectors/providers/test-composio/fixture.js');
    refs.testComposioFixture = await startTestComposioFixture({ testRuntime: true, localOrigin });
    const { addTestControlGroup } = await import('../../routes/test-control.js');
    addTestControlGroup('/composio', refs.testComposioFixture.routes);
    const { createTestDocRouteGroup } = await import('../../routes/test-control-doc-routes.js');
    addTestControlGroup('/doc-routes', createTestDocRouteGroup(docChannelHttp));
  }
  // Built before the ways register: linking the DorkOS account again (seen as
  // early as boot) sends what the old link refused or never applied again.
  const managedConnectorAuthority = new ManagedAuthoritySyncService({
    db,
    cloud: getCloudLinkManager(),
  });
  const connectorBootstrapper = new ConnectorProviderBootstrapper({
    ...(refs.testComposioFixture && { composioBaseUrl: refs.testComposioFixture.baseUrl }),
    registry: connectorRegistry,
    credentials: credentialProvider,
    composioWebhookSecretRef: () =>
      connectorEventSettings.webhookSecretRef(legacyDefaultProviderInstanceId('composio')),
    nangoEnv: () => ({
      ...(env.NANGO_BASE_URL !== undefined && { baseUrl: env.NANGO_BASE_URL }),
      ...(env.NANGO_ENCRYPTION_KEY !== undefined && { encryptionKey: env.NANGO_ENCRYPTION_KEY }),
    }),
    rawMcpPendingConnect: createRawMcpPendingConnectResolver({
      db,
      registry: connectorRegistry,
      owner: connectorOwner,
    }),
    rawMcpServers: () =>
      configManager.get('connectors').rawMcpServers.map((server) => ({
        slug: server.slug,
        displayName: server.displayName,
        connection: { transport: server.transport, url: server.url },
      })),
    onRelinked: (providerInstanceId) => {
      void managedConnectorAuthority
        .restageAfterRelink(providerInstanceId, AbortSignal.timeout(60_000))
        .catch((error: unknown) => {
          logger.warn(
            '[Connectors] Could not send changes again after linking again',
            logError(error)
          );
        });
    },
    onClosedByNewLink: (closed) => {
      void recordConnectionsClosedByNewLink(activityService, closed).catch((err: unknown) =>
        logger.warn('[Connectors] Could not record connections closed by a new link', { err })
      );
    },
    managedCloud: {
      instanceId: managedCloudProviderInstanceId,
      configured: () => getCloudLinkManager().getSummary().linked,
      executionConfigDigest: () => getCloudLinkManager().managedConnectorMaterialDigest(),
      create: () =>
        new ManagedCloudConnectorProvider({
          instanceId: managedCloudProviderInstanceId,
          cloud: getCloudLinkManager(),
          executionContext: (command) => managedExecutionContexts.resolve(command),
        }),
    },
    ...(env.DORKOS_TEST_RUNTIME && {
      testConnector: {
        create: async () => {
          const { maybeCreateTestModeConnectorProvider } =
            await import('../../services/connectors/providers/test-mode.js');
          return maybeCreateTestModeConnectorProvider({
            credentials: credentialProvider,
            // Test-mode connect flows use the actual dial origin of this server.
            localOrigin,
            // A saved-again key starts a brand new scripted provider whose
            // account ids never repeat (DOR-2451) — so a delete has to wipe
            // this provider's own connection history too, or a stale row
            // from an earlier key save just sits there under the same
            // stable instance id forever.
            purgeConnections: () =>
              connectorRegistry.purgeTestConnectorConnections(
                legacyDefaultProviderInstanceId(
                  TEST_CONNECTOR_PROVIDER_TYPE
                ) as ConnectorProviderInstanceId
              ),
          });
        },
      },
    }),
  });
  getCloudLinkManager().setManagedProviderSync(() => connectorBootstrapper.reloadManagedCloud());
  await connectorBootstrapper.registerBootProviders();
  return {
    connectorEventSubscriptions,
    connectorEventInbox,
    connectorEventSettings,
    connectorEventIngress,
    recoverConnectorEventDelivery,
    connectorSignedIngress,
    approvalService,
    docChannelMetrics,
    docChannelHttp,
    managedExecutionContexts,
    managedCloudProviderInstanceId,
    managedConnectorAuthority,
    connectorBootstrapper,
  };
}

/** What {@link wireConnectorEventsAndApprovals} hands the steps after it. */
export type WireConnectorEventsAndApprovalsResult = Awaited<
  ReturnType<typeof wireConnectorEventsAndApprovals>
>;
