/**
 * Document delivery to private sessions, connector agent requests, and the
 * connector access and execution broker.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/doc-delivery
 */
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  getOrCreateProjector,
  adoptAcceptedPrivateMessages,
  suspendPrivateDispatches,
  onProjectorRekey,
} from '../../services/session/index.js';
import { logger, logError } from '../../lib/logger.js';
import { DocBatchDeliveryPump } from '../../services/canvas/doc-channel/delivery/pump.js';
import { createPrivateDocPumpGates } from '../../services/canvas/doc-channel/delivery/private-gates.js';
import { DocDeliveryRunner } from '../../services/canvas/doc-channel/delivery/runner.js';
import { DocWorkReview } from '../../services/canvas/doc-channel/route-controls/work-review.js';
import {
  onProjectorTurnBoundary,
  onProjectorInteractionChange,
} from '../../services/session/session-state-projector.js';
import { ConnectorEventNativeDestination } from '../../services/connectors/events/channel-destination.js';
import { createAgentSubjectResolver } from '../../services/relay/initiate-consent.js';
import { ConnectorEventDeliveryService } from '../../services/connectors/events/delivery-service.js';
import { ConnectorAgentRequestService } from '../../services/connectors/agent-request-service.js';
import { connectorAgentRequestsChangedAnnouncer } from '../../services/core/streams/live-change-broadcasts.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { ConnectorAccessQueryService } from '../../services/connectors/execution/access-query-service.js';
import { createConnectorExecution } from '../../services/connectors/execution/create-execution.js';
import type { WireConnectorServicesResult } from './connector-services.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { WireConnectorEventsAndApprovalsResult } from './connector-events-approvals.js';
import type { WireRoomsResult } from './rooms.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link wireDocDelivery} reads from the startup steps before it. */
export interface WireDocDeliveryInput {
  docDispatchLifetime: WireConnectorServicesResult['docDispatchLifetime'];
  privateAcceptance: WireConnectorServicesResult['privateAcceptance'];
  db: OpenConfigAndDatabaseResult['db'];
  docChannelHttp: WireConnectorEventsAndApprovalsResult['docChannelHttp'];
  docBatchAdmission: WireConnectorServicesResult['docBatchAdmission'];
  connectorRuntimePrincipals: WireConnectorServicesResult['connectorRuntimePrincipals'];
  requestAuthority: WireConnectorServicesResult['requestAuthority'];
  connectorEventSubscriptions: WireConnectorEventsAndApprovalsResult['connectorEventSubscriptions'];
  connectorEventInbox: WireConnectorEventsAndApprovalsResult['connectorEventInbox'];
  connectorEventSettings: WireConnectorEventsAndApprovalsResult['connectorEventSettings'];
  managedEventConsent: WireConnectorServicesResult['managedEventConsent'];
  connectorEventSessionSource: WireConnectorServicesResult['connectorEventSessionSource'];
  roomService: WireRoomsResult['roomService'];
  connectorEventDestinations: WireConnectorServicesResult['connectorEventDestinations'];
  connectorOperatorQueries: WireConnectorServicesResult['connectorOperatorQueries'];
  connectorBootEpoch: WireCoreStoresResult['connectorBootEpoch'];
  connectorEventGrants: WireConnectorServicesResult['connectorEventGrants'];
  connectorAuthenticationFlows: WireConnectorServicesResult['connectorAuthenticationFlows'];
  roomStore: WireRoomsResult['roomStore'];
  connectorOwnsAgent: WireConnectorServicesResult['connectorOwnsAgent'];
  connectorRegistry: WireCoreStoresResult['connectorRegistry'];
  connectorBootstrapper: WireConnectorEventsAndApprovalsResult['connectorBootstrapper'];
  connectorAuthorization: WireConnectorServicesResult['connectorAuthorization'];
  connectorUsage: WireConnectorServicesResult['connectorUsage'];
  connectorProgramPrincipals: WireConnectorServicesResult['connectorProgramPrincipals'];
  managedExecutionContexts: WireConnectorEventsAndApprovalsResult['managedExecutionContexts'];
  activityService: WireCoreStoresResult['activityService'];
  sessionConnectorAttachmentStore: WireCoreStoresResult['sessionConnectorAttachmentStore'];
}

/**
 * Wire document delivery and the connector execution broker.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export function wireDocDelivery(refs: ServerRefs, built: WireDocDeliveryInput) {
  const {
    docDispatchLifetime,
    privateAcceptance,
    db,
    docChannelHttp,
    docBatchAdmission,
    connectorRuntimePrincipals,
    requestAuthority,
    connectorEventSubscriptions,
    connectorEventInbox,
    connectorEventSettings,
    managedEventConsent,
    connectorEventSessionSource,
    roomService,
    connectorEventDestinations,
    connectorOperatorQueries,
    connectorBootEpoch,
    connectorEventGrants,
    connectorAuthenticationFlows,
    roomStore,
    connectorOwnsAgent,
    connectorRegistry,
    connectorBootstrapper,
    connectorAuthorization,
    connectorUsage,
    connectorProgramPrincipals,
    managedExecutionContexts,
    activityService,
    sessionConnectorAttachmentStore,
  } = built;
  const nudgePrivateSession = (sessionId: string, documentReceiptIds?: readonly string[]): void => {
    if (documentReceiptIds && !docDeliveryRunner?.active) return;
    void Promise.all([
      runtimeRegistry.resolveForSession(sessionId),
      runtimeRegistry.getSessionAgentPath(sessionId),
    ])
      .then(([runtime, agentPath]) => {
        if (documentReceiptIds && !docDeliveryRunner?.active) return;
        if (!agentPath) return;
        const projector = getOrCreateProjector(sessionId, agentPath);
        adoptAcceptedPrivateMessages({
          sessionId,
          cwd: agentPath,
          projector,
          runtime,
          ...(documentReceiptIds
            ? {
                privateDispatchSignal: docDispatchLifetime.signal,
                privateReceiptSelection: {
                  sourceKind: 'document_event_batch' as const,
                  receiptIds: documentReceiptIds,
                },
              }
            : { excludeDocumentMessages: true }),
        });
      })
      .catch((error: unknown) => {
        logger.warn('[session messages] Could not resume a private message', logError(error));
      });
  };
  const recoverAcceptedPrivateSessions = (): void => {
    const sessionIds = privateAcceptance.listAcceptedSessionIds(
      100,
      refs.acceptedPrivateSessionCursor,
      true
    );
    refs.acceptedPrivateSessionCursor = sessionIds.length === 100 ? sessionIds.at(-1) : undefined;
    for (const sessionId of sessionIds) nudgePrivateSession(sessionId);
  };
  recoverAcceptedPrivateSessions();
  const docPump = new DocBatchDeliveryPump({
    db,
    store: docChannelHttp.channels,
    grants: docChannelHttp.grants,
    admission: docBatchAdmission,
    now: () => new Date(),
    ...createPrivateDocPumpGates({
      grants: docChannelHttp.grants,
      runtimes: runtimeRegistry,
      now: () => new Date(),
    }),
    markWaitingWarning: (batchId, generation, now, tx) =>
      docChannelHttp.channels.markWaitingWarning(batchId, generation, now, tx),
    nudge: (sessionId, receiptIds) => {
      nudgePrivateSession(sessionId, receiptIds);
      return undefined;
    },
  });
  const docDeliveryRunner = new DocDeliveryRunner({
    pump: docPump,
    now: () => new Date(),
    onError: (error) => logger.warn('[document delivery] Recovery will retry', logError(error)),
  });
  // A person's replay queues new work, and clearing in-doubt work frees its
  // route: either way the runner looks again now rather than at its next wake.
  const docWorkReview = new DocWorkReview({
    db,
    channels: docChannelHttp.channels,
    grants: docChannelHttp.grants,
    authorization: docChannelHttp.authorization,
    readChannel: (documentId, actor) => docChannelHttp.service.readChannel(documentId, actor),
    onChanged: () => docDeliveryRunner.wake(),
  });
  const stopDocInputHints = docChannelHttp.service.onCommittedInput(() =>
    docDeliveryRunner?.wake()
  );
  const stopDocTurnHints = onProjectorTurnBoundary(() => docDeliveryRunner?.wake());
  const stopDocInteractionHints = onProjectorInteractionChange((change) => {
    if (change.type === 'resolved') docDeliveryRunner?.wake();
  });
  refs.stopDocDelivery = async () => {
    stopDocInputHints();
    stopDocTurnHints();
    stopDocInteractionHints();
    const draining = Promise.all([docDeliveryRunner!.stop(), docChannelHttp.fileWrites.stop()]);
    docDispatchLifetime.abort();
    await Promise.all([draining, suspendPrivateDispatches(docDispatchLifetime.signal)]);
  };
  if (connectorRuntimePrincipals && refs.meshCore && requestAuthority) {
    const connectorEventChannels = new ConnectorEventNativeDestination({
      bindings: () => refs.adapterManager?.getBindingStore(),
      adapters: () => refs.adapterManager?.listAdapters() ?? [],
      agentSubject: createAgentSubjectResolver(refs.meshCore),
      relay: {
        deliverPrivateNotification: (subject, text, options) =>
          refs.relayCore?.deliverPrivateNotification(subject, text, options) ??
          Promise.resolve({ state: 'refused' as const }),
      },
    });
    refs.connectorEventDelivery = new ConnectorEventDeliveryService({
      subscriptions: connectorEventSubscriptions,
      inbox: connectorEventInbox,
      protection: connectorEventSettings,
      managed: managedEventConsent,
      sessions: connectorEventSessionSource,
      acceptance: privateAcceptance,
      nudgeSession: nudgePrivateSession,
      rooms: roomService,
      channels: connectorEventChannels,
      authorize: (owner, scope) =>
        connectorEventDestinations.authorize(owner, scope.agentId, {
          kind: scope.destinationKind,
          id: scope.destinationId,
        }),
    });
    refs.connectorAgentRequests = new ConnectorAgentRequestService({
      db,
      services: connectorOperatorQueries,
      runtimePrincipals: connectorRuntimePrincipals,
      authority: requestAuthority,
      bootEpoch: connectorBootEpoch,
      eventGrants: connectorEventGrants,
      authentication: connectorAuthenticationFlows,
      resume: {
        accept: (ref) => {
          privateAcceptance.accept(ref);
        },
        nudge: nudgePrivateSession,
      },
      // A request a room's own turn raised is answered in that room; the
      // binding follows a session's rekey, so it is read when a card is read.
      roomForSession: (sessionId) => roomStore.sessionLedger.bindingForSession(sessionId)?.roomId,
      onChanged: connectorAgentRequestsChangedAnnouncer(eventFanOut),
    });
    void refs.connectorAgentRequests.reconcile().catch((error: unknown) => {
      logger.warn('[Connections] Could not recover agent service requests', logError(error));
    });
  }
  const connectorAccess = new ConnectorAccessQueryService(
    db,
    {
      ownsAgent: connectorOwnsAgent,
    },
    connectorRegistry,
    {
      revalidatePrincipal: async (principal) =>
        connectorRuntimePrincipals?.revalidatePrincipal(principal) ?? false,
    },
    (providerInstanceId, toolkit) => connectorBootstrapper.wayHealth(providerInstanceId, toolkit)
  );
  const { broker: connectorBroker, holds: connectorHolds } = createConnectorExecution({
    authorization: connectorAuthorization,
    usage: connectorUsage,
    runtimePrincipals: () => connectorRuntimePrincipals,
    programPrincipals: connectorProgramPrincipals,
    managedExecutionContexts,
    signIns: connectorRegistry,
    activity: activityService,
  });
  // A brand-new session is rekeyed to its canonical id mid-first-turn. Move any
  // connector attach set across the same remap so tools attached under the
  // request id are not stranded on the pre-remap id (mirrors the projector +
  // DevTools-store rekeys).
  onProjectorRekey((oldId, newId) => sessionConnectorAttachmentStore.rekey(oldId, newId));
  return {
    recoverAcceptedPrivateSessions,
    docDeliveryRunner,
    docWorkReview,
    connectorAccess,
    connectorBroker,
    connectorHolds,
  };
}

/** What {@link wireDocDelivery} hands the steps after it. */
export type WireDocDeliveryResult = ReturnType<typeof wireDocDelivery>;
