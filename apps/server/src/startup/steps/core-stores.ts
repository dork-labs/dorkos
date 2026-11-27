/**
 * The durable stores and identity services everything later depends on:
 * connector identity, the session event and message stores, auth, agent
 * identity, the Activity feed, the audit log and agent pauses.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/core-stores
 */
import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { loadLocalSpaceId } from '../../lib/identity/space-id.js';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import { ConnectorCatalogCache } from '../../services/connectors/resources/catalog-cache.js';
import path from 'path';
import { ConnectorAuthorityCleanupService } from '../../services/connectors/authority-cleanup-service.js';
import { randomUUID } from 'node:crypto';
import { SessionConnectorAttachmentStore } from '../../services/connectors/attachment-store.js';
import { takeDailySnapshot } from '@dorkos/db';
import { logError, logger } from '../../lib/logger.js';
import { watchSessionStreamHealth } from '../../services/core/streams/session-stream-watch.js';
import {
  SessionEventStore,
  wireSessionEventStore,
  expireOrphanedAsks,
  MessageQueueStore,
  setMessageQueueStore,
  setStagedContextStore,
  StagedContextStore,
  SessionLimitStore,
  setSessionLimitStore,
} from '../../services/session/index.js';
import { installTurnContextStore } from '../../services/session/turn-context/index.js';
import { installWorkLinkStore } from '../../services/work-graph/index.js';
import { installRunRecord } from '../../services/runs/index.js';
import { knownChatCwd } from '../../services/core/runtime-seam/live-runtime-cwd.js';
import { resolveAgentIdForPath } from '../../services/mesh/agent-path-lookup.js';
import { ulid } from 'ulidx';
import { projectRegistry } from '../../services/projects/project-registry.js';
import { KnownProjectsStore } from '../../services/projects/known-projects-store.js';
import { accountRuleRoots } from '../../services/core/usage/account-eligibility.js';
import { configManager } from '../../services/core/config-manager.js';
import {
  setExtensionInbox,
  ExtensionInboxService,
  getExtensionInbox,
} from '../../services/extensions/inbox/extension-inbox.js';
import { getStartWorkService } from '../../services/extensions/start-work.js';
import {
  PersonRecordStore,
  setPersonRecordStore,
} from '../../services/extensions/person-record/person-record.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { chatFolderById } from '../../services/core/agent-identity/session-agent.js';
import { setContinuationHoldDb } from '../../services/core/turn-power/continuation-hold.js';
import { setOutsideWordsDb } from '../../services/core/turn-power/outside-words.js';
import {
  createChatRiseFacts,
  setChatRiseFacts,
} from '../../services/core/turn-power/chat-rise-facts.js';
import { installSessionStatusHydration } from '../../services/session/fleet/session-status-hydration.js';
import { SessionContextStore } from '../../services/session/fleet/session-context-store.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { onSessionAccountLaunched } from '../../services/runtimes/claude-code/accounts/account-usage-feed.js';
import {
  initAuth,
  seedLegacyMcpApiKey,
  resolveMcpLocalToken,
  readOwnerAccount,
} from '../../services/core/auth/index.js';
import { getMcpLocalToken } from '../../services/core/auth/mcp-local-token.js';
import { setRemoteCommunityDb } from '../../services/communities/remote/state.js';
import { exposeDesktopSignInMint } from '../../services/core/auth/desktop-sign-in.js';
import { readGatePosture } from '../../services/core/auth/gate-policy.js';
import { startLiveConnectionSweep } from '../../services/core/auth/sessions/live-connections.js';
import { watchRemoteAccessSwitch } from '../../middleware/remote-access-switch.js';
import {
  endSetupSignIns,
  liveSessionIds,
} from '../../services/core/auth/sessions/signed-in-devices.js';
import { env } from '../../env.js';
import { initAgentIdentityService } from '../../services/core/agent-identity/index.js';
import {
  wireClaimLinks,
  wireProcessTokenPort,
  wireTodoLinks,
  wireWorktreeLinks,
} from './work-graph.js';
import { ActivityService } from '../../services/activity/activity-service.js';
import { wireAuditTrail } from '../../services/audit/index.js';
import { wireAgentPause } from '../../services/mesh/pause/index.js';
import { agentPause } from '../../services/mesh/pause/agent-pause.js';
import { isAgentLaunchCapFull } from '../../services/session/launch/launch-cap.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { ServerRefs } from '../server-refs.js';
import { wireScheduledChatMoves } from '../space-views.js';

/** What {@link wireCoreStores} reads from the startup steps before it. */
export interface WireCoreStoresInput {
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  db: OpenConfigAndDatabaseResult['db'];
  firstBoot: OpenConfigAndDatabaseResult['firstBoot'];
  backupsDir: OpenConfigAndDatabaseResult['backupsDir'];
}

/**
 * Wire the durable stores and identity services over the migrated database.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function wireCoreStores(refs: ServerRefs, built: WireCoreStoresInput) {
  const { dorkHome, db, firstBoot, backupsDir } = built;
  // Construct canonical connector identity and attachment services before Mesh
  // can reconcile any agent away. The unregister callback is installed as soon
  // as MeshCore exists below, before its first startup pass. Provider bootstrap
  // and connector routes remain later in startup, after their other dependencies.
  const connectorInstallationId = await getOrCreateInstanceId(dorkHome);
  // Beside the install id, the local space's id: read, or minted on the first
  // boot, then held for every turn's signature references (ADR 261122-124821).
  await loadLocalSpaceId(dorkHome);
  const connectorOwner = {
    kind: 'local_install',
    installationId: connectorInstallationId,
  } as const;
  const connectorRegistry = new ConnectorRegistry({
    db,
    configuredOwner: { ownerKind: 'local_install', ownerId: connectorInstallationId },
    catalogCache: new ConnectorCatalogCache({
      dir: path.join(dorkHome, 'cache', 'connectors', 'catalog'),
    }),
  });
  const connectorAuthorityCleanup = new ConnectorAuthorityCleanupService({ db });
  const connectorBootEpoch = randomUUID();
  const sessionConnectorAttachmentStore = new SessionConnectorAttachmentStore(db);

  // The daily safety net, under everything a migration cannot see coming. Once
  // per UTC day, here and again on the timer started after listen() so a server
  // left running for a week still takes one. A failure here is logged and
  // survived: unlike the pre-migration snapshot, nothing irreversible follows it.
  //
  // Skipped on a first boot so a brand-new install is not handed a `backups`
  // folder holding a copy of an empty database. The hourly tick picks the day up
  // later, by which time there may be something in it worth copying.
  if (!firstBoot) void takeDailySnapshot(db, backupsDir, logger);

  // Durable session-event store for LOG-BACKED runtimes (codex/opencode/
  // test-mode), injected once here so their completed-turn history survives a
  // server restart (DOR-189). Wired before any runtime registers so the first
  // turn/subscribe of a log-backed session persists and hydrates. With the store
  // holding their history, their idle in-memory copies are swept (DOR-2897).
  const sessionEventStore = new SessionEventStore(db);
  wireSessionEventStore(sessionEventStore);
  // Warn when a turn starts that no open window will see — the trail a chat
  // that "only showed the reply after a refresh" leaves in the log.
  watchSessionStreamHealth();

  // An agent that was waiting on a person when the last process stopped is not
  // waiting any more — its turn died with that process, and nothing can hand it
  // an answer now (DOR-1439). Recorded as unanswered here, before anything can
  // raise a new ask, so the conversation says so when it is reopened instead of
  // showing a tool nobody was apparently ever asked about.
  expireOrphanedAsks(sessionEventStore);

  // The durable message queue, wired on the same beat and for the same reason:
  // a message somebody typed and was told was accepted must outlive the request
  // that accepted it, a second window, a failed turn and a restart.
  const messageQueueStore = new MessageQueueStore(db);
  setMessageQueueStore(messageQueueStore);

  // The run record, and this boot's epoch: the owner of every run this process
  // starts (spec `turns-survive-restarts` §6.1). Before anything can launch a turn.
  // Its outbox names a chat by the folder it runs in, when the emitter's own
  // naming did not travel with the notice.
  installRunRecord(db, {
    epoch: ulid(),
    // The turn port's door (spec §3.1, §3.5): Mesh and the pause service are
    // read at call time, since both start later in boot.
    agentHome: () => {
      const mesh = refs.meshCore;
      return mesh ? (agentId) => mesh.getProjectPath(agentId) : undefined;
    },
    admission: {
      admission: {
        pausedAgent: (agentId, cwd, sessionId) =>
          agentPause()?.pausedAgentOfStart(agentId, cwd, sessionId, () =>
            knownChatCwd(db, sessionId)
          ),
        machineFull: isAgentLaunchCapFull,
      },
    },
    onResumed: (listener) => agentPause()?.onResumed(listener) ?? (() => {}),
    handlers: {
      placeOf: (sessionId) => {
        const cwd = knownChatCwd(db, sessionId);
        const agentId = resolveAgentIdForPath(cwd);
        return { ...(cwd ? { cwd } : {}), ...(agentId ? { agentId } : {}) };
      },
    },
  });

  // The durable hold for staged words, on the same beat again: the server tells
  // the person "Added context for the next reply" on a stream that survives a
  // restart, so what that receipt points at has to survive one too (DOR-1324).
  setStagedContextStore(new StagedContextStore(db));

  // What each turn actually handed its runtime, recorded per turn and private
  // to the person (spec "Agent context viewer", phase 1). Before any runtime
  // registers, so the first turn is recorded; text past 30 days is swept here
  // and on the hourly tick.
  // The local `/mcp` token is the space side's; the record is handed it to sweep.
  installTurnContextStore(db, () => {
    const token = getMcpLocalToken();
    return token !== null ? [token] : [];
  });

  // The work graph's edges (DOR-4968), on the same beat: a first turn's re-key
  // is recorded as it happens, so the first turn must find the store in place.
  // A worktree made for a chat (DOR-5265), a to-do an agent makes in a chat
  // (DOR-5266) and a claim and its end (DOR-4972) are recorded the same way.
  installWorkLinkStore(db);
  wireWorktreeLinks();
  wireTodoLinks();
  wireClaimLinks();

  // The project registry's saved names (spec `flow-multiproject` §6.1). Loaded
  // here, before extensions start, because a name handed out earlier could
  // belong to a saved project and would change on the next read.
  projectRegistry.attachStore(new KnownProjectsStore(db));
  // A root an account rule names is never forgotten by the lookup cap.
  projectRegistry.protectRoots(() => accountRuleRoots(configManager.get('runtimes')?.claudeCode));

  // The inbox extensions ask a person through (`ctx.inbox`, spec
  // `flow-multiproject` §7). Before extensions start, so an extension that
  // raises from its `register()` finds it, and so starting one can show its
  // open decisions again and fire a deadline that passed while it was down.
  //
  // A `watch` on a decision may point only at a chat this extension started,
  // or one started from its chats (§7.3), which the start-work seam wired
  // below answers.
  setExtensionInbox(
    new ExtensionInboxService({
      db,
      projects: projectRegistry,
      dorkHome,
      watchAllowed: (extensionId, sessionId) =>
        getStartWorkService()?.startedBy(extensionId, sessionId) ?? false,
    })
  );
  getExtensionInbox()?.prune();
  // What extensions recorded during a signed-in person's request (DOR-4301).
  setPersonRecordStore(new PersonRecordStore(db));

  // A session's usage limit, kept so a restart or an idle eviction does not
  // turn a limited session back into a merely failed one (spec
  // claude-account-fleet D4).
  const sessionLimitStore = new SessionLimitStore(db);
  setSessionLimitStore(sessionLimitStore);
  // How past limits ended is kept for 30 days (spec claude-account-ui §7.1).
  try {
    sessionLimitStore.sweepHistory();
  } catch (err) {
    logger.warn('[session-limits] could not sweep the limit history', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Inject the DB handle into the runtime registry so session-scoped resolution
  // (resolveForSession / persistSessionRuntime / getSessionRuntimeType) can read
  // and write the `session_metadata` table. Must happen before any route or
  // service uses these methods. See ADR 0255.
  runtimeRegistry.setDb(db);
  // A scheduled chat's task run and beat rows move with its rekey (DOR-3703, §5.12).
  wireScheduledChatMoves();
  // Whether each chat's latest turn was held, for the turns that pick it up on their own (DOR-3037).
  setContinuationHoldDb(db);
  // Whether each chat's latest turn read outside words, so a restart cannot clear it (DOR-4148).
  setOutsideWordsDb(db);
  // Whether each chat may follow its agent's level up at a turn's start (DOR-3175).
  setChatRiseFacts(createChatRiseFacts(db));

  // Usage and context shown the moment a session opens, before any turn (spec
  // `claude-account-fleet` §6 U): every new projector is stamped from the usage
  // store and `session_context`, live ones follow the store in memory (never
  // through a session's event log), and a launch re-stamps the account it
  // settled on.
  const sessionStatusHydration = installSessionStatusHydration({
    usageStore: () => refs.accountUsageStore,
    contextStore: new SessionContextStore(db),
    resolveRuntime: async (sessionId) => {
      try {
        return await runtimeRegistry.resolveForSession(sessionId);
      } catch {
        return undefined;
      }
    },
    // A chat that recorded no agent runs in its own folder, not the default (DOR-5038).
    resolveCwd: async (sessionId) => {
      let folder: string | undefined;
      try {
        folder = chatFolderById(sessionId);
      } catch {
        folder = undefined; // An unreadable folder falls back like a missing one.
      }
      return (
        (await runtimeRegistry.getSessionAgentPath(sessionId).catch(() => null)) ??
        folder ??
        DEFAULT_CWD
      );
    },
  });
  onSessionAccountLaunched((sessionId, root, perToken) =>
    sessionStatusHydration.noteAccountLaunched(sessionId, root, perToken)
  );

  // Initialize the Better Auth identity core over the consolidated DB. Mounted
  // by createHonoApi() at /api/auth/* regardless of `config.auth.enabled` (the gate
  // is a later task) so the enable-login flow can create the owner account
  // before the flag flips. See services/core/auth/.
  // dorkHome is threaded through so the session-signing secret resolves from
  // (and, on first boot, persists into) a 0600 file there — a fresh install
  // signs in with zero manual `BETTER_AUTH_SECRET` setup (DOR-242).
  const auth = initAuth(db, dorkHome);
  // A sign-in ended outside this process (`dorkos auth reset-password` writes
  // the database directly) still closes what it had open, within a sweep.
  startLiveConnectionSweep((ids) => liveSessionIds(auth, ids));
  // Turning Remote Access off closes every stream another device holds (DOR-3650).
  watchRemoteAccessSwitch();
  // The sign-in `dorkos auth enable` made while signing up is held by no
  // device; end it rather than list it (DOR-3097).
  const ownerAtStart = readOwnerAccount();
  if (ownerAtStart) {
    void endSetupSignIns(auth, ownerAtStart.id).catch((error: unknown) =>
      logger.warn('[auth] could not end the sign-in made during setup', logError(error))
    );
  }
  // The desktop window signs in by itself (F3): its shell mints a code here
  // over the process channel (`services/core/auth/desktop-sign-in.ts`).
  exposeDesktopSignInMint({
    ownerId: () => readOwnerAccount()?.id ?? null,
    asksOnThisComputer: () => readGatePosture().askOnThisComputer,
  });
  setRemoteCommunityDb(db);

  // One-time migration: fold a pre-auth global `mcp.apiKey` into an owner-owned
  // Better Auth API key so existing MCP clients keep working after the rewrite to
  // per-user keys (task 1.4). No-op when there is no legacy key or no owner yet
  // (the owner-creation hook in createAuth handles the enable-login-mid-upgrade
  // case). Idempotent and non-throwing.
  void seedLegacyMcpApiKey(db);

  // Resolve the per-instance local MCP token once (DOR-278) — but only in
  // login-off mode with no MCP_API_KEY override. In that mode this generates and
  // persists the 0600 <dorkHome>/mcp-local-token file on first boot and populates
  // the getMcpLocalToken() cache the /mcp + /a2a auth middleware compares against.
  // When MCP_API_KEY is set (the env override is the bearer) or login is on
  // (per-user keys, ADR-0320), leave the cache null so the middleware's
  // local-token acceptor stays inert. resolveMcpLocalToken logs only the file
  // path, never the token value.
  // (Trim-for-presence: a whitespace-only MCP_API_KEY counts as unset.)
  if (configManager.get('auth')?.enabled !== true && !env.MCP_API_KEY?.trim()) {
    resolveMcpLocalToken(dorkHome);
  }

  // Agent identity (spec `agent-trust` §3.1) — must be initialized before the
  // first request, whose agent-identity step in the chain reaches this
  // singleton lazily (it has no database handle in scope, same as `getAuth`).
  initAgentIdentityService(db);
  // The runtimes report the processes that hold its tokens through a port (DOR-5264).
  wireProcessTokenPort();

  // Initialize Activity Service and prune stale events
  const activityService = new ActivityService(db);

  // The audit log (spec `audit-trail`): one append-only, hash-chained record of
  // every action. Every Activity event is copied in, so the log is the
  // superset; actors are keyed on stable ids, the owner on this install's id
  // until an account exists. The startup check walks the recent end of the
  // chain and only warns: a broken chain is evidence to keep, not a reason to
  // refuse to start.
  const { log: auditLog, accounts: auditAccounts } = wireAuditTrail({
    db,
    activity: activityService,
    installId: connectorInstallationId,
    readOwnerAccount,
  });

  // Pausing an agent everywhere (spec `audit-trail` PR5). Read before any
  // runtime registers, so the hold at the runtime seam sees a pause that
  // outlived a restart from the first turn on.
  const agentPauses = wireAgentPause(db, () => refs.schedulerService);
  return {
    connectorInstallationId,
    connectorOwner,
    connectorRegistry,
    connectorAuthorityCleanup,
    connectorBootEpoch,
    sessionConnectorAttachmentStore,
    messageQueueStore,
    activityService,
    auditLog,
    auditAccounts,
    agentPauses,
  };
}

/** What {@link wireCoreStores} hands the steps after it. */
export type WireCoreStoresResult = Awaited<ReturnType<typeof wireCoreStores>>;
