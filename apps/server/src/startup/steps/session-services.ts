/**
 * Session-side services built before any runtime can start a turn: who started
 * a chat, chat messaging, commitments, the permission observer and gate, the
 * notification pipeline and escalation, and the session watchers.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/session-services
 */
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../services/session/origin/session-started-by-store.js';
import {
  setSessionTouchStore,
  SessionTouchStore,
} from '../../services/session/origin/session-touch-store.js';
import { setStartWorkService, StartWorkService } from '../../services/extensions/start-work.js';
import { projectRegistry } from '../../services/projects/project-registry.js';
import {
  setAgentSendService,
  AgentSendService,
} from '../../services/extensions/agent-send/agent-send.js';
import { AgentSendStore } from '../../services/extensions/agent-send/agent-send-store.js';
import { wireChatMessaging } from '../../services/session/chat-messages/chat-message-wiring.js';
import { ChatMessageStore } from '../../services/session/chat-messages/chat-message-store.js';
import { wireCommitments } from '../../services/commitments/commitment-wiring.js';
import {
  setOnEveryAgentEnded,
  createEveryAgentEndedRecorder,
} from '../../services/connectors/every-agent-activity.js';
import {
  ArrivalRecord,
  PersonSetPermissions,
  PermissionObserver,
  readAgentPermissionsFromManifest,
  permissionActions,
  narrowingReader,
  observedPermissionReader,
  narrowingContext,
} from '../../services/core/permissions/index.js';
import path from 'path';
import { logger, logError } from '../../lib/logger.js';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { composeCapabilityRegistryForDocs } from '../../services/core/self-description/dorkos-registry.js';
import { initPermissionGate } from '../../services/core/capabilities/index.js';
import { configManager } from '../../services/core/config-manager.js';
import { env } from '../../env.js';
import { NotificationStore } from '../../services/notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../services/notifications/notification-service.js';
import { PushSubscriptionStore } from '../../services/notifications/push-subscription-store.js';
import { WebPushChannel } from '../../services/notifications/channels/web-push.js';
import {
  setEscalationService,
  EscalationService,
} from '../../services/notifications/escalation-service.js';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { watchSessionLifecycle } from '../../services/notifications/emitters/session-lifecycle.js';
import {
  startLimitPlanning,
  installContinueService,
  installResumeService,
} from '../../services/session/index.js';
import { probeForReset } from '../../services/runtimes/claude-code/accounts/account-probe.js';
import { watchAskResolution } from '../../services/notifications/emitters/ask-resolution.js';
import { watchRuntimeSigninFailures } from '../../services/notifications/emitters/runtime-signin.js';
import { watchCreditsRefusals } from '../../services/notifications/emitters/credits-refused.js';
import { announceInstalledVersion } from '../../services/notifications/emitters/update-installed.js';
import { warnAboutGitProtection } from '../../lib/git-safety.js';
import { watchShiftReport } from '../../services/notifications/emitters/shift-report.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link wireSessionServices} reads from the startup steps before it. */
export interface WireSessionServicesInput {
  db: OpenConfigAndDatabaseResult['db'];
  activityService: WireCoreStoresResult['activityService'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
}

/**
 * Wire the session services, permission gate and notification pipeline.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function wireSessionServices(refs: ServerRefs, built: WireSessionServicesInput) {
  const { db, activityService, dorkHome } = built;
  // Who started a chat that no person typed into, and the seam that starts
  // one for an extension (`api.startWork`, `ctx.sessions.start`, spec
  // `flow-multiproject` §7.7). Before extensions start, so a `register()` that
  // starts work finds it; the name lookup reads the manager at call time.
  const sessionStartedByStore = new SessionStartedByStore(db);
  setSessionStartedByStore(sessionStartedByStore);
  // When you opened or wrote in each chat (spec `your-activity-first` D1),
  // written by the session routes for a person at the app and read by the
  // fourth origin overlay below.
  setSessionTouchStore(new SessionTouchStore(db));
  setStartWorkService(
    new StartWorkService({
      store: sessionStartedByStore,
      projects: projectRegistry,
      extensionName: (id) => refs.extensionManager?.get(id)?.manifest.name ?? id,
      activity: activityService,
    })
  );
  // The seam behind `ctx.agent.send` (DOR-2683): an extension sending one of
  // the person's agents a message. Built before extensions start, beside the
  // start-work seam it opens kept chats through; Mesh is read at call time,
  // since it starts later. Started once the runtimes are registered.
  setAgentSendService(
    new AgentSendService({
      store: new AgentSendStore(db),
      extensionName: (id) => refs.extensionManager?.get(id)?.manifest.name ?? id,
      meshCore: () => refs.meshCore,
      // Wired later in boot; read at call time, like Mesh.
      roomSessionPlace: () => refs.roomSessionPlacePort,
    })
  );
  // Chats messaging chats (spec `spin-off-chats`): `chat_send`, `chat_read`
  // and `chat_stop`, the sender stamp, and the ceiling a chat-sent queue row
  // launches under. Wired before any runtime turn can run, so a row adopted
  // after a restart already finds its ceiling.
  const chatMessaging = wireChatMessaging({
    db,
    store: new ChatMessageStore(db),
    meshCore: () => refs.meshCore,
    roomSessionPlace: () => refs.roomSessionPlacePort,
  });
  // What agents promised (spec `heartbeats` §12). The due timers are rebuilt
  // from the table here, so a restart loses no wake and no missed mark.
  const commitments = (refs.commitmentWiring = wireCommitments({
    db,
    meshCore: () => refs.meshCore,
  }));
  // Sharing with every agent that ends as a side effect (a disconnect, a move
  // to a DorkOS account) is recorded too, so every change to it leaves a
  // trace. Set here, before any provider registers, so boot-time changes count.
  setOnEveryAgentEnded(createEveryAgentEndedRecorder(activityService));
  // Records a change to an agent's permissions that was made by editing its
  // settings file rather than through DorkOS. The last-seen values live in
  // DorkOS's own data directory, never the agent's.
  // Agents that arrived and whose folder's settings have not been screened yet
  // (review D1). Built with the observer so both exist before any agent does.
  const arrivalRecord = new ArrivalRecord({
    file: path.join(dorkHome, 'permissions', 'pending-arrivals.json'),
    logger,
  });
  // What a person set for each agent, kept where no agent can write: the floor
  // its own settings file can tighten but never loosen (DOR-3107).
  const personSetPermissions = new PersonSetPermissions({
    file: path.join(dorkHome, 'permissions', 'person-set-agent-permissions.json'),
    logger,
  });
  const permissionObserver = new PermissionObserver({
    snapshotFile: path.join(dorkHome, 'permissions', 'observed-agent-permissions.json'),
    agentAt: (agentPath) => {
      const agent = refs.meshCore?.listWithPaths().find((a) => a.projectPath === agentPath);
      return agent ? { id: agent.id, name: agent.displayName || agent.name } : undefined;
    },
    // The whole static catalog, not the live registry: this is built before the
    // live registry is composed, and every action's area is fixed in code.
    read: readAgentPermissionsFromManifest,
    areaOfAction: (() => {
      let areas: Map<string, PermissionAreaId | null> | undefined;
      return (actionId: string) => {
        areas ??= new Map(
          permissionActions(composeCapabilityRegistryForDocs()).map((a) => [a.id, a.area])
        );
        return areas.get(actionId);
      };
    })(),
    activity: activityService,
    logger,
  });

  // The permission gate's sources, wired right after the observer and the
  // arrival record exist, before anything that can start a session, a
  // scheduled run or a room turn (relay connections, community subscriptions,
  // the task scheduler): all of them read an agent's own settings through this
  // reader, the one place an arriving agent's unscreened folder settings are
  // narrowed (review D1). Mesh and the registry are read lazily, when a read
  // happens; until the gate is wired its default reader reads no agent's own
  // settings at all.
  initPermissionGate({
    readConfig: () => configManager.get('permissions'),
    // Fresh off the manifest on every call, and compared with the last value
    // DorkOS saw, so an edit made outside DorkOS is recorded (not blocked).
    readAgentPermissions: narrowingReader(observedPermissionReader(permissionObserver), {
      arrivals: arrivalRecord,
      personSet: personSetPermissions,
      agentAt: (agentPath) =>
        refs.meshCore?.listWithPaths().find((a) => a.projectPath === agentPath)?.id,
      context: () => narrowingContext(configManager, refs.capabilityRegistry),
    }),
    // The tool-list builders hide an action whose permission is Blocked; they
    // read this catalog, per build, off the composed registry.
    listActions: () => permissionActions(refs.capabilityRegistry),
    // What `session_start` holds an inherited level to (DOR-3147): unknown
    // until the record is seeded, so a broken record can only make it stricter.
    personSetFilesAndCommands: (agentPath) => {
      if (!personSetPermissions.isSeeded()) return 'unknown';
      const agentId = refs.meshCore?.listWithPaths().find((a) => a.projectPath === agentPath)?.id;
      if (!agentId) return 'unknown';
      return personSetPermissions.get(agentId)?.filesAndCommands ?? null;
    },
  });
  // The environment variable wins when set; otherwise the setting (default 365).
  const retentionDays =
    env.DORKOS_ACTIVITY_RETENTION_DAYS ?? configManager.get('activity').retentionDays;
  try {
    const pruned = await activityService.prune(retentionDays);
    if (pruned > 0) {
      logger.info(`[Activity] Pruned ${pruned} events older than ${retentionDays} days`);
    }
  } catch (err) {
    logger.warn('[Activity] Startup prune failed', logError(err));
  }

  // The notification pipeline (spec `notification-system`), built EARLY and
  // deliberately: the dead-letter hook and the mesh liveness observer both
  // subscribe further down, and a notification raised between their
  // subscription and this line would be lost. The only thing it needs now is
  // the database; its out-of-app leg is read per send from `relayChannelDeps`,
  // which the relay wiring assigns once the adapters exist.
  //
  // Every seam that RAISES a notification calls the module-level `notify`
  // rather than holding this, so a projector, an MCP tool and a route do not
  // each grow a dependency on the inbox in order to say one sentence.
  const notificationStore = new NotificationStore(db);
  const notificationService = new NotificationService(notificationStore, {
    relay: () => refs.relayChannelDeps,
  });
  setNotificationService(notificationService);

  // The escalation ladder (spec `notification-system` task 4.3,
  // ADR 260819-234829): what happens when nobody answers. Built beside the
  // pipeline for the same boot-order reason — a session that errors during
  // startup arms a timer through the module-level `armEscalation`, which is a
  // no-op until this line runs.
  const pushSubscriptions = new PushSubscriptionStore(db);
  const webPushChannel = new WebPushChannel({ dorkHome, subscriptions: pushSubscriptions });
  setEscalationService(
    new EscalationService({
      store: notificationStore,
      push: webPushChannel,
      relay: () => refs.relayChannelDeps,
      // Read live, never cached: turning the knob to `never` has to silence a
      // timer that is already running, not only the next one.
      readDelay: () =>
        configManager.get('notifications')?.escalation?.phoneAfterMinutes ??
        NOTIFICATION_PREFS_DEFAULTS.escalation.phoneAfterMinutes,
    })
  );

  // A finished turn, and the history row an error leaves when it clears.
  watchSessionLifecycle();
  // What happens next when a session's account runs out: its plan and state,
  // the advisor's claims, and the recorder behind `accounts.markContinued`
  // (spec claude-account-fleet D9 and §X). After the usage store, which it
  // watches, and the Activity feed, which records each move.
  {
    const stopPlanning = startLimitPlanning();
    const uninstallContinue = installContinueService({
      activity: activityService,
      // Read when an automatic handoff fires, long after boot: the app and its
      // Mesh and room ports exist by then (the app is created further down).
      launchDeps: () => ({ meshCore: refs.meshCore, roomSessionPlace: refs.roomSessionPlacePort }),
    });
    // Waits for an account's reset, confirms it with a reading and resumes the
    // session by itself. After the planner, which settles pre-restart `auto`
    // plans before this re-arms the stored waits.
    const uninstallResume = installResumeService({
      launchDeps: () => ({ meshCore: refs.meshCore, roomSessionPlace: refs.roomSessionPlacePort }),
      // Task 2.2's idle probe, for an account the store cannot confirm on its
      // own. An account it cannot probe is still confirmed from store readings.
      probe: probeForReset,
    });
    refs.stopSessionContinuation = () => {
      uninstallResume();
      stopPlanning();
      uninstallContinue();
    };
  }
  // How every Ask ended — including the ones nobody answered.
  watchAskResolution();
  // A runtime whose sign-in stopped working, noticed at whichever turn trips
  // over it first — including the 3am ones nobody is watching (DOR-1654).
  watchRuntimeSigninFailures();
  // A turn DorkOS credits refused, told whoever started it, so a refused
  // scheduled task or room turn is never silent (ADR 261001-000811).
  watchCreditsRefusals();
  // Nothing tells the server it was updated, so it compares versions on boot.
  void announceInstalledVersion(dorkHome);
  // Git older than 2.38 cannot refuse a folder set up to look like a git
  // repository; say so once, in plain words (DOR-2326).
  void warnAboutGitProtection();
  // "While you were away" — composed once the day's first activity arrives.
  watchShiftReport(notificationStore, () => configManager.get('onboarding'));
  return {
    chatMessaging,
    commitments,
    arrivalRecord,
    personSetPermissions,
    permissionObserver,
    notificationService,
    pushSubscriptions,
    webPushChannel,
  };
}

/** What {@link wireSessionServices} hands the steps after it. */
export type WireSessionServicesResult = Awaited<ReturnType<typeof wireSessionServices>>;
