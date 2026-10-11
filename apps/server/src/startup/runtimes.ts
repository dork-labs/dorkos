/**
 * Registering the agent runtimes at startup: the test-mode runtimes on a test
 * server, otherwise Claude Code, then Codex, OpenCode and the DorkOS runtime as
 * the config turns them on (DOR-2821, moved out of `index.ts` unchanged).
 *
 * Every runtime registers here, before the session-list broadcaster starts:
 * one registered after it is never fanned into the global session-list
 * stream. `index.ts` keeps what it shuts down or hands on.
 *
 * @module startup/runtimes
 */
import type { AgentRuntimeLike } from '@dorkos/relay';
import type { Db } from '@dorkos/db';
import { env } from '../env.js';
import { logger, logError } from '../lib/logger.js';
import { configManager } from '../services/core/config-manager.js';
import { initCloudLinkManager } from '../services/core/auth/cloud-link.js';
import { startCreditsRelay, type CreditsRelay } from '../services/core/cloud/credits-relay.js';
import {
  runtimeRegistry,
  applyAndWatchConfiguredDefaultRuntime,
  registerOptionalRuntime,
} from '../services/core/runtime-registry.js';
import { ClaudeCodeRuntime } from '../services/runtimes/claude-code/claude-code-runtime.js';
import { CodexRuntime, CodexThreadMap } from '../services/runtimes/codex/index.js';
import { resolveCodexTransport } from '../services/runtimes/codex/transport/index.js';
import { DoeRuntime } from '../services/runtimes/doe/index.js';
import {
  OpenCodeRuntime,
  OpenCodeSessionMap,
  openCodeServerManager,
  planOpenCodeSidecar,
  planOpenCodeTurn,
} from '../services/runtimes/opencode/index.js';
import {
  LocalSessionAttachmentStore,
  setSessionAttachmentStore,
} from '../services/session/attachments/index.js';

/** What registering the runtimes needs from the startup that came before it. */
export interface RuntimeStartupDeps {
  /** The consolidated database, already handed to `runtimeRegistry.setDb()`. */
  db: Db;
  /** The resolved DorkOS data directory. */
  dorkHome: string;
  /**
   * The credits relay as `index.ts` holds it now. Codex reads it per turn, so
   * it sees the relay go away at shutdown rather than a copy taken here.
   */
  currentCreditsRelay: () => CreditsRelay | null;
}

/** The runtimes `index.ts` keeps for later startup steps and for shutdown. */
export interface RegisteredRuntimes {
  /** The Claude Code runtime, or `null` on a test server. */
  claudeRuntime: ClaudeCodeRuntime | null;
  /** The DorkOS runtime, when it is on (always on a test server's test Cloud). */
  doeRuntime: DoeRuntime | null;
  /** The runtime relay messages reach agents through. */
  relayAgentRuntime: (AgentRuntimeLike & { readonly type: string }) | null;
  /** The loopback credits relay, when Codex or OpenCode is on and it started. */
  creditsRelay: CreditsRelay | null;
}

/**
 * Register every runtime this server runs, and apply the configured default.
 *
 * @param deps - See {@link RuntimeStartupDeps}.
 * @returns See {@link RegisteredRuntimes}.
 */
export async function registerRuntimes(deps: RuntimeStartupDeps): Promise<RegisteredRuntimes> {
  const { db, dorkHome } = deps;
  let claudeRuntime: ClaudeCodeRuntime | null = null;
  let doeRuntime: DoeRuntime | null = null;
  let relayAgentRuntime: RegisteredRuntimes['relayAgentRuntime'];
  let creditsRelay: CreditsRelay | null = null;
  if (env.DORKOS_TEST_RUNTIME) {
    const { TestModeRuntime } = await import('../services/runtimes/test-mode/test-mode-runtime.js');
    const testRuntime = new TestModeRuntime();
    testRuntime.setSessionSettings(runtimeRegistry);
    runtimeRegistry.register(testRuntime);
    relayAgentRuntime = testRuntime;
    // Optional SECOND instance under a distinct type — gives e2e a server with
    // more than one registered runtime (status-bar picker, ?runtime= launch
    // binding, session-list runtime marks) with zero real agent binaries.
    // Test branch only; the production path never registers test runtimes.
    if (env.DORKOS_TEST_RUNTIME_SECONDARY) {
      const secondaryRuntime = new TestModeRuntime('test-mode-b');
      secondaryRuntime.setSessionSettings(runtimeRegistry);
      runtimeRegistry.register(secondaryRuntime);
      logger.info('[TestMode] Secondary TestModeRuntime registered as test-mode-b');
    }
    // Optional claude-code-typed alias (DOR-952): a seeded agent's manifest can
    // only declare a real runtime enum (claude-code/codex/opencode), so the
    // managed-MCP OAuth e2e needs a runtime registered under 'claude-code' for
    // `GET /api/mcp-config?runtime=claude-code` to resolve `getMcpStatus` instead
    // of 400ing. Same TestModeRuntime class; the resolver injection below reaches
    // it too. Test branch only.
    if (env.DORKOS_TEST_RUNTIME_CLAUDE_ALIAS) {
      const aliasRuntime = new TestModeRuntime('claude-code');
      aliasRuntime.setSessionSettings(runtimeRegistry);
      runtimeRegistry.register(aliasRuntime);
      logger.info('[TestMode] TestModeRuntime alias registered as claude-code (DOR-952)');
    }
    runtimeRegistry.setDefault('test-mode');
    logger.info('[TestMode] TestModeRuntime registered — no real Claude API calls will be made');
    // The test-mode Cloud: the device link, every /v1 call, a local approval
    // page and a fake inference stream, all in-process, plus the DorkOS runtime
    // under DORKOS_TEST_RUNTIME_DOE (DOR-2783). Dynamic import keeps all of it
    // out of the production module graph — same pattern as TestModeRuntime above.
    const { composeTestModeCloud } =
      await import('../services/runtimes/test-mode/compose-test-cloud.js');
    doeRuntime = composeTestModeCloud(runtimeRegistry);
  } else {
    // Where images a turn produces live is chosen HERE and nowhere else: the
    // adapters and the serving route depend on the `SessionAttachmentStore`
    // interface and never build a path, so the day those bytes live somewhere
    // other than this machine, this line is what changes. Same doctrine as the
    // room attachment store below. Registered for the route, and handed to
    // every adapter that can produce media — an adapter given none declares
    // `mediaOutput: 'none'` rather than promising something it cannot keep.
    const sessionAttachmentStore = new LocalSessionAttachmentStore(dorkHome);
    setSessionAttachmentStore(sessionAttachmentStore);

    claudeRuntime = new ClaudeCodeRuntime(dorkHome, env.DORKOS_DEFAULT_CWD, sessionAttachmentStore);
    relayAgentRuntime = claudeRuntime;
    runtimeRegistry.register(claudeRuntime);
    // Inject the core session-settings store (ADR-0260). The registry implements
    // SessionSettingsPort structurally over session_metadata; setDb() ran above.
    claudeRuntime.setSessionSettings(runtimeRegistry);
    logger.info('[Runtime] ClaudeCodeRuntime registered as default');

    // Non-blocking warm-up — populates model cache without delaying server listen
    claudeRuntime.warmup().catch((err) => {
      logger.warn('[Startup] Model warm-up failed (will retry on first API call)', { err });
    });

    // Non-blocking plugin scan — populates activatedPlugins cache so the first
    // session picks up any previously installed marketplace plugins (ADR-0239).
    claudeRuntime.refreshActivatedPlugins().catch((err) => {
      logger.warn('[Startup] Plugin activation scan failed (will retry on next install)', { err });
    });

    // --- Codex runtime (spec additional-agent-runtimes, ADR-0309) ---
    // Gated on `runtimes.codex.enabled` config. Must register BEFORE
    // sessionListBroadcaster.start() below — runtimes registered after
    // start() are not fanned into the global session-list stream.
    const codexConfig = configManager.get('runtimes').codex;
    const openCodeConfig = configManager.get('runtimes').opencode;
    // The loopback relay a backend's credits provider is pointed at, so the
    // credits token never enters that backend's process (ADR 261002-221210,
    // amended by 261005-113107: Codex on app-server goes through it too).
    // Started where Codex or OpenCode runs; if it cannot start, a credits turn
    // on either can pay for nothing and refuses, never falls back.
    if (codexConfig.enabled || openCodeConfig.enabled) {
      creditsRelay = await startCreditsRelay().catch((err: unknown) => {
        logger.warn('[Cloud] Could not start the credits relay', logError(err));
        return null;
      });
    }
    if (codexConfig.enabled) {
      // Construction no longer depends on a resolvable `codex` binary: the
      // runtime resolves one lazily, per turn, so a machine with no Codex still
      // registers it and reports an honest `missing` with an install hint
      // (DOR-1334 / F9). registerOptionalRuntime stays as the last-resort guard
      // against any OTHER synchronous construction failure taking start() —
      // and the whole server process — down with it.
      registerOptionalRuntime(
        'CodexRuntime',
        'install the Codex CLI or set runtimes.codex.enabled to false in config to silence this',
        () => {
          const codexRuntime = new CodexRuntime({
            // The thread map shares the consolidated Drizzle handle injected into
            // runtimeRegistry.setDb() above (one DB, one `codex_threads` table).
            threadMap: new CodexThreadMap(db),
            // Where images a turn's MCP tools hand back are kept. Wiring it here
            // is what makes the runtime declare `mediaOutput: 'attachments'` —
            // the composition root owns the deployment decision, and the adapter
            // reports what it was actually given (ADR 260901-135657).
            attachments: sessionAttachmentStore,
            // How turns reach Codex (ADR 261005-113107). Read once: a change
            // takes effect at the next start, because clients cache capabilities.
            transport: resolveCodexTransport(codexConfig.transport),
            creditsRelay: () => deps.currentCreditsRelay() ?? undefined,
          });
          // Durable per-session settings hydrate/write-through (ADR-0260), same
          // port the Claude adapter uses.
          codexRuntime.setSessionSettings(runtimeRegistry);
          runtimeRegistry.register(codexRuntime);
          // Non-blocking session hydration — re-seeds the in-memory registry from
          // the durable `codex_threads` rows so past sessions survive a restart.
          // The registry emits session_upserted per hydrated session, so the live
          // list self-heals even when this completes after the broadcaster starts.
          codexRuntime.hydrateSessions().catch((err) => {
            logger.warn(
              '[Startup] Codex session hydration failed — past sessions stay off the list until their next turn',
              { err }
            );
          });
          logger.info('[Runtime] CodexRuntime registered');
          return codexRuntime;
        }
      );
    }

    // --- OpenCode runtime (spec additional-agent-runtimes, ADR-0308) ---
    // Gated on `runtimes.opencode.enabled` config. Must register BEFORE
    // sessionListBroadcaster.start() below, same as Codex. The sidecar spawns
    // lazily on first use; its shutdown is wired into shutdownServices().
    if (openCodeConfig.enabled) {
      // Same construct-can-throw exposure as Codex above — the sidecar's
      // binary discovery can throw synchronously if it isn't installed.
      // registerOptionalRuntime isolates the failure so it can't take the
      // server down with it.
      registerOptionalRuntime(
        'OpenCodeRuntime',
        'install the OpenCode CLI or set runtimes.opencode.enabled to false in config to silence this',
        () => {
          // The sidecar plans each boot and turn with the live credits token
          // and model list (ADR 261001-000811); without these it fails closed.
          openCodeServerManager.usePlanners({
            planSidecar: planOpenCodeSidecar,
            planTurn: planOpenCodeTurn,
            relay: creditsRelay ?? undefined,
          });
          const openCodeRuntime = new OpenCodeRuntime({
            provider: openCodeServerManager,
            // Durable sessionId <-> OpenCode-session-id map on the shared Drizzle
            // handle, so DorkOS-facing ids survive a server restart (DOR-251).
            sessionMap: new OpenCodeSessionMap(db),
            // Where images a turn produces are kept. Wiring it here is what
            // makes the runtime declare `mediaOutput: 'attachments'` — the
            // composition root owns the deployment decision, and the adapter
            // reports what it was actually given (ADR 260901-135657).
            attachments: sessionAttachmentStore,
          });
          // Durable per-session settings hydrate/write-through (ADR-0260), same
          // port the Claude adapter uses.
          openCodeRuntime.setSessionSettings(runtimeRegistry);
          runtimeRegistry.register(openCodeRuntime);
          logger.info('[Runtime] OpenCodeRuntime registered');
          return openCodeRuntime;
        }
      );
    }

    // Register before the broadcaster subscribes; construction performs no inference.
    if (configManager.get('runtimes').doe.enabled) {
      registerOptionalRuntime('DorkOS', 'check the DorkOS data directory permissions', () => {
        doeRuntime = new DoeRuntime();
        doeRuntime.setSessionSettings(runtimeRegistry);
        runtimeRegistry.register(doeRuntime);
        return doeRuntime;
      });
    }

    // Apply the user's configured default runtime (runtimes.default) once all
    // production runtimes are registered — and keep applying it, so changing it
    // in Settings takes effect on the next session rather than the next restart.
    // An unregistered value (disabled runtime, typo) keeps the built-in default
    // rather than failing boot.
    applyAndWatchConfiguredDefaultRuntime(runtimeRegistry, {
      read: () => configManager.get('runtimes').default,
      onChange: (listener) => configManager.onChange(listener),
    });
    initCloudLinkManager(); // real fetch, real defaults — behavior-preserving
  }
  return { claudeRuntime, doeRuntime, relayAgentRuntime, creditsRelay };
}
