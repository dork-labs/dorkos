/**
 * Work that starts once the server is listening: canvas sweeps, recovery of
 * interrupted work, the health and snapshot timers, managed connector recovery,
 * remote access and DorkOS credits.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/after-listen
 */
import { sweepOrphanedCanvases } from '../../services/canvas/sweep-orphaned-canvases.js';
import { peekCanvasService } from '../../services/canvas/index.js';
import { aggregateSessionList } from '../../services/session/catalog/aggregate-session-list.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { env } from '../../env.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { logger, logError } from '../../lib/logger.js';
import { sharedBackgroundWorkLedger } from '../../services/runtimes/claude-code/messaging/background-work-ledger.js';
import { wakeChatsCutShort } from '../../services/session/runtime-turns/wake-cut-short-work.js';
import { sweepOrphanedMessageQueues } from '../../services/session/index.js';
import { INTERVALS } from '../../config/constants.js';
import { takeDailySnapshot } from '@dorkos/db';
import {
  sweepSessionAttachments,
  SESSION_ATTACHMENT_SWEEP_INTERVAL_MS,
} from '../../services/session/attachments/index.js';
import { scheduleJittered } from '../../lib/jittered-schedule.js';
import { getCloudLinkManager } from '../../services/core/auth/cloud-link.js';
import {
  autostartOwnTunnel,
  currentRemoteBootPlan,
} from '../../services/core/remote/remote-boot.js';
import { configManager } from '../../services/core/config-manager.js';
import { getLocalCockpitPort } from '../../lib/trusted-origins.js';
import { canExpose } from '../../services/core/auth/exposure-guard.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { ensureCreditsClaudeRoot } from '../../services/runtimes/claude-code/credits-root.js';
import {
  startCreditsLifecycle,
  revokeHeldCreditsToken,
} from '../../services/core/cloud/credits-inference.js';
import { managedRemoteCoordinator } from '../../services/core/remote/managed-remote-coordinator.js';
import {
  stopCodexCreditsTurns,
  fillCreditsGapsOnNewLink,
} from '../../services/core/cloud/credits-runtimes.js';
import { openCodeServerManager } from '../../services/runtimes/opencode/index.js';
import { readCloudAccountKey } from '../../services/core/cloud/v1-client.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { WireRoomsResult } from './rooms.js';
import type { WireDocDeliveryResult } from './doc-delivery.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { WireConnectorEventsAndApprovalsResult } from './connector-events-approvals.js';
import type { WireConnectorServicesResult } from './connector-services.js';
import type { ServerRefs } from '../server-refs.js';
import { currentServerRole } from '../../lib/server-role.js';
import { startHubAssignmentSync } from '../../services/core/hub/hub-assignment-runner.js';
import { hubSigningPublicKey, signWithHubKey } from '../../services/core/hub/hub-signing-key.js';
import { setHubRelaySigner, setHubRelayWaker } from '../../services/core/hub-relay/index.js';
import { hubRelayWake } from '../../services/core/hub/hub-relay-wake.js';

/** What {@link startAfterListen} reads from the startup steps before it. */
export interface StartAfterListenInput {
  backgroundWorkCutShort: ClaimDataDirectoryResult['backgroundWorkCutShort'];
  roomStore: WireRoomsResult['roomStore'];
  recoverAcceptedPrivateSessions: WireDocDeliveryResult['recoverAcceptedPrivateSessions'];
  db: OpenConfigAndDatabaseResult['db'];
  backupsDir: OpenConfigAndDatabaseResult['backupsDir'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  connectorEventInbox: WireConnectorEventsAndApprovalsResult['connectorEventInbox'];
  connectorEventSessionSource: WireConnectorServicesResult['connectorEventSessionSource'];
  connectorAuthenticationFlows: WireConnectorServicesResult['connectorAuthenticationFlows'];
  recoverConnectorEventDelivery: WireConnectorEventsAndApprovalsResult['recoverConnectorEventDelivery'];
  connectorEventGrants: WireConnectorServicesResult['connectorEventGrants'];
  connectorEventService: WireConnectorServicesResult['connectorEventService'];
  connectorEventPull: WireConnectorServicesResult['connectorEventPull'];
  managedConnectorAuthority: WireConnectorEventsAndApprovalsResult['managedConnectorAuthority'];
  connectorLifecycle: WireConnectorServicesResult['connectorLifecycle'];
  managedUsageMirrors: WireConnectorServicesResult['managedUsageMirrors'];
  PORT: number;
  docDeliveryRunner: WireDocDeliveryResult['docDeliveryRunner'];
}

/**
 * Start the work that waits for the server to be listening.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function startAfterListen(refs: ServerRefs, built: StartAfterListenInput) {
  const {
    backgroundWorkCutShort,
    roomStore,
    recoverAcceptedPrivateSessions,
    db,
    backupsDir,
    dorkHome,
    connectorEventInbox,
    connectorEventSessionSource,
    connectorAuthenticationFlows,
    recoverConnectorEventDelivery,
    connectorEventGrants,
    connectorEventService,
    connectorEventPull,
    managedConnectorAuthority,
    connectorLifecycle,
    managedUsageMirrors,
    PORT,
    docDeliveryRunner,
  } = built;

  // A hub reads who it belongs to and refuses everybody until it serves them
  // (DOR-2934). The server is listening, so Cloud's health check answers
  // while the first read is in flight.
  if (currentServerRole() === 'hub') {
    startHubAssignmentSync(dorkHome);
    // The relay signs each computer's handshake with the hub's own key, which
    // signs relay transcripts only and only while the hub serves. Linking a
    // computer also hands it the key's public half, to pin.
    setHubRelaySigner(signWithHubKey, hubSigningPublicKey);
    // A chat opened on a computer that is not connected asks Cloud to wake
    // it; a hub with no Cloud key wakes nobody.
    setHubRelayWaker(hubRelayWake());
  }
  /** The canvas sweep, listing the default folder only when a session is marked gone. */
  const sweepCanvases = (): Promise<number> =>
    sweepOrphanedCanvases(peekCanvasService(), async () => {
      const listing = await aggregateSessionList({
        runtimes: runtimeRegistry.listRuntimes(),
        projectDir: env.DORKOS_DEFAULT_CWD ?? DEFAULT_CWD,
      });
      return {
        sessions: listing.sessions.map((session) => ({ id: session.id, runtime: session.runtime })),
        degradedRuntimes: [...new Set(listing.warnings.map((w) => w.runtime))],
      };
    });

  // Start Tasks scheduler after server is listening
  if (refs.schedulerService) {
    await refs.schedulerService.start();
    logger.info('[Tasks] Scheduler started');
  }

  // Wake the chats the boot found owed a turn (DOR-2065), now that every
  // runtime and session service is up. A room's chat (`room_sessions`) and a
  // scheduled task's (`pulse_runs`) have no person waiting on the work, so they
  // are skipped. Detached, and it never rejects.
  if (backgroundWorkCutShort.length > 0) {
    const leftoverLedger = sharedBackgroundWorkLedger();
    logger.info('[DorkOS] waking chats whose background work a restart stopped', {
      sessions: backgroundWorkCutShort.map((record) => record.sessionId),
    });
    void wakeChatsCutShort(backgroundWorkCutShort, {
      release: (record) => leftoverLedger.release(record.key, record.since),
      drivenElsewhere: (sessionIds) =>
        new Set([
          ...roomStore.resolveRoomOrigins(sessionIds).keys(),
          ...(refs.taskStore?.resolveTaskOrigins(sessionIds).keys() ?? []),
        ]),
    });
  }

  // Run session health check periodically. Only ClaudeCodeRuntime needs the
  // eviction half, but the queue sweep is runtime-neutral and rides the same
  // cadence rather than adding a second timer, so it runs either way.
  refs.healthCheckInterval = setInterval(() => {
    refs.claudeRuntime?.checkSessionHealth();
    sweepOrphanedMessageQueues();
    void sweepCanvases();
    void refs.connectorAgentRequests?.reconcile().catch((error: unknown) => {
      logger.warn('[Connections] Agent request recovery failed', logError(error));
    });
    recoverAcceptedPrivateSessions();
  }, INTERVALS.HEALTH_CHECK_MS);

  // Keep the daily snapshot honest on a server that is never restarted. The
  // check is cheap and idempotent (one file per UTC day), so it runs on a plain
  // hourly tick rather than trying to compute when midnight is — which is the
  // sort of arithmetic that quietly stops working across a DST change.
  //
  // The tick that takes a snapshot copies the database a few pages at a time
  // with SQLite's online backup, handing the event loop back between steps. It
  // used to be one `VACUUM INTO`, which held the thread for the whole copy:
  // 0.35 s for a 131 MB database (DOR-2906). Never rejects.
  refs.dailySnapshotInterval = setInterval(() => {
    void takeDailySnapshot(db, backupsDir, logger);
  }, INTERVALS.DAILY_SNAPSHOT_CHECK_MS);

  // Somebody has to own the disk that session images sit on. Once at boot, so a
  // server that is restarted daily still collects, then daily for one that is
  // never restarted. Never awaited and never allowed to reject: a sweep is
  // housekeeping, and housekeeping does not get to delay a boot or take a
  // process down (`session-attachment-sweep.ts`).
  const sweepImages = () => {
    void sweepSessionAttachments({ dorkHome }).catch((err: unknown) => {
      logger.warn('[session-attachments] sweep failed', { err });
    });
  };
  sweepImages();
  refs.sessionAttachmentSweepInterval = setInterval(
    sweepImages,
    SESSION_ATTACHMENT_SWEEP_INTERVAL_MS
  );

  const recoverManagedAuthority = () => {
    // All-state payload expiry also runs without a cloud link or live vendor.
    const now = new Date().toISOString();
    connectorEventInbox.sweepRetention(now);
    connectorEventInbox.sweepMetadata(now);
    connectorEventSessionSource.sweepPreparations(now);
    connectorAuthenticationFlows.expireAbandoned();
    const pendingDelivery = recoverConnectorEventDelivery();
    // Settles when every part has, so the jittered beat never overlaps a run.
    return Promise.allSettled([
      pendingDelivery,
      connectorEventGrants.recoverPending(AbortSignal.timeout(25_000)).catch(() => {
        logger.warn('[Connectors] Notification setup deferred');
      }),
      connectorEventService.recoverCleanup(AbortSignal.timeout(25_000)).catch(() => {
        logger.warn('[Connectors] Notification cleanup deferred');
      }),
      connectorEventPull
        .recover(AbortSignal.timeout(25_000))
        .then(async () => {
          // The pull can commit new inbox rows while a prior delivery pass is in
          // flight. Wait for that pass, then start another so newly pulled rows do
          // not wait for the next maintenance tick.
          await pendingDelivery;
          await recoverConnectorEventDelivery();
        })
        .catch(() => {
          logger.warn('[Connectors] Notification handoff deferred');
        }),
      managedConnectorAuthority
        .recoverPending(new AbortController().signal)
        .catch((error: unknown) => {
          logger.warn('[Connectors] Managed authority recovery failed', logError(error));
        }),
      // Removing an own-key account's access at the service is DorkOS's job
      // after a disconnect; a sign-in again nobody finished gives its account back.
      connectorLifecycle.finishOwedCleanups(AbortSignal.timeout(25_000)).catch((error: unknown) => {
        logger.warn('[Connectors] Account cleanup at the service deferred', logError(error));
      }),
    ]);
  };
  void recoverManagedAuthority();
  refs.managedAuthorityRecoveryInterval = scheduleJittered(recoverManagedAuthority, 30_000);
  const recoverManagedUsageMirrors = async () => {
    if (!getCloudLinkManager().getSummary().linked) return;
    await managedUsageMirrors.recover(50, new AbortController().signal).catch((error: unknown) => {
      logger.warn('[Connectors] Managed receipt recovery failed', logError(error));
    });
  };
  void recoverManagedUsageMirrors();
  refs.managedUsageMirrorRecoveryInterval = scheduleJittered(recoverManagedUsageMirrors, 60_000);

  // Start the person's own tunnel if this process or the saved config says so,
  // behind the exposure guard — unless a saved DorkOS remote access choice
  // outranks the saved flag (DOR-1738, DOR-2086: the boot rule in `remote-boot.ts`).
  await autostartOwnTunnel({
    env,
    stored: configManager.get('tunnel'),
    fallbackPort: getLocalCockpitPort(),
    apiPort: PORT,
    plan: currentRemoteBootPlan(env),
    canExpose,
    tunnel: tunnelManager,
  });

  // Wire tunnel status changes to unified SSE stream
  tunnelManager.on('status_change', (status) => {
    eventFanOut.broadcast('tunnel_status', status);
  });

  // Dispatch retained document work only after every runtime and capability is ready.
  docDeliveryRunner.start();

  // Cloud link (accounts-and-auth P2): if this instance is device-linked to a
  // DorkOS account, heartbeat now and every 15 minutes. Non-blocking and
  // best-effort — independent of local login (config.auth.enabled). A 401 marks
  // the instance unlinked and clears the local token (never retry-loops).
  getCloudLinkManager()
    .initOnStartup()
    .catch((err) => {
      logger.warn('[CloudLink] Startup heartbeat failed', logError(err));
    });

  // DorkOS credits (ADR 261001-000811): keep a live inference token while this
  // computer is linked, minted now and again before each one expires, so a
  // restart never quietly drops a session set to credits. The credits folder
  // exists from boot so a credits session's transcript is always listed. A new
  // link (and only a new link) fills the gaps: a runtime with no sign-in at all
  // defaults to credits, and the person is told. A link to a different DorkOS
  // account starts the choices over; a relink to the same one keeps them. An
  // unlink revokes the held token and stops every credits session's process.
  ensureCreditsClaudeRoot();
  startCreditsLifecycle();
  getCloudLinkManager().setOnUnlink(async () => {
    // First, while the link still stands: managed remote access withdraws
    // locally at once and sends its Cloud calls under the old key (DOR-2086).
    void managedRemoteCoordinator.withdrawOnUnlink();
    await revokeHeldCreditsToken();
    await refs.claudeRuntime?.stopCreditsSessions();
    stopCodexCreditsTurns();
    refs.doeRuntime?.stopCreditsTurns();
    refs.creditsRelay?.abortAll();
    await openCodeServerManager.recycleIfOnCredits();
  });
  // OpenCode's credits are a mode of its one sidecar: a change of its Runs on
  // choice recycles a sidecar left on the other side at once.
  configManager.onChange((change) => {
    if (!change.paths.some((path) => path === 'cloud' || path.startsWith('cloud.credits'))) return;
    void openCodeServerManager.syncToChoice().catch((err) => {
      logger.warn('[OpenCode] could not follow the Runs on choice', logError(err));
    });
  });
  getCloudLinkManager().setOnNewLink(async () => {
    // A new link's token belongs to the account just linked.
    await openCodeServerManager.recycleIfOnCredits();
    const switched = await fillCreditsGapsOnNewLink(await readCloudAccountKey());
    if (switched.length > 0) {
      logger.info('[Cloud] New link: these runtimes now run on DorkOS credits by default', {
        runtimes: switched,
      });
    }
  });
}
