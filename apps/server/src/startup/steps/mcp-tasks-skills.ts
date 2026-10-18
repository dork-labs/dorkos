import { localBrowserHost } from '../local-browser.js';
/**
 * Managed MCP servers, the external MCP server, the route dependency bag,
 * Tasks, and the skills projection watcher.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/mcp-tasks-skills
 */
import { createPluginReloadActivityWriter } from '../../services/activity/plugin-reload-activity.js';
import { AgentMcpOAuthService } from '../../services/mesh/agent-mcp-oauth-service.js';
import { localDialHost } from '../../lib/local-dial-host.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { resumeAfterMcpSignin } from '../../services/mesh/mcp-signin-resume.js';
import { AgentMcpServerService } from '../../services/mesh/agent-mcp-server-service.js';
import { createMcpRevocationWatch } from '../../services/mesh/mcp-revocation.js';
import { warmMcpOAuthTokens } from '../../services/mesh/warm-mcp-oauth-tokens.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { visibleRoomsForCaller } from '../../services/rooms/visible-rooms-for-caller.js';
import {
  mergeSessionMcpServers,
  toSdkMcpServers,
} from '../../services/runtimes/claude-code/mcp-server-config.js';
import { homeOf, resolveAgentHome } from '../../services/core/agent-identity/index.js';
import { createDorkOsToolServer } from '../../services/runtimes/claude-code/mcp-tools/index.js';
import { configManager } from '../../services/core/config-manager.js';
import { mcpCallerIdentity, type McpServerFactory } from '../../routes/mcp.js';
import { resolveToolVisibilityFor } from '../../services/runtimes/shared/permission-tool-filter.js';
import { createExternalMcpServer } from '../../services/core/mcp-server.js';
import type { HonoApiDeps } from '../../http/hono-api.js';
import { startTasks } from '../tasks.js';
import {
  startSkillsWatcher,
  startTurnEndReprojection,
} from '../../services/harness/skills-watcher.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { onProjectorTurnBoundary } from '../../services/session/session-state-projector.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { WireConnectorEventsAndApprovalsResult } from './connector-events-approvals.js';
import type { WireRoomsResult } from './rooms.js';
import type { WireTeamRoomAndRelayAdaptersResult } from './team-room-relay-adapters.js';
import type { StartSearchRelayAndMeshResult } from './search-relay-mesh.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link wireMcpTasksAndSkills} reads from the startup steps before it. */
export interface WireMcpTasksAndSkillsInput {
  activityService: WireCoreStoresResult['activityService'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  PORT: number;
  approvalService: WireConnectorEventsAndApprovalsResult['approvalService'];
  roomBridges: WireRoomsResult['roomBridges'];
  notifyDm: WireTeamRoomAndRelayAdaptersResult['notifyDm'];
  roomService: WireRoomsResult['roomService'];
  connectorSignedIngress: WireConnectorEventsAndApprovalsResult['connectorSignedIngress'];
  docChannelHttp: WireConnectorEventsAndApprovalsResult['docChannelHttp'];
  docChannelMetrics: WireConnectorEventsAndApprovalsResult['docChannelMetrics'];
  tasksEnabled: StartSearchRelayAndMeshResult['tasksEnabled'];
  schedulerConfig: StartSearchRelayAndMeshResult['schedulerConfig'];
  firing: StartSearchRelayAndMeshResult['firing'];
  agentPauses: WireCoreStoresResult['agentPauses'];
  mountedRouters: string[];
}

/**
 * Wire the MCP servers, create the route dependencies, and start Tasks and the skills watcher.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function wireMcpTasksAndSkills(refs: ServerRefs, built: WireMcpTasksAndSkillsInput) {
  const {
    activityService,
    dorkHome,
    PORT,
    approvalService,
    roomBridges,
    notifyDm,
    roomService,
    connectorSignedIngress,
    docChannelHttp,
    docChannelMetrics,
    tasksEnabled,
    schedulerConfig,
    firing,
    agentPauses,
    mountedRouters,
  } = built;
  // A plugin reload that threw a conversation's prompt cache away leaves a line
  // in the feed — with what it cost and whether it waited first. Free reloads
  // stay silent (spec `plugin-reload-cache-cost`). Outside the mesh block below
  // on purpose: plugins reload on a host with no mesh too.
  if (refs.claudeRuntime) {
    refs.claudeRuntime.setPluginReloadActivity(createPluginReloadActivityWriter(activityService));
  }
  // Managed per-agent MCP servers (spec `mcp-server-management`). Constructed
  // once meshCore exists — the service resolves an agent id to its workspace
  // path through the mesh registry (the single instance, shared, ADR-0043) and
  // owns every read/write of `AgentManifest.mcpServers`. Wired into both the
  // claude-code injection factory below and the `mcp.*` capability domain.
  if (refs.meshCore) {
    // Managed-MCP OAuth engine (DOR-942): owns the OAuth lifecycle for an agent's
    // OAuth-protected servers and holds the synchronous access-token cache the
    // injection path reads. The loopback callback lands on this host, so its
    // `redirect_uri` is the bound loopback host at the listen port — see the
    // `callbackBaseUrl` note just below for why that is not a literal 127.0.0.1.
    refs.agentMcpOAuthService = new AgentMcpOAuthService({
      dorkHome,
      // The loopback callback is opened by the operator's own browser (the OAuth
      // provider 302s to it), so its host must be one the browser can actually
      // dial — the bind host, not a hardcoded `127.0.0.1`. When `DORKOS_HOST` is
      // `localhost` and resolves to `::1` (macOS), a `127.0.0.1` callback is
      // refused. `localDialHost` is the same binding-vs-dialing fix the connector
      // `localOrigin` above already applies (the connections browser spec proved
      // it matters); the callback route still enforces loopback-only.
      callbackBaseUrl: `http://${localDialHost(env.DORKOS_HOST)}:${PORT}`,
      logger,
      // Dial the server with the token a sign-in just produced (DOR-1003). It
      // answers both "how many tools did the operator just unlock?" and "does the
      // token DorkOS holds actually work?" — the second is what stops a stale
      // stored grant reporting "already connected". Resolved through the closure
      // rather than passed by value because the service that probes is
      // constructed on the next statement, with THIS engine as its token
      // provider; before then there is nothing to ask, and no opinion is the
      // right answer.
      probe: async (target) => {
        if (!refs.agentMcpServerService) return { ok: false };
        return refs.agentMcpServerService.test(target.agentId, target.serverName);
      },
      // Bring the agent back the moment a sign-in it asked for lands (DOR-1004).
      // Only flows that BEGAN inside a session carry one to resume, so a sign-in
      // started from the settings panel or the external `/mcp` server triggers
      // nothing. Detached deliberately: the caller is the loopback callback the
      // operator's browser is waiting on, and their "you can close this tab" page
      // must not wait on a model — or turn into an error because a turn could not
      // start. `resumeAfterMcpSignin` never rejects; the `.catch` is belt to that
      // brace so a future throw cannot become an unhandled rejection.
      onSigninConnected: (event) => {
        void resumeAfterMcpSignin(event).catch(() => {});
      },
    });
    refs.agentMcpServerService = new AgentMcpServerService({
      agents: refs.meshCore.agentRegistry,
      logger,
      // The injection path merges `Authorization: Bearer <token>` into http/sse
      // entries iff this returns a live token — withholds otherwise (needs-auth).
      tokenProvider: refs.agentMcpOAuthService,
    });
    // A managed server that refuses the token DorkOS injected flips its row back
    // to needs-auth and draws the sign-in card in the conversation the person hit
    // it in (DOR-981). Wired only for claude-code, because its per-turn MCP status
    // snapshot is the only place a runtime tells DorkOS a server did not come up;
    // the other runtimes report no such thing yet, so nothing is claimed for them.
    if (refs.claudeRuntime) {
      const oauthForRevocation = refs.agentMcpOAuthService;
      const serversForRevocation = refs.agentMcpServerService;
      refs.claudeRuntime.setMcpAuthEvidence(
        createMcpRevocationWatch({
          oauth: oauthForRevocation,
          servers: serversForRevocation,
          // The SAME probe the sign-in engine and the settings panel's Test button
          // use: it dials the server through the connection a turn would use,
          // bearer included. It is the arbiter here — the runtime's report only
          // decides whether to run it (DOR-981).
          probe: (target) => serversForRevocation.test(target.agentId, target.serverName),
          logger,
        })
      );
    }
    // Deleting an agent takes its MCP sign-ins with it (DOR-986): stored tokens,
    // dynamic client registrations, cached bearers and their refresh timers. The
    // manifest is already gone when this fires, so the sweep is by agent id.
    const oauthForAgentDeletion = refs.agentMcpOAuthService;
    refs.meshCore.onUnregister((agentId) => {
      oauthForAgentDeletion.forgetAgent(agentId).catch((err: unknown) => {
        logger.warn('[mcp-oauth] could not clear sign-ins for an unregistered agent', {
          agentId,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    });
    // Re-prime the cache from disk for every enabled OAuth server so a token
    // survives a restart. Non-blocking: injection withholds until warm completes.
    warmMcpOAuthTokens(refs.agentMcpOAuthService, refs.agentMcpServerService, refs.meshCore).catch(
      (err: unknown) => {
        logger.warn('[mcp-oauth] token warm failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    );
    // Inject the resolver into every runtime that folds managed servers in via
    // the DI setter (codex, DOR-892; opencode later, DOR-893). Claude-code uses
    // its own `setMcpServerFactory` seam below and does not implement this, so
    // the optional call is a no-op there — no double injection.
    for (const runtime of runtimeRegistry.listRuntimes()) {
      runtime.setManagedMcpServers?.(refs.agentMcpServerService);
    }
  }
  if (refs.claudeRuntime) {
    refs.mcpToolDeps = {
      transcriptReader: refs.claudeRuntime.getTranscriptReader(),
      defaultCwd: env.DORKOS_DEFAULT_CWD ?? process.cwd(),
      // Where `tasks_create` writes a global schedule's SKILL.md. Not optional:
      // a create that cannot find the skills root writes a row with no file
      // behind it, which is the orphan DOR-1568 closed.
      dorkHome,
      runtimeRegistry,
      activityService,
      // The approval primitive the in-session hold (DOR-939) waits on, so a fresh
      // destructive capability call holds inline and resumes on the operator's yes.
      approvals: approvalService,
      ...(refs.taskStore && { taskStore: refs.taskStore }),
      // A getter, not the registrar: these deps are assembled ~120 lines before
      // `TaskRegistrar` is constructed, so the value read here would be
      // `undefined` for the life of the process — which is exactly why the task
      // MCP tools used to write rows the scheduler never heard about
      // (DOR-1493). Read at call time, by which point it exists.
      resolveTaskRegistrar: () => refs.taskRegistrar ?? null,
      ...(refs.relayCore && { relayCore: refs.relayCore }),
      ...(refs.adapterManager && { adapterManager: refs.adapterManager }),
      ...(refs.adapterManager && { bindingStore: refs.adapterManager.getBindingStore() }),
      ...(refs.adapterManager && { bindingRouter: refs.adapterManager.getBindingRouter() }),
      bridgeStore: roomBridges,
      ...(refs.traceStore && { traceStore: refs.traceStore }),
      ...(refs.meshCore && { meshCore: refs.meshCore }),
      // `create_extension`, `reload_extensions`, `test_extension` and the rest:
      // without it an agent gets only `get_extension_api` in a chat, and every
      // extension tool on `/mcp` answers that the system is not available, so
      // no agent can build a mini app.
      ...(refs.extensionManager && { extensionManager: refs.extensionManager }),
      // The DorkOS-DM fallback, hoisted above so the notification pipeline's
      // relay channel shares this one seam rather than building a second.
      ...(notifyDm && { notifyDm }),
      // What the two sidebar-section capabilities check a room reference against
      // before they store one (DOR-2055). Scoped to the CALLER, resolved per
      // call, and failing closed — all three decisions live in the named unit,
      // with `rooms/__tests__/visible-rooms-for-caller.test.ts` driving it
      // against a real `RoomService`. It is a unit rather than a closure here
      // precisely so something executes it: as three lines of wiring, reverting
      // the caller resolution to the owner's left 712 tests green.
      listVisibleRooms: (caller) => visibleRoomsForCaller(roomService, caller),
    };
    refs.claudeRuntime.setMcpServerFactory((session, sessionId, launch) =>
      // Managed servers first and `dorkos` last so it can never be shadowed —
      // the ordering guarantee lives in `mergeSessionMcpServers`
      // (spec `mcp-server-management` §6).
      mergeSessionMcpServers({
        // The agent's ENABLED managed servers, injected inline so no `.mcp.json`
        // is written. Keyed on the agent the session acts as — its own folder
        // even when it stands in a room worktree (DOR-2091) — so a non-agent or
        // refused session has no manifest and contributes nothing.
        managed: (() => {
          const agentDir = launch?.identity
            ? homeOf(launch.identity)
            : homeOf(resolveAgentHome(session.cwd));
          return agentDir && refs.agentMcpServerService
            ? toSdkMcpServers(refs.agentMcpServerService.injectableServersForCwd(agentDir))
            : {};
        })(),
        // `marketplaceMcpDeps` is populated later in boot (the relay-enabled
        // marketplace-wiring block). This factory closure runs per query, so it
        // reads the captured binding lazily — by the time any session dispatches
        // a turn, it is either populated or intentionally undefined (marketplace
        // disabled), in which case the in-session marketplace tools are omitted.
        dorkos: createDorkOsToolServer(
          refs.mcpToolDeps!,
          session,
          sessionId,
          refs.marketplaceMcpDeps,
          refs.capabilityRegistry,
          launch?.hiddenToolNames,
          // Whose identity the tools act as, as the launch resolved it — the
          // agent a room worktree belongs to, not the worktree (DOR-2091).
          launch?.identity,
          // Whether the connector tools are listed, from facts that hold for
          // the whole session, so a staged warm-up and the turn after it list
          // the same tools (DOR-2685).
          launch?.connectorTools
        ),
      })
    );
  }

  // `/mcp` is always served — `requireMcpEnabled` answers the disabled case with
  // a clean 503. The routes, their gates and the transport are on the Hono
  // chain (`routes/mcp.ts`); this is the tool server behind them, built per
  // request. Auth is resolved per request by `decideMcpAuth` (env override →
  // per-user Better Auth key / session → legacy compat key → per-instance local
  // token, with the read-only carve-out in login-off mode). This is only a
  // startup log hint.
  const mcpAuthMode = env.MCP_API_KEY?.trim()
    ? 'auth: MCP_API_KEY override'
    : configManager.get('auth')?.enabled
      ? 'auth: login gate + per-user keys'
      : 'auth: local token (read-only tools tokenless)';
  const mcpServerFactory: McpServerFactory = async (caller) => {
    if (!refs.claudeRuntime || !refs.mcpToolDeps) {
      throw new Error(
        'ClaudeCodeRuntime not available — external MCP server cannot handle requests'
      );
    }
    // The server is rebuilt per request, so who is calling — the agent that
    // presented a token, the person the auth middleware verified, or neither
    // — is captured by the capability tool handlers it registers.
    //
    // What a Blocked permission hides from this caller (spec
    // `agent-permissions` D15): its own settings when it identified itself,
    // the install's defaults when it did not.
    const visibility = await resolveToolVisibilityFor(caller.identity?.agentPath, {
      inactive: Boolean(caller.identity?.inactive),
    });
    return createExternalMcpServer(
      refs.mcpToolDeps,
      refs.marketplaceMcpDeps,
      refs.capabilityRegistry,
      mcpCallerIdentity(caller),
      caller.userId,
      caller.agentIdentityPresented,
      visibility.hiddenToolNames
    );
  };
  logger.info(`[MCP] External MCP server mounted at /mcp (stateless, ${mcpAuthMode})`);

  // `deps` is what the route groups read (`http/hono-api.ts`), each set where
  // the service it hands over is ready.
  const localBrowserService = localBrowserHost.start(dorkHome);
  const deps: HonoApiDeps = {
    localBrowser: localBrowserService,
    connectorEventIngress: connectorSignedIngress,
    mcp: mcpServerFactory,
    docChannel: { ...docChannelHttp, metrics: docChannelMetrics },
  };
  // The test-control routes' reads, on a test-mode server only: handing them
  // over is what mounts the routes. The managed-MCP resolver is what the probe
  // seam (DOR-952) dials a managed server through, to prove the bearer gate.
  if (env.DORKOS_TEST_RUNTIME) {
    deps.testControl = {
      localBrowser: () => localBrowserService,
      meshCore: () => refs.meshCore,
      approvals: () => approvalService,
      agentMcpServers: () => refs.agentMcpServerService,
    };
  }

  // Hand the Tasks routes their deps if enabled (`startup/tasks.ts`).
  ({
    schedulerService: refs.schedulerService,
    taskRegistrar: refs.taskRegistrar,
    taskFileWatcher: refs.taskFileWatcher,
    taskReconciler: refs.taskReconciler,
    attachAgentTaskRoots: refs.attachAgentTaskRoots,
  } = await startTasks({
    honoDeps: deps,
    tasksEnabled,
    taskStore: refs.taskStore,
    dorkHome,
    meshCore: refs.meshCore,
    activityService,
    relayCore: refs.relayCore,
    schedulerConfig,
    firing,
    agentPauses,
    currentAdapterManager: () => refs.adapterManager,
    mountedRouters,
  }));
  // A skill an agent writes into `.agents/skills` reaches Claude Code within
  // seconds instead of at the next manual sync or the next boot (DOR-1850).
  //
  // Deliberately outside the tasks block above: the two watch the same directory
  // for unrelated reasons — one turns a `schedule:` block into a cron job, this
  // one projects the skill to the harnesses that cannot read it where it sits —
  // and switching schedules off must not switch projection off with it.
  //
  // The root list is re-read on every rescan rather than captured, so an agent
  // registered after boot is picked up without a subscription of its own. The
  // default project is in it because that is where a session with no better
  // answer runs; `harness.autoSync` off means no watcher at all.
  refs.skillsWatcher = startSkillsWatcher({
    dorkHome,
    roots: () => [DEFAULT_CWD, ...(refs.meshCore?.listWithPaths().map((a) => a.projectPath) ?? [])],
  });
  if (refs.skillsWatcher) {
    refs.turnEndReprojection = startTurnEndReprojection({
      watcher: refs.skillsWatcher,
      subscribe: onProjectorTurnBoundary,
      // The runtime's own live binding is the only cheap, authoritative answer
      // to "where did this turn run". Resolved through the session's OWN runtime
      // (ADR-0255's per-session binding, the same `resolveForSession` +
      // `getInternalSessionId` pair `lib/transcript-excerpt.ts` uses) rather
      // than by asking every registered runtime in turn: that shortcut would
      // hand one runtime a session id belonging to another, and the first
      // non-empty answer would win whether or not it was about this session.
      // `getSessionCwd` is optional on the contract and implemented by
      // claude-code alone, so this answers for the default runtime and nothing
      // for the others — which the watcher covers for the roots it watches.
      //
      // Whatever it answers is still judged against the boundary before a single
      // file is written: a session's directory is not a checked input.
      rootForSession: async (sessionId) => {
        const runtime = await runtimeRegistry.resolveForSession(sessionId);
        return runtime.getSessionCwd?.(runtime.getInternalSessionId(sessionId) ?? sessionId);
      },
    });
    // Logged once the first root pass has actually finished. Read synchronously
    // it was always `0`: taking a root on means asking the boundary about it,
    // which resolves the path on disk, so nothing is watched yet in the tick
    // `startSkillsWatcher` returns. Not awaited either — boot does not wait on a
    // log line — so this rides the same promise the watcher already had.
    //
    // The count is WATCHES, not roots, and the difference is real: a project
    // whose `.agents/skills` does not exist yet cannot be watched at all
    // (chokidar silently watches an ancestor instead), so it is covered by the
    // re-arm until the directory appears. Calling it a watched root would be a
    // number that says nothing went wrong when the watch is not there.
    const watcher = refs.skillsWatcher;
    void watcher
      .ready()
      .then(() => {
        logger.info('[HarnessSync] Watching for skills agents write', {
          watching: watcher.watchedRoots().length,
        });
      })
      .catch(() => {
        // `ready()` settles either way; a rejection here would be a defect in it
        // rather than anything a person can act on.
      });
  }
  return { deps, localBrowserService };
}

/** What {@link wireMcpTasksAndSkills} hands the steps after it. */
export type WireMcpTasksAndSkillsResult = Awaited<ReturnType<typeof wireMcpTasksAndSkills>>;
