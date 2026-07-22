import path from 'path';
import { createApp, finalizeApp } from './app.js';
import { ClaudeCodeRuntime } from './services/runtimes/claude-code/claude-code-runtime.js';
import {
  CodexRuntime,
  CodexThreadMap,
  createCodexUiMcpServer,
} from './services/runtimes/codex/index.js';
import {
  OpenCodeRuntime,
  OpenCodeSessionMap,
  openCodeServerManager,
} from './services/runtimes/opencode/index.js';
import {
  runtimeRegistry,
  applyConfiguredDefaultRuntime,
  registerOptionalRuntime,
} from './services/core/runtime-registry.js';
import { initAuth, seedLegacyMcpApiKey, resolveMcpLocalToken } from './services/core/auth/index.js';
import {
  canExpose,
  checkA2aExposure,
  checkBindAllowed,
} from './services/core/auth/exposure-guard.js';
import { tunnelManager } from './services/core/tunnel-manager.js';
import { initCloudLinkManager, getCloudLinkManager } from './services/core/auth/cloud-link.js';
import { initConfigManager, configManager } from './services/core/config-manager.js';
import { credentialProvider, initCredentialProvider } from './services/core/credential-provider.js';
import { initBoundary } from './lib/boundary.js';
import { initLogger, logger, logError } from './lib/logger.js';
import { createDorkOsToolServer } from './services/runtimes/claude-code/mcp-tools/index.js';
import { TaskStore } from './services/tasks/task-store.js';
import { TaskCompletionNotifier } from './services/tasks/task-completion-notifier.js';
import { broadcastRunTerminal } from './services/tasks/run-terminal-broadcaster.js';
import {
  TaskSchedulerService,
  type SchedulerAgentManager,
} from './services/tasks/task-scheduler-service.js';
import { resolveTasksFiring } from './services/tasks/resolve-firing.js';
import { TaskFileWatcher } from './services/tasks/task-file-watcher.js';
import { TaskReconciler } from './services/tasks/task-reconciler.js';
import { ensureDefaultTemplates } from './services/tasks/task-templates.js';
import { createTasksRouter } from './routes/tasks.js';
import { setTasksEnabled, setTasksInitError } from './services/tasks/task-state.js';
import {
  RelayCore,
  AdapterRegistry,
  SignalEmitter,
  type ClaudeCodeAgentRuntimeLike,
} from '@dorkos/relay';
import { createRelayRouter } from './routes/relay.js';
import { createConnectorsRouter } from './routes/connectors.js';
import { createSessionConnectorsRouter } from './routes/session-connectors.js';
import { ConnectorRegistry } from './services/connectors/registry.js';
import { maybeCreateComposioProvider } from './services/connectors/providers/composio.js';
import {
  maybeCreateNangoProvider,
  NangoEncryptionKeyError,
} from './services/connectors/providers/nango.js';
import { SessionConnectorService } from './services/connectors/session-exposure.js';
import { toSdkMcpServers } from './services/runtimes/claude-code/mcp-server-config.js';
import { setRelayEnabled, setRelayInitError } from './services/relay/relay-state.js';
import { AdapterManager } from './services/relay/adapter-manager.js';
import { createInitiateConsentGate } from './services/relay/initiate-consent.js';
import { TraceStore } from './services/relay/trace-store.js';
import { MeshCore } from '@dorkos/mesh';
import { createMeshRouter } from './routes/mesh.js';
import { setMeshInitError } from './services/mesh/mesh-state.js';
import { ensureDorkBot } from './services/mesh/ensure-dorkbot.js';
import { createA2aRouter } from './routes/a2a.js';
import { buildA2aRateLimiters } from './middleware/a2a-rate-limit.js';
import { createAgentsRouter } from './routes/agents.js';
import { createDiscoveryRouter } from './routes/discovery.js';
import { createTemplateRouter } from './routes/templates.js';
import { createAdminRouter } from './routes/admin.js';
import { ExtensionManager } from './services/extensions/extension-manager.js';
import { ensureCoreExtensions } from './services/core-extensions/ensure-core-extensions.js';
import { warnRedundantEnabledEntries } from './services/core-extensions/warn-redundant-enabled.js';
import type { CoreExtensionInfo } from './services/extensions/extension-enable-resolution.js';
import { createExtensionsRouter } from './routes/extensions.js';
import { createAgentWorkspace } from './services/core/agent-creator.js';
import { defaultTemplateDownloader } from './services/core/template-downloader.js';
import { MarketplaceSourceManager } from './services/marketplace/marketplace-source-manager.js';
import { MarketplaceCache } from './services/marketplace/marketplace-cache.js';
import { PackageResolver } from './services/marketplace/package-resolver.js';
import { PackageFetcher } from './services/marketplace/package-fetcher.js';
import { ConflictDetector } from './services/marketplace/conflict-detector.js';
import { PermissionPreviewBuilder } from './services/marketplace/permission-preview.js';
import { PluginInstallFlow } from './services/marketplace/flows/install-plugin.js';
import { AgentInstallFlow } from './services/marketplace/flows/install-agent.js';
import { SkillPackInstallFlow } from './services/marketplace/flows/install-skill-pack.js';
import { AdapterInstallFlow } from './services/marketplace/flows/install-adapter.js';
import { ShapeInstallFlow } from './services/marketplace/flows/install-shape.js';
import { createShapesRouter } from './routes/shapes.js';
import {
  applyShape,
  type ApplyShapeDeps,
  type ShapeScheduleServiceLike,
} from './services/shapes/apply-shape.js';
import { ShapeScheduleService } from './services/shapes/shape-schedule-service.js';
import {
  rebindShapeSchedulesForAgent,
  type RebindAgent,
} from './services/shapes/rebind-schedules.js';
import { setOnAgentCreated } from './services/core/agent-created-hook.js';
import {
  clearActiveShape,
  createFsShapeManifestResolver,
  createShapeConfigStore,
  createShapeSecretChecker,
  getActiveShapeName,
  getEnabledExtensionIds,
  listInstalledShapeManifests,
} from './services/shapes/shape-services.js';
import { UninstallFlow } from './services/marketplace/flows/uninstall.js';
import { UpdateFlow } from './services/marketplace/flows/update.js';
import { MarketplaceInstaller } from './services/marketplace/marketplace-installer.js';
import { createMarketplaceRouter } from './routes/marketplace.js';
import { runAutoProjection } from './services/harness/auto-project.js';
import { ensurePersonalMarketplace } from './services/marketplace-mcp/personal-marketplace.js';
import {
  AutoApproveConfirmationProvider,
  TokenConfirmationProvider,
  type ConfirmationProvider,
} from './services/marketplace-mcp/confirmation-provider.js';
import { setMarketplaceConfirmationProvider } from './services/marketplace-mcp/confirmation-registry.js';
import type { MarketplaceMcpDeps } from './services/marketplace-mcp/marketplace-mcp-tools.js';
import { ActivityService } from './services/activity/activity-service.js';
import { sweepStaleInstallBackups } from './services/marketplace/backup-janitor.js';
import { createActivityRouter } from './routes/activity.js';
import { createExtensionRoutesMiddleware } from './middleware/extension-routes.js';
import { createExternalMcpServer } from './services/core/mcp-server.js';
import { createMcpRouter } from './routes/mcp.js';
import { createMcpAuth } from './middleware/mcp-auth.js';
import { validateMcpOrigin } from './middleware/mcp-origin.js';
import { requireMcpEnabled } from './middleware/mcp-enabled.js';
import { buildMcpRateLimiter } from './middleware/mcp-rate-limit.js';
import { createDb, runMigrations, agents } from '@dorkos/db';
import { INTERVALS } from './config/constants.js';
import { resolveDorkHome } from './lib/dork-home.js';
import { SERVER_VERSION } from './lib/version.js';
import { createWorkspaceSubsystem, setWorkspaceManager } from './services/workspace/index.js';
import { TerminalManager, attachTerminalWebSocket } from './services/terminal/index.js';
import { createTerminalRouter } from './routes/terminal.js';
import { registerDorkosCommunityTelemetry } from './services/marketplace/telemetry-reporter.js';
import { registerHeartbeat, type HeartbeatCounts } from './services/core/heartbeat-reporter.js';
import {
  registerUsageReporter,
  reportUsageEvent,
  shutdownUsageReporter,
} from './services/core/usage-reporter.js';
import {
  registerServerErrorReporting,
  flushServerError,
  captureServerError,
} from './services/core/error-reporter.js';
import {
  registerAiMetadataReporter,
  shutdownAiMetadataReporter,
} from './services/core/ai-metadata-reporter.js';
import { resolveTelemetryConsent, isTelemetryDebugEnabled } from '@dorkos/shared/telemetry-consent';
import {
  decideTier1Boot,
  formatFirstRunTelemetryNotice,
} from './services/core/telemetry-first-run.js';
import { eventFanOut } from './services/core/event-fan-out.js';
import {
  initObservability,
  shutdownObservability,
  isOtlpExporting,
  traceRelay,
} from './services/observability/index.js';
import { sessionListBroadcaster } from './services/session/session-list-broadcaster.js';
import {
  SessionEventStore,
  setSessionEventStore,
  onProjectorRekey,
} from './services/session/index.js';
import { aggregateSessionList } from './services/session/aggregate-session-list.js';
import { env } from './env.js';

const PORT = env.DORKOS_PORT;

// Global references for graceful shutdown
let claudeRuntime: ClaudeCodeRuntime | null = null;
// The runtime the Tasks scheduler drives. ClaudeCodeRuntime in production; in
// test mode (DORKOS_TEST_RUNTIME) the registered TestModeRuntime stands in so
// the Tasks surface is reachable for e2e and the marketing capture pipeline
// (SchedulerAgentManager needs only ensureSession + sendMessage, both of which
// TestModeRuntime implements). Never a real agent binary in test mode.
let schedulerAgentManager: SchedulerAgentManager | null = null;
let schedulerService: TaskSchedulerService | null = null;
let relayCore: RelayCore | undefined;
let adapterRegistry: AdapterRegistry | undefined;
let adapterManager: AdapterManager | undefined;
let traceStore: TraceStore | undefined;
let meshCore: MeshCore | undefined;
let extensionManager: ExtensionManager | undefined;
let taskFileWatcher: TaskFileWatcher | undefined;
let taskReconciler: TaskReconciler | undefined;
let healthCheckInterval: ReturnType<typeof setInterval> | undefined;
// Embedded-terminal PTY manager (ADR 260708-185521). Always-on, boundary-confined;
// the WebSocket byte channel is attached to the HTTP server after listen().
let terminalManager: TerminalManager | undefined;

async function start() {
  // KEEP IN SYNC with `bootInProcessTestServer()` in `harness-boot.ts`: the
  // eval harness mirrors the subset of this function's singleton wiring a
  // driven turn needs (config store, boundary, DB + session-event store,
  // runtime registration), with no compile-time link. If a new process-global
  // singleton lands here and the turn path reads it, wire it there too — the
  // harness's structural self-test is the tripwire that goes red on drift.
  //
  // Resolve data directory once and make it available to all downstream services.
  // Priority: DORK_HOME env var > .temp/.dork (dev) > ~/.dork (production)
  const dorkHome = resolveDorkHome();
  // eslint-disable-next-line no-restricted-syntax -- write (not read): broadcasts resolved dorkHome to services loaded after this point
  process.env.DORK_HOME = dorkHome;
  console.log(`[DorkOS] Data directory: ${dorkHome}`);

  const logLevel = env.DORKOS_LOG_LEVEL;
  initLogger({ level: logLevel, logDir: path.join(dorkHome, 'logs') });
  initConfigManager(dorkHome);
  // Credential substrate (ADR-0315): resolves stored credential references to
  // secrets at each runtime's env-injection seam. Must precede any runtime spawn.
  initCredentialProvider(dorkHome);

  // Apply logging config (maxLogSize/maxLogFiles) from user config.
  // initLogger was already called above with defaults — re-init with config values.
  const loggingConfig = configManager.get('logging');
  if (loggingConfig?.maxLogSizeKb || loggingConfig?.maxLogFiles) {
    initLogger({
      level: logLevel,
      logDir: path.join(dorkHome, 'logs'),
      maxLogSize: (loggingConfig.maxLogSizeKb ?? 500) * 1024,
      maxLogFiles: loggingConfig.maxLogFiles ?? 14,
    });
  }

  // Observability (DOR-294 local file + DOR-313 bring-your-own OTLP). Off unless
  // the operator opts in: `dorkos --debug-trace` (DORKOS_OTEL_DEBUG) writes a
  // sanitized JSONL trace file, and the standard OTEL_EXPORTER_OTLP_ENDPOINT
  // ships spans to their own stack. Both are the operator's own data going to
  // their own tools; nothing reaches DorkOS. Must run before runtimes/relay are
  // registered so the tracing wrappers see it on.
  const traceFile = await initObservability({
    debug: env.DORKOS_OTEL_DEBUG,
    dorkHome,
    version: SERVER_VERSION,
  });
  if (traceFile) {
    logger.info(`[OTel] Debug tracing ON — writing spans to ${traceFile}`);
  }
  if (isOtlpExporting()) {
    logger.info(
      `[OTel] OTLP trace export ON — shipping spans to ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`
    );
  }

  // Create consolidated Drizzle database and run migrations before any service init.
  // Individual services still manage their own legacy databases for now — they will
  // be migrated to accept this `db` instance in subsequent tasks.
  const dbPath = path.join(dorkHome, 'dork.db');
  const db = createDb(dbPath);
  runMigrations(db);
  logger.info(`[DB] Consolidated database ready at ${dbPath}`);

  // Durable session-event store for LOG-BACKED runtimes (codex/opencode/
  // test-mode), injected once here so their completed-turn history survives a
  // server restart (DOR-189). Wired before any runtime registers so the first
  // turn/subscribe of a log-backed session persists and hydrates.
  setSessionEventStore(new SessionEventStore(db));

  // Inject the DB handle into the runtime registry so session-scoped resolution
  // (resolveForSession / persistSessionRuntime / getSessionRuntimeType) can read
  // and write the `session_metadata` table. Must happen before any route or
  // service uses these methods. See ADR 0255.
  runtimeRegistry.setDb(db);

  // Initialize the Better Auth identity core over the consolidated DB. Mounted
  // by createApp() at /api/auth/* regardless of `config.auth.enabled` (the gate
  // is a later task) so the enable-login flow can create the owner account
  // before the flag flips. See services/core/auth/.
  // dorkHome is threaded through so the session-signing secret resolves from
  // (and, on first boot, persists into) a 0600 file there — a fresh install
  // signs in with zero manual `BETTER_AUTH_SECRET` setup (DOR-242).
  initAuth(db, dorkHome);

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

  // Initialize Activity Service and prune stale events
  const activityService = new ActivityService(db);
  const retentionDays = env.DORKOS_ACTIVITY_RETENTION_DAYS ?? 30;
  try {
    const pruned = await activityService.prune(retentionDays);
    if (pruned > 0) {
      logger.info(`[Activity] Pruned ${pruned} events older than ${retentionDays} days`);
    }
  } catch (err) {
    logger.warn('[Activity] Startup prune failed', logError(err));
  }

  // Sweep crash-left marketplace install backups (`<target>.dorkos-bak-<ts>-<uuid>`,
  // see transaction.ts + ADR-0304). A hard crash mid-install can leave one of
  // these behind forever; before DOR-175 a crash-left agent backup could also
  // resurface as a phantom duplicate agent via mesh discovery. Only backups
  // whose embedded timestamp is >24h old are removed — see backup-janitor.ts
  // for why that guard can never race a live install.
  try {
    const sweptBackups = await sweepStaleInstallBackups(dorkHome, logger);
    if (sweptBackups > 0) {
      logger.info(
        `[Marketplace] Swept ${sweptBackups} stale install backup${sweptBackups === 1 ? '' : 's'}`
      );
    }
  } catch (err) {
    logger.warn('[Marketplace] Startup backup sweep failed', logError(err));
  }

  // Initialize directory boundary (must happen before app creation)
  const boundaryConfig = env.DORKOS_BOUNDARY;
  const resolvedBoundary = await initBoundary(boundaryConfig);
  logger.info(`[Boundary] Directory boundary: ${resolvedBoundary}`);

  // Env kill switches (DOR-312) fold into every channel's consent: DO_NOT_TRACK
  // or DORKOS_TELEMETRY_DISABLED force all outbound telemetry off regardless of
  // config (precedence: env > config). `DORKOS_TELEMETRY_DEBUG` makes the
  // payload senders print to stderr instead of sending. Parsing lives in the
  // shared helper so the CLI and server agree. Read from the parsed `env` (the
  // sole place process.env is touched on the server).
  const telemetryEnv = {
    DO_NOT_TRACK: env.DO_NOT_TRACK,
    DORKOS_TELEMETRY_DISABLED: env.DORKOS_TELEMETRY_DISABLED,
    DORKOS_TELEMETRY_DEBUG: env.DORKOS_TELEMETRY_DEBUG,
  };
  const telemetryDebug = isTelemetryDebugEnabled(telemetryEnv);

  // Tier 1 opt-out telemetry (ADR 260713-143958). The heartbeat, install, and
  // feature-usage channels default ON and are genuinely anonymous, but the
  // Homebrew ordering rule requires a first-run notice before anything sends.
  // `decideTier1Boot` reads the consent snapshot ONCE, here, and captures the
  // send gate BEFORE the notice writes `lastPromptedVersion` — so nothing sends
  // on the boot that first shows the notice, and the install reporter (below),
  // the usage reporter (below), and the heartbeat (registered later, in the
  // `server.listen` callback) all share this one captured `tier1SendGate`.
  // Sends begin on the next boot at the earliest.
  const telemetryConfig = configManager.get('telemetry');
  const tier1Boot = decideTier1Boot(telemetryConfig, SERVER_VERSION);
  const tier1SendGate = tier1Boot.sendGate;

  // Register the dorkos.ai marketplace install reporter. No-op unless
  // `config.telemetry.install` is on (default true), no env kill switch is set,
  // AND the Tier 1 notice gate is open. The reporter forwards `InstallEvent`s
  // emitted by the marketplace install pipeline to
  // https://dorkos.ai/api/telemetry/install with a stable per-machine install ID
  // stored in dorkHome. Privacy contract: https://dorkos.ai/marketplace/privacy
  const installConsent =
    resolveTelemetryConsent(telemetryConfig?.install ?? false, telemetryEnv) && tier1SendGate;
  registerDorkosCommunityTelemetry(installConsent, dorkHome, SERVER_VERSION, telemetryDebug);
  if (installConsent) {
    logger.info('[Telemetry] Marketplace install reporter registered (Tier 1, anonymous)');
  }

  // First-run notice: print the plain-language disclosure and record
  // `lastPromptedVersion` so the next boot's gate opens. The gate above was
  // snapshotted BEFORE this write, guaranteeing this boot sends nothing.
  if (tier1Boot.showNotice) {
    logger.info(`[Telemetry] First-run notice\n${formatFirstRunTelemetryNotice()}`);
    const current = configManager.get('telemetry');
    configManager.set('telemetry', {
      ...current,
      lastPromptedVersion: tier1Boot.lastPromptedVersionToWrite,
    });
  }

  // Register the anonymous feature-usage reporter (DOR-315, ADR 260713-143958
  // Phase 3). Tier 1: `telemetry.usage` defaults ON, but sends only when no env
  // kill switch is set (`resolveTelemetryConsent`) AND the CAPTURED pre-notice
  // `tier1SendGate` above is open — the same snapshotted gate the install and
  // heartbeat senders use, never re-read after the notice writes
  // `lastPromptedVersion`, so a never-prompted install sends nothing this boot.
  // No-op (no timer, no network) unless all three hold. Curated events flow
  // through the owned ingest at https://dorkos.ai/api/telemetry/events.
  const usageConsent =
    resolveTelemetryConsent(telemetryConfig?.usage ?? true, telemetryEnv) && tier1SendGate;
  registerUsageReporter({
    enabled: usageConsent,
    debug: telemetryDebug,
    dorkHome,
    dorkosVersion: SERVER_VERSION,
  });
  if (usageConsent) {
    // Emit `app_started` once at boot: coarse platform-arch + how many runtimes
    // are configured (a count, never their names or anything identifying).
    const startupRuntimes = configManager.get('runtimes');
    const runtimesConfiguredCount =
      1 + (startupRuntimes.codex.enabled ? 1 : 0) + (startupRuntimes.opencode.enabled ? 1 : 0);
    reportUsageEvent({
      event: 'app_started',
      properties: {
        os: `${process.platform}-${process.arch}`,
        runtimesConfigured: runtimesConfiguredCount,
      },
    });
    logger.info('[Telemetry] Usage reporter active (consent: opt-out, notice-gated)');
  }

  // Opt-in error reporting (DOR-293, consolidated in DOR-318). A SEPARATE
  // explicit opt-in (Tier 2) from the anonymous-data channels: fires only when
  // `telemetry.errorReporting` is true AND no kill switch is set. Crash reports
  // map to a PostHog `$exception` event and POST to the OWNED ingest
  // (https://dorkos.ai/api/telemetry/events) — no third-party egress, no
  // `SENTRY_DSN`. Off → the process handlers below (and `POST /api/errors`) send
  // nothing. Scrubbing + message omission live in the shared error-report core.
  registerServerErrorReporting({
    consent: resolveTelemetryConsent(telemetryConfig?.errorReporting ?? false, telemetryEnv),
    version: SERVER_VERSION,
    environment: env.NODE_ENV,
    cwd: process.cwd(),
    dorkHome,
    debug: telemetryDebug,
  });

  // Opt-in AI-run metadata bridge (DOR-319, ADR 260713-143958 Phase 7). A
  // SEPARATE Tier 2 opt-in from every other channel: fires only when
  // `telemetry.aiMetadata` is true (default FALSE) AND no kill switch is set. The
  // notice gate does NOT apply — turning it on IS the explicit consent. When on,
  // this installs the observability bridge so the runtime-wrap seam (registered
  // BELOW — hence this must run first) emits one `$ai_generation` metadata event
  // per completed turn to the owned ingest. Off → the bridge stays uninstalled
  // and no turn is ever harvested for it. Metadata only: model, tokens, timing,
  // cost — never prompts, code, paths, or content.
  registerAiMetadataReporter({
    enabled: resolveTelemetryConsent(telemetryConfig?.aiMetadata ?? false, telemetryEnv),
    debug: telemetryDebug,
    dorkHome,
    dorkosVersion: SERVER_VERSION,
  });

  // Stage the bundled core extensions on disk before the discovery pipeline
  // runs, and capture their tier metadata (default-on/off, disableability) to
  // hand to the ExtensionManager. Non-fatal: a missing or malformed bundle must
  // not block server boot — it just means that core extension is absent.
  let coreExtensions: CoreExtensionInfo[] = [];
  try {
    coreExtensions = await ensureCoreExtensions(dorkHome);
  } catch (err) {
    logger.warn('[CoreExtensions] Failed to stage core extensions', logError(err));
  }
  // Honest-by-design guardrail: warn if a hand-editor listed a default-on core
  // extension in `extensions.enabled` (a no-op — use `extensions.disabled`).
  warnRedundantEnabledEntries(coreExtensions, configManager.get('extensions').enabled);

  // Initialize Extension System
  try {
    extensionManager = new ExtensionManager(dorkHome, coreExtensions);
    const initialCwd = env.DORKOS_DEFAULT_CWD ?? null;
    await extensionManager.initialize(initialCwd);
    logger.info('[Extensions] Extension system initialized');
  } catch (err) {
    logger.error('[Extensions] Failed to initialize extension system', err);
    // Extension failure is non-fatal: server continues without extensions
    extensionManager = undefined;
  }

  // --- Register runtime: TestModeRuntime in test mode, ClaudeCodeRuntime otherwise ---
  if (env.DORKOS_TEST_RUNTIME) {
    const { TestModeRuntime } = await import('./services/runtimes/test-mode/test-mode-runtime.js');
    const testRuntime = new TestModeRuntime();
    runtimeRegistry.register(testRuntime);
    // Let the Tasks scheduler drive the test-mode runtime (see declaration).
    schedulerAgentManager = testRuntime;
    // Optional SECOND instance under a distinct type — gives e2e a server with
    // more than one registered runtime (status-bar picker, ?runtime= launch
    // binding, session-list runtime marks) with zero real agent binaries.
    // Test branch only; the production path never registers test runtimes.
    if (env.DORKOS_TEST_RUNTIME_SECONDARY) {
      runtimeRegistry.register(new TestModeRuntime('test-mode-b'));
      logger.info('[TestMode] Secondary TestModeRuntime registered as test-mode-b');
    }
    runtimeRegistry.setDefault('test-mode');
    logger.info('[TestMode] TestModeRuntime registered — no real Claude API calls will be made');
    // Cloud-link transport: fake the network dependency to dorkos.ai only, so
    // the capture pipeline can photograph a real pending→linked flip offline.
    // Dynamic import keeps fake-cloud-link.ts out of the production module
    // graph — same pattern as TestModeRuntime above.
    const { createFakeCloudLinkFetch } =
      await import('./services/runtimes/test-mode/fake-cloud-link.js');
    initCloudLinkManager({ fetchImpl: createFakeCloudLinkFetch() });
  } else {
    claudeRuntime = new ClaudeCodeRuntime(dorkHome, env.DORKOS_DEFAULT_CWD);
    schedulerAgentManager = claudeRuntime;
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
    if (codexConfig.enabled) {
      // Construction can throw synchronously (e.g. the Codex CLI binary isn't
      // installed — the norm in the packaged desktop app, which bundles only
      // the claude-code SDK). registerOptionalRuntime isolates that failure so
      // it can't reject start() and kill the whole server process.
      registerOptionalRuntime(
        'CodexRuntime',
        'install the Codex CLI or set runtimes.codex.enabled to false in config to silence this',
        () => {
          const codexRuntime = new CodexRuntime({
            // The thread map shares the consolidated Drizzle handle injected into
            // runtimeRegistry.setDb() above (one DB, one `codex_threads` table).
            threadMap: new CodexThreadMap(db),
            binaryPath: codexConfig.binaryPath,
            // Loopback URL of the scoped `dorkos_ui` MCP server mounted below at
            // /codex-ui-mcp. Codex's MCP client sends no Origin header, so it clears
            // validateMcpOrigin via the non-browser early return (not the allowlist).
            // Exposes `control_ui` to Codex for canvas parity (the event-mapper turns
            // the resulting mcp_tool_call into a ui_command).
            mcpUiUrl: `http://127.0.0.1:${PORT}/codex-ui-mcp`,
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
    const openCodeConfig = configManager.get('runtimes').opencode;
    if (openCodeConfig.enabled) {
      // Same construct-can-throw exposure as Codex above — the sidecar's
      // binary discovery can throw synchronously if it isn't installed.
      // registerOptionalRuntime isolates the failure so it can't take the
      // server down with it.
      registerOptionalRuntime(
        'OpenCodeRuntime',
        'install the OpenCode CLI or set runtimes.opencode.enabled to false in config to silence this',
        () => {
          const openCodeRuntime = new OpenCodeRuntime({
            provider: openCodeServerManager,
            // Durable sessionId <-> OpenCode-session-id map on the shared Drizzle
            // handle, so DorkOS-facing ids survive a server restart (DOR-251).
            sessionMap: new OpenCodeSessionMap(db),
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

    // Apply the user's configured default runtime (runtimes.default) once all
    // production runtimes are registered. An unregistered value (disabled
    // runtime, typo) keeps the built-in default rather than failing boot.
    const configuredDefault = configManager.get('runtimes').default;
    if (
      !applyConfiguredDefaultRuntime(runtimeRegistry, configuredDefault) &&
      configuredDefault !== runtimeRegistry.getDefaultType()
    ) {
      logger.warn('[Runtime] configured runtimes.default is not registered; keeping built-in', {
        configured: configuredDefault,
        active: runtimeRegistry.getDefaultType(),
      });
    }
    initCloudLinkManager(); // real fetch, real defaults — behavior-preserving
  }

  // Workspace subsystem (DOR-84) — server-managed isolated workspaces. Sessions
  // bind via cwd; the manager allocates collision-free port blocks and owns the
  // lifecycle. Attached sessions are resolved from the runtime's session list.
  const workspaceConfig = configManager.get('workspace');
  if (workspaceConfig.enabled) {
    const { service: workspaceService, reconciler: workspaceReconciler } = createWorkspaceSubsystem(
      {
        db,
        dorkHome,
        config: workspaceConfig,
        listAttachedSessions: async (workspacePath) => {
          try {
            // Aggregate across every registered runtime (ADR-0310) — a workspace
            // may hold Codex or OpenCode sessions, not just the default runtime's.
            const { sessions } = await aggregateSessionList({
              runtimes: runtimeRegistry.listRuntimes(),
              projectDir: workspacePath,
            });
            return sessions.map((s) => ({
              sessionId: s.id,
              cwd: s.cwd ?? workspacePath,
              title: s.title,
            }));
          } catch {
            return [];
          }
        },
      }
    );
    setWorkspaceManager(workspaceService);
    workspaceReconciler.start();
    logger.info('[Workspace] WorkspaceManager registered');
  }

  // Initialize Tasks scheduler if enabled
  const schedulerConfig = configManager.get('scheduler');

  const tasksEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED : schedulerConfig.enabled;

  // The FIRING gate (ADR-285) is decoupled from the subsystem gate above: tasks
  // still list/display wherever the subsystem is up, but only a real production
  // environment fires (dev/preview default off unless DORKOS_TASKS_ENABLED=true).
  const firing = resolveTasksFiring({
    nodeEnv: env.NODE_ENV,
    // eslint-disable-next-line no-restricted-syntax -- presence check: unset vs explicit false
    explicitOverride: 'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED : undefined,
    schedulerEnabled: schedulerConfig.enabled,
  });

  let taskStore: TaskStore | undefined;
  if (tasksEnabled) {
    try {
      taskStore = new TaskStore(db);
      logger.info('[Tasks] TaskStore initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Tasks] Failed to initialize TaskStore at ${dorkHome}`, errInfo);
      setTasksInitError(errInfo.error);
      // Tasks failure is non-fatal: server continues without scheduler routes.
    }
  }

  // Initialize Relay if enabled
  const relayConfig = configManager.get('relay');
  // Env var wins when explicitly set; fall back to config when not set.
  // boolFlag defaults to false even when unset, so check process.env directly.

  const relayEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_RELAY_ENABLED' in process.env ? env.DORKOS_RELAY_ENABLED : relayConfig.enabled;

  // Phase A: core relay infrastructure (RelayCore + TraceStore)
  // AdapterManager construction is deferred to Phase C (after meshCore init)
  // so that meshCore is available for CWD resolution via buildContext().
  const relayDataDir = relayConfig.dataDir ?? path.join(dorkHome, 'relay');
  if (relayEnabled) {
    try {
      adapterRegistry = new AdapterRegistry();
      adapterRegistry.setLogger(logger);

      // Initialize trace store before RelayCore so it can be injected for delivery tracking
      traceStore = new TraceStore(db);
      logger.info('[Relay] TraceStore initialized');

      // traceRelay wraps publish with a relay.dispatch span when debug tracing
      // is on; returns the core untouched otherwise (zero overhead).
      relayCore = traceRelay(
        new RelayCore({
          dataDir: relayDataDir,
          adapterRegistry,
          db,
          traceStore,
          logger,
          // Tick the Pulse attention badge the instant a message is dead-lettered
          // (DOR-403) instead of waiting for the 30s dead-letters poll.
          onDeadLetter: (notice) => eventFanOut.broadcast('relay_dead_letter', notice),
        })
      );
      await relayCore.registerEndpoint('relay.system.console');
      logger.info(`[Relay] RelayCore initialized (dataDir: ${relayDataDir})`);
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Relay] Failed to initialize at ${relayDataDir}`, errInfo);
      setRelayInitError(errInfo.error);
      // Relay failure is non-fatal: server continues without relay routes.
      relayCore = undefined;
      traceStore = undefined;
    }
  }

  // Initialize Mesh (always-on, ADR-0062)
  // Wire SignalEmitter when Relay is enabled so MeshCore can broadcast lifecycle
  // signals. When Relay is absent, signalEmitter stays undefined and MeshCore
  // silently skips signal emission.
  const meshSignalEmitter = relayCore ? new SignalEmitter() : undefined;

  try {
    meshCore = new MeshCore({
      db,
      relayCore,
      signalEmitter: meshSignalEmitter,
      // ADR-0043: the reconciler rebuilds the DB from files by walking the
      // managed agents home dir (DorkBot + installed agents) every pass.
      agentsHomeDir: path.join(dorkHome, 'agents'),
      logger,
    });
    logger.info('[Mesh] MeshCore initialized');

    // Provide MeshCore to runtime for per-session manifest lookup and peer agents context
    // Only ClaudeCodeRuntime exposes setMeshCore — skip in test mode.
    if (claudeRuntime) {
      claudeRuntime.setMeshCore(meshCore);
    }

    // Run startup reconciliation (non-fatal)
    try {
      const result = await meshCore.reconcileOnStartup();
      logger.info('[Mesh] Startup reconciliation complete', result);
    } catch (err) {
      logger.error('[Mesh] Startup reconciliation failed', logError(err));
    }

    // Ensure DorkBot system agent exists (non-fatal)
    try {
      await ensureDorkBot(meshCore, dorkHome);
    } catch (err) {
      logger.warn('[Mesh] Failed to ensure DorkBot system agent', logError(err));
    }

    // Tick the Pulse attention badge on a real liveness transition (an agent
    // went offline or came back online) instead of waiting for the 30s
    // mesh-status poll (DOR-403).
    meshCore.onLivenessChange((result) =>
      eventFanOut.broadcast('mesh_liveness_changed', {
        unreachable: result.unreachable,
        resurrected: result.resurrected,
        changedAt: new Date().toISOString(),
      })
    );

    // Start periodic reconciliation (every 5 minutes)
    meshCore.startPeriodicReconciliation(300_000);
  } catch (err) {
    const errInfo = logError(err);
    logger.error('[Mesh] Failed to initialize MeshCore', errInfo);
    setMeshInitError(errInfo.error);
    // Mesh failure is non-fatal: server continues without mesh routes.
  }

  // Phase C: adapter manager — now meshCore is available for CWD resolution.
  // Must run after meshCore init so buildContext() can call meshCore.getProjectPath().
  // Uses runtimeRegistry.getDefault() so this works in both production (ClaudeCodeRuntime)
  // and test mode (TestModeRuntime). Both satisfy AgentRuntimeLike structurally.
  if (relayEnabled && relayCore && adapterRegistry && traceStore) {
    try {
      const adapterConfigPath = path.join(dorkHome, 'relay', 'adapters.json');
      adapterManager = new AdapterManager(adapterRegistry, adapterConfigPath, {
        agentManager: runtimeRegistry.getDefault() as unknown as ClaudeCodeAgentRuntimeLike,
        traceStore,
        taskStore: taskStore,
        relayCore,
        meshCore, // meshCore is now available
        eventRecorder: traceStore,
        activityService,
      });
      await adapterManager.initialize();
      relayCore.setAdapterContextBuilder(adapterManager.buildContext.bind(adapterManager));

      // Provide relay binding context to runtime for <relay_connections> system prompt block
      const bindingRouter = adapterManager.getBindingRouter();
      const bindingStore = adapterManager.getBindingStore();
      if (claudeRuntime && bindingRouter && bindingStore) {
        claudeRuntime.setRelayBindingContext(bindingRouter, bindingStore, adapterManager);
      }

      // Enforce the DOR-239 "agent may start conversations" consent at the relay
      // delivery layer (DOR-277). This is the authoritative gate: every
      // agent-initiated send to a bound human channel — relay_send*, A2A, or any
      // other publish path — is denied unless the binding is enabled and
      // canInitiate. Without a binding store there is no consent to resolve.
      if (bindingStore) {
        relayCore.setInitiateConsentGate(createInitiateConsentGate({ bindingStore }));
      }

      logger.info('[Relay] AdapterManager initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error('[Relay] Failed to initialize AdapterManager', errInfo);
      // Non-fatal: RelayCore and MeshCore remain operational.
      // Adapters (including ClaudeCodeAdapter) will be unavailable.
      adapterManager = undefined;
    }
  }

  // Store-level run-terminal hook (DOR-240): the single seam that fires exactly
  // once per non-terminal → terminal transition, for BOTH scheduler-side
  // failures and relay-delivered runs finalized by the receiver's
  // updateRun('failed'). Two consumers ride it, composed into one listener
  // because setOnRunTerminal holds a single listener:
  //   1. Pulse attention broadcast (DOR-403) — always on when Tasks is enabled;
  //      broadcastRunTerminal fans `task_run_failed` onto /api/events so the
  //      badge ticks the instant a run fails, on every execution path.
  //   2. TaskCompletionNotifier (DOR-240) — optional, only when the relay deps
  //      it needs to deliver a channel notification are present.
  if (taskStore) {
    let notifier: TaskCompletionNotifier | undefined;
    if (relayCore && adapterManager) {
      const bindingStore = adapterManager.getBindingStore();
      const bindingRouter = adapterManager.getBindingRouter();
      if (bindingStore && bindingRouter) {
        notifier = new TaskCompletionNotifier({
          bindingStore,
          bindingRouter,
          adapterManager,
          relayCore,
          taskStore,
          logger,
        });
        logger.info('[Tasks] Completion notifier wired to run-terminal hook');
      }
    }
    taskStore.setOnRunTerminal((run, task) => {
      broadcastRunTerminal(run);
      if (notifier) void notifier.handle(run, task);
    });
  }

  // Subscribe to lifecycle signals for diagnostic logging
  if (meshSignalEmitter && meshCore) {
    meshSignalEmitter.subscribe('mesh.agent.lifecycle.>', (subject, signal) => {
      logger.info(`[mesh] lifecycle: ${signal.state}`, { subject, data: signal.data });
    });
  }

  const app = createApp();

  // Build mcpToolDeps and register factory only when ClaudeCodeRuntime is available.
  let mcpToolDeps: Parameters<typeof createExternalMcpServer>[0] | undefined;
  // Marketplace MCP deps are populated later in the marketplace wiring block
  // (only when extensionManager + adapterManager are available). The factory
  // closure below reads the captured `let` binding lazily on each request, so
  // by the time the first MCP request arrives this is either populated or
  // intentionally undefined (relay disabled).
  let marketplaceMcpDeps: MarketplaceMcpDeps | undefined;
  // Connector registry + the per-account → session tool-server binder, created
  // up front (both need only `db`) so the MCP factory closure can inject a
  // session's attached connector accounts as named MCP tool servers alongside
  // the built-in `dorkos` server (connector-gateway spec §Detailed Design 3).
  // The `/api/connectors` and attach/detach routes are mounted later, once the
  // relay adapter catalog is available.
  const connectorRegistry = new ConnectorRegistry({ db });
  // Register the Composio managed-custody backend ONLY when its API key is
  // configured (resolved through the credential machinery). An install without a
  // Composio key keeps the registry as-is — no `composio` provider, no crash
  // (connector-gateway spec §Detailed Design 1, DOR-371 P5).
  const composioProvider = await maybeCreateComposioProvider({ credentials: credentialProvider });
  if (composioProvider) {
    connectorRegistry.register(composioProvider);
    logger.info('[Connectors] Composio managed backend registered');
  }
  // Register the Nango self-host backend ONLY when it is configured (secret key +
  // base URL). When configured but NANGO_ENCRYPTION_KEY is unset/invalid, the
  // adapter refuses loudly (spec §Detailed Design 4, DOR-371 P7): log the refusal
  // and skip registration so the connector will not run unencrypted while the
  // server still boots.
  try {
    const nangoProvider = await maybeCreateNangoProvider({
      credentials: credentialProvider,
      ...(env.NANGO_BASE_URL !== undefined && { baseUrl: env.NANGO_BASE_URL }),
      ...(env.NANGO_ENCRYPTION_KEY !== undefined && { encryptionKey: env.NANGO_ENCRYPTION_KEY }),
    });
    if (nangoProvider) {
      connectorRegistry.register(nangoProvider);
      logger.info('[Connectors] Nango self-host backend registered');
    }
  } catch (err) {
    if (err instanceof NangoEncryptionKeyError) {
      logger.error(`[Connectors] Nango self-host backend refused: ${err.message}`);
    } else {
      throw err;
    }
  }
  const sessionConnectorService = new SessionConnectorService({ registry: connectorRegistry });
  // A brand-new session is rekeyed to its canonical id mid-first-turn. Move any
  // connector attach set across the same remap so tools attached under the
  // request id are not stranded on the pre-remap id (mirrors the projector +
  // DevTools-store rekeys).
  onProjectorRekey((oldId, newId) => sessionConnectorService.migrateSession(oldId, newId));
  if (claudeRuntime) {
    mcpToolDeps = {
      transcriptReader: claudeRuntime.getTranscriptReader(),
      defaultCwd: env.DORKOS_DEFAULT_CWD ?? process.cwd(),
      runtimeRegistry,
      ...(taskStore && { taskStore }),
      ...(relayCore && { relayCore }),
      ...(adapterManager && { adapterManager }),
      ...(adapterManager && { bindingStore: adapterManager.getBindingStore() }),
      ...(adapterManager && { bindingRouter: adapterManager.getBindingRouter() }),
      ...(traceStore && { traceStore }),
      ...(meshCore && { meshCore }),
    };
    claudeRuntime.setMcpServerFactory((session, sessionId) => ({
      dorkos: createDorkOsToolServer(mcpToolDeps!, session, sessionId),
      // Connected accounts explicitly attached to this session become named MCP
      // tool servers (`gmail-personal`, `gmail-work`). The connection details
      // are provider-neutral; the SDK-shape conversion is confined to the
      // claude-code runtime. Null-branch accounts (expired/revoked) are skipped
      // here and surfaced via the session connector status.
      ...toSdkMcpServers(sessionConnectorService.mcpServersForSession(sessionId).servers),
    }));
  }

  // Always mount /mcp — requireMcpEnabled handles the disabled case with a clean 503.
  const mcpRateLimiter = buildMcpRateLimiter();
  // Auth is resolved per request by createMcpAuth (env override → per-user Better
  // Auth key / session → legacy compat key → per-instance local token, with the
  // read-only carve-out in login-off mode). This is only a startup log hint.
  const mcpAuthMode = env.MCP_API_KEY?.trim()
    ? 'auth: MCP_API_KEY override'
    : configManager.get('auth')?.enabled
      ? 'auth: login gate + per-user keys'
      : 'auth: local token (read-only tools tokenless)';

  app.use(
    '/mcp',
    validateMcpOrigin,
    requireMcpEnabled,
    createMcpAuth({ surface: 'mcp' }),
    mcpRateLimiter,
    createMcpRouter(() => {
      if (!claudeRuntime || !mcpToolDeps) {
        throw new Error(
          'ClaudeCodeRuntime not available — external MCP server cannot handle requests'
        );
      }
      return createExternalMcpServer(mcpToolDeps, marketplaceMcpDeps);
    })
  );
  logger.info(`[MCP] External MCP server mounted at /mcp (stateless, ${mcpAuthMode})`);

  // Scoped Codex UI MCP server — a top-level sibling of /mcp (NOT nested, to
  // avoid app.use('/mcp') shadowing). Exposes ONLY `control_ui` so the Codex
  // runtime can open the canvas (ADR: Codex canvas parity). Deliberately omits
  // requireMcpEnabled (canvas must not depend on the external-MCP feature flag)
  // and the MCP auth middleware (the stub holds no secrets and the loopback URL
  // threads no bearer token). Origin validation + rate limiting still apply.
  app.use(
    '/codex-ui-mcp',
    validateMcpOrigin,
    mcpRateLimiter,
    createMcpRouter(() => createCodexUiMcpServer())
  );
  logger.info('[MCP] Scoped Codex UI MCP server mounted at /codex-ui-mcp (control_ui only)');

  // Mount Tasks routes if enabled. The scheduler's agent manager is
  // ClaudeCodeRuntime in production and the TestModeRuntime in test mode.
  if (tasksEnabled && taskStore && schedulerAgentManager) {
    schedulerService = new TaskSchedulerService({
      store: taskStore,
      agentManager: schedulerAgentManager,
      config: {
        maxConcurrentRuns: schedulerConfig.maxConcurrentRuns,
        retentionCount: schedulerConfig.retentionCount,
        timezone: schedulerConfig.timezone,
        mayFire: firing.mayFire,
        firingReason: firing.reason,
      },
      relay: relayCore,
      meshCore,
      activityService,
      dorkHome,
    });
    app.use(
      '/api/tasks',
      createTasksRouter(taskStore, schedulerService, dorkHome, meshCore, activityService)
    );
    setTasksEnabled(true);
    logger.info('[Tasks] Routes mounted and scheduler configured');

    // Cascade-disable: when an agent is unregistered from Mesh, disable its linked task schedules.
    // The callback receives the project path captured before registry removal —
    // meshCore.getProjectPath(agentId) would already return undefined here.
    if (meshCore) {
      meshCore.onUnregister((agentId, projectPath) => {
        const disabledCount = taskStore.disableTasksByAgentId(agentId);
        if (disabledCount > 0) {
          logger.info(
            `[Tasks] Disabled ${disabledCount} schedule(s) for unregistered agent ${agentId}`
          );
        }
        // Stop watching and reconciling the agent's task directory
        const agentTasksDir = path.join(projectPath, '.dork', 'tasks');
        taskFileWatcher?.stopWatching(agentTasksDir).catch(() => {});
        taskReconciler?.removeDirectory(agentTasksDir);
      });
    }

    // Wire file watcher and reconciler for file-first task sync
    const globalTasksDir = path.join(dorkHome, 'tasks');
    taskFileWatcher = new TaskFileWatcher(taskStore, () => {}, dorkHome);
    taskFileWatcher.watch(globalTasksDir, 'global');

    taskReconciler = new TaskReconciler(taskStore);
    taskReconciler.addDirectory(globalTasksDir, 'global');

    // Watch each registered agent's task directory
    if (meshCore) {
      for (const agent of meshCore.list()) {
        const projectPath = meshCore.getProjectPath(agent.id);
        if (projectPath) {
          const agentTasksDir = path.join(projectPath, '.dork', 'tasks');
          taskFileWatcher.watch(agentTasksDir, 'project', projectPath, agent.id);
          taskReconciler.addDirectory(agentTasksDir, 'project', projectPath, agent.id);
        }
      }
    }

    taskReconciler.start();
    logger.info('[Tasks] File watcher and reconciler started');

    // Ensure default templates exist
    ensureDefaultTemplates(dorkHome).catch((err) => {
      logger.warn('[Tasks] Failed to seed default templates', logError(err));
    });
  }

  // Mount connector routes (connector-gateway spec, DOR-371). The registry
  // starts empty — provider backends (raw-MCP, Composio) register in later
  // phases — but the routing surface is already live: `recommend` reads the
  // relay adapter catalog (relay-adapter-first), and the aggregate endpoints
  // return empty until a provider is registered. `adapterManager` satisfies the
  // routing catalog structurally via its public `getManifest` accessor.
  app.use(
    '/api/connectors',
    createConnectorsRouter({
      registry: connectorRegistry,
      ...(adapterManager && { relay: adapterManager }),
    })
  );
  // The attach/detach consent routes ride under `/api/sessions` (a sibling of
  // the static sessions router; the `/:id/connectors[...]` paths do not collide
  // with its single-segment `/:id` routes). The binder itself was created up
  // front so the MCP factory closure could reference it.
  app.use('/api/sessions', createSessionConnectorsRouter({ service: sessionConnectorService }));
  logger.info('[Connectors] Routes mounted');

  // Mount Relay routes if enabled
  if (relayEnabled && relayCore) {
    app.use('/api/relay', createRelayRouter(relayCore, adapterManager, traceStore));
    setRelayEnabled(true);

    // Store relayCore on app.locals so the sessions router can access it
    app.locals.relayCore = relayCore;

    // Wire relay events to unified SSE stream
    relayCore.subscribe('relay.human.console.>', (envelope) => {
      eventFanOut.broadcast('relay_message', envelope);
    });

    relayCore.onSignal('relay.human.console.>', (_subject, signal) => {
      const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
      eventFanOut.broadcast(eventType, signal);
    });

    eventFanOut.broadcast('relay_connected', {
      pattern: 'relay.human.console.>',
      connectedAt: new Date().toISOString(),
    });

    logger.info('[Relay] Routes mounted');
  }

  // Wire global session-list discovery → unified SSE stream (ADR-0265/0266).
  // ALWAYS ON: fans every registered runtime's transition-only session-list
  // stream (session_upserted/session_removed/session_status) onto /api/events
  // with no timer poll (ADR-0310 fan-in). Started here because all runtimes
  // are registered by this point.
  sessionListBroadcaster.start(runtimeRegistry.listRuntimes());
  logger.info('[SessionList] Discovery broadcaster started');

  // Mount Mesh routes if MeshCore initialized successfully (always-on, ADR-0062)
  // taskStore/relayCore power topology enrichment (relay badges, task counts);
  // when a subsystem is disabled the router degrades to safe defaults.
  if (meshCore) {
    app.use('/api/mesh', createMeshRouter({ meshCore, taskStore, relayCore }));
    // Expose the registry to the (statically-mounted) sessions router so
    // GET /api/sessions/recent can resolve agent project paths (DOR-329).
    app.locals.meshCore = meshCore;
    logger.info('[Mesh] Routes mounted');
  }

  // Session-origin Pulse overlay (session-origin-legibility): expose a narrow
  // batched lookup to the sessions router via app.locals, mirroring the
  // meshCore/relayCore pattern above. Tasks-disabled installs leave this
  // unset, and applyTaskOriginOverlay treats that as a safe no-op — keeps
  // transcript-reader.ts/classify-origin.ts free of any Tasks-subsystem import.
  if (taskStore) {
    app.locals.resolveTaskOrigins = (sessionIds: string[]) =>
      taskStore!.resolveTaskOrigins(sessionIds);
  }

  // Shape schedule service — file-first schedule creator + re-binder the Shape
  // apply flow and the agent-create seam share. Built here (not just inside the
  // marketplace block below) so the agent-create re-bind works even when the
  // extension manager is off. Degrades to a no-op stub when Tasks is disabled.
  const shapeScheduleService: ShapeScheduleServiceLike =
    taskStore && schedulerService
      ? new ShapeScheduleService({
          taskStore,
          scheduler: schedulerService,
          meshCore,
          dorkHome,
          logger,
        })
      : {
          listSchedules: () => [],
          createSchedule: async () => undefined,
          rebindSchedule: async () => undefined,
          deleteSchedulesForShape: async () => [],
        };

  // The agent-created seam (module-level, registered once at bootstrap): every
  // creation path — HTTP routes, MCP create_agent, marketplace agent install —
  // notifies it via `createAgentWorkspace` / the register route. Reaction: when
  // a new agent is created/registered, re-target any Shape schedule that was
  // created global/disabled because this agent was missing (spec item 3). The
  // 15-minute Linear tick turns on the moment "Linear Keeper" is created — no
  // re-apply. The notify is awaited (so creation responses reflect the settled
  // re-bind) but failures are swallowed at the seam; creation never fails
  // because this reaction threw. A schedule silently starting to run is
  // consequential, so a successful re-bind also lands in the activity feed.
  setOnAgentCreated(async (agent: RebindAgent) => {
    const rebound = await rebindShapeSchedulesForAgent(agent, {
      listShapes: () => listInstalledShapeManifests(dorkHome),
      scheduleService: shapeScheduleService,
    });
    if (rebound.length === 0) return;
    logger.info(`[Shapes] Re-bound ${rebound.length} schedule(s) to new agent '${agent.name}'`, {
      schedules: rebound,
    });
    const agentLabel = agent.displayName ?? agent.name;
    await activityService.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'tasks',
      eventType: 'tasks.schedules_rebound',
      resourceType: 'agent',
      resourceId: agent.id,
      resourceLabel: agentLabel,
      summary:
        rebound.length === 1
          ? `Turned on a scheduled task for ${agentLabel}`
          : `Turned on ${rebound.length} scheduled tasks for ${agentLabel}`,
      linkPath: '/tasks',
      metadata: { schedules: rebound },
    });
  });

  // Always mounted — not behind any feature flag.
  // ADR-0043: pass meshCore (when available) so writes sync to Mesh DB cache.
  app.use('/api/agents', createAgentsRouter(meshCore));

  // Template catalog — always available, merges built-in + user templates.
  app.use('/api/templates', createTemplateRouter(dorkHome));

  // Activity feed — always available, not behind a feature flag.
  app.use('/api/activity', createActivityRouter(activityService));
  app.locals.activityService = activityService;
  logger.info('[Activity] Routes mounted');

  // Mount Extensions routes if extension system initialized successfully.
  if (extensionManager) {
    app.use(
      '/api/extensions',
      createExtensionsRouter(extensionManager, dorkHome, () => env.DORKOS_DEFAULT_CWD ?? null)
    );

    // Delegate /api/ext/:id/* to extension-registered Express routers
    app.use('/api/ext/:id', createExtensionRoutesMiddleware(extensionManager));

    logger.info('[Extensions] Routes mounted');
  }

  // Mount Discovery routes when MeshCore is available (delegates to meshCore.discover())
  if (meshCore) {
    app.use('/api/discovery', createDiscoveryRouter(meshCore));
    logger.info('[Discovery] Routes mounted');
  }

  // Mount A2A gateway if enabled — requires both Relay (message routing) and Mesh (agent registry)
  if (env.DORKOS_A2A_ENABLED && relayCore && meshCore) {
    // The A2A surface is guarded by createMcpAuth({ surface: 'a2a' }). In
    // login-off mode the per-instance local token gates JSON-RPC execution, but
    // that token is a loopback-trust mechanism (a 0600 file only a local operator
    // can read) — it does not make the surface safe on a non-loopback bind. So the
    // exposure guard still keys off a network-reachable credential (an env key,
    // the legacy compat key, or login) to decide whether A2A may mount off loopback.
    const authConfigured =
      !!env.MCP_API_KEY?.trim() ||
      !!configManager.get('mcp')?.apiKey ||
      configManager.get('auth')?.enabled === true;

    // Exposure guard: refuse to mount the external A2A surface (JSON-RPC plus
    // the agent-card discovery endpoints) on a non-loopback host when nothing
    // gates it — otherwise remote prompt execution against every agent would be
    // open to the network. Unlike the bind check this is not a hard exit: the
    // loopback cockpit stays usable; only the A2A surface is withheld.
    const a2aExposure = checkA2aExposure({
      host: env.DORKOS_HOST,
      authConfigured,
      allowInsecureBind: env.DORKOS_ALLOW_INSECURE_BIND,
    });
    if (!a2aExposure.allowed) {
      logger.error(`[A2A] ${a2aExposure.reason}`);
      // Also to stderr so an operator starting from a terminal sees why the
      // surface they enabled did not come up.
      console.error(`\n${a2aExposure.reason}\n`);
    } else {
      if (a2aExposure.warning) logger.warn(`[A2A] ${a2aExposure.warning}`);

      // Advertised card URL: prefer the explicit public URL — behind a proxy or
      // tunnel the {host}:{port} bind is non-routable (e.g. http://0.0.0.0:PORT).
      // Trailing slashes are stripped so `${baseUrl}/a2a` stays clean.
      const baseUrl = (env.DORKOS_PUBLIC_URL ?? `http://${env.DORKOS_HOST}:${PORT}`).replace(
        /\/+$/,
        ''
      );
      const version = env.DORKOS_VERSION_OVERRIDE ?? '0.0.0';
      const { rpc: rpcRateLimiter, card: cardRateLimiter } = buildA2aRateLimiters({
        rpcMaxPerMinute: env.DORKOS_A2A_RPC_RATE_LIMIT,
        cardMaxPerMinute: env.DORKOS_A2A_CARD_RATE_LIMIT,
      });

      const { router: a2aRouter, fleetCardHandler } = createA2aRouter({
        meshCore,
        relay: relayCore,
        db,
        baseUrl,
        version,
        authRequired: authConfigured,
        rpcRateLimiter,
        cardRateLimiter,
      });

      // Fleet Agent Card at the spec well-known path (AGENT_CARD_PATH in the
      // A2A SDK — standard clients discover the card here). The legacy
      // /.well-known/agent.json path is kept during the transition. Cards get
      // the lighter discovery limiter, applied before auth so unauthenticated
      // scraping is throttled too.
      const a2aAuth = createMcpAuth({ surface: 'a2a' });
      app.get('/.well-known/agent-card.json', cardRateLimiter, a2aAuth, fleetCardHandler);
      app.get('/.well-known/agent.json', cardRateLimiter, a2aAuth, fleetCardHandler);

      // Per-agent cards and JSON-RPC under /a2a (per-route limiters live in the router)
      app.use('/a2a', a2aAuth, a2aRouter);

      const a2aAuthMode = authConfigured ? 'auth: required' : 'auth: none (loopback)';
      logger.info(
        `[A2A] Gateway mounted (fleet card: /.well-known/agent-card.json, RPC: POST /a2a, ${a2aAuthMode})`
      );
    }
  }

  // Mount Admin routes (reset, restart)
  app.use(
    '/api/admin',
    createAdminRouter({
      dorkHome,
      shutdownServices,
      closeDb: () => db.$client.close(),
    })
  );
  logger.info('[Admin] Routes mounted');

  // Mount Marketplace routes. The install pipeline has two optional
  // collaborators — `extensionManager` (needed by plugin + uninstall flows)
  // and `adapterManager` (needed by adapter + uninstall flows). When either
  // is absent the corresponding flows will surface a clear error on call,
  // but source listing, cache, discovery, agent installs, and skill-pack
  // installs remain fully functional, so we always mount the router rather
  // than gating the entire namespace.
  if (extensionManager && adapterManager) {
    const marketplaceSourceManager = new MarketplaceSourceManager(dorkHome);
    const marketplaceCache = new MarketplaceCache(dorkHome);
    const marketplaceFetcher = new PackageFetcher(
      marketplaceCache,
      defaultTemplateDownloader,
      logger
    );
    const marketplaceResolver = new PackageResolver(marketplaceSourceManager, marketplaceCache);
    const marketplaceConflictDetector = new ConflictDetector(dorkHome, adapterManager);
    const marketplacePreviewBuilder = new PermissionPreviewBuilder(
      dorkHome,
      marketplaceConflictDetector
    );

    const marketplacePluginFlow = new PluginInstallFlow({
      dorkHome,
      extensionCompiler: extensionManager.getCompiler(),
      extensionManager,
      logger,
    });
    const marketplaceAgentFlow = new AgentInstallFlow({
      dorkHome,
      agentCreator: { createAgentWorkspace },
      logger,
    });
    const marketplaceSkillPackFlow = new SkillPackInstallFlow({ dorkHome, logger });
    const marketplaceAdapterFlow = new AdapterInstallFlow({
      dorkHome,
      adapterManager,
      logger,
    });
    const marketplaceShapeFlow = new ShapeInstallFlow({
      dorkHome,
      extensionCompiler: extensionManager.getCompiler(),
      logger,
    });
    const marketplaceUninstallFlow = new UninstallFlow({
      dorkHome,
      extensionManager,
      adapterManager,
      // Keep `ui.shapes.active` honest when the active Shape is uninstalled.
      shapeDeactivator: { getActiveShapeName, clearActiveShape },
      // Delete the schedules a removed Shape created so its tick stops firing.
      shapeScheduleTeardown: shapeScheduleService,
      logger,
    });

    // Shape apply wiring (DOR-355) — constructed here, before the installer,
    // because the installer's update() path re-applies the active Shape after
    // an uninstall → reinstall replace. The `/api/shapes` routes mounted below
    // share these exact deps; `shapeScheduleService` is the hoisted instance
    // the agent-create re-bind seam also uses (built above the agents router).
    const shapeApplyDeps: ApplyShapeDeps = {
      manifestResolver: createFsShapeManifestResolver(dorkHome),
      extensionManager,
      secretChecker: createShapeSecretChecker(dorkHome),
      agentRegistry: { listWithPaths: () => meshCore?.listWithPaths() ?? [] },
      scheduleService: shapeScheduleService,
      configStore: createShapeConfigStore(),
    };

    const marketplaceInstaller = new MarketplaceInstaller({
      dorkHome,
      resolver: marketplaceResolver,
      fetcher: marketplaceFetcher,
      previewBuilder: marketplacePreviewBuilder,
      pluginFlow: marketplacePluginFlow,
      agentFlow: marketplaceAgentFlow,
      skillPackFlow: marketplaceSkillPackFlow,
      adapterFlow: marketplaceAdapterFlow,
      shapeFlow: marketplaceShapeFlow,
      uninstallFlow: marketplaceUninstallFlow,
      // Updating the active Shape keeps its pointer through the replace and
      // re-applies the new version so the cockpit reflects the update.
      shapeUpdateHooks: {
        getActiveShapeName,
        reapplyShape: (name) => applyShape(name, shapeApplyDeps),
      },
      logger,
    });

    // UpdateFlow takes an `InstallerLike` — passing the concrete installer
    // is safe because `MarketplaceInstaller implements InstallerLike` and
    // breaks the type cycle between installer and update flow at the type
    // level (see `marketplace-installer.ts`).
    const marketplaceUpdateFlow = new UpdateFlow({
      dorkHome,
      installer: marketplaceInstaller,
      sourceManager: marketplaceSourceManager,
      fetcher: marketplaceFetcher,
      logger,
    });

    // Cross-scope installed listing walks every registered agent's
    // .dork/plugins. Resolved lazily per call so agents registered after
    // startup are included; display name preferred for the UI. Shared by the
    // HTTP router and the `marketplace_list_installed` MCP tool so both report
    // the same one-entry-per-installation truth.
    const listAgentScopes = () =>
      (meshCore?.listWithPaths() ?? []).map((a) => ({
        projectPath: a.projectPath,
        id: a.id,
        name: a.displayName ?? a.name,
      }));

    app.use(
      '/api/marketplace',
      createMarketplaceRouter({
        sourceManager: marketplaceSourceManager,
        cache: marketplaceCache,
        fetcher: marketplaceFetcher,
        installer: marketplaceInstaller,
        uninstallFlow: marketplaceUninstallFlow,
        updateFlow: marketplaceUpdateFlow,
        dorkHome,
        listAgentScopes,
        onPluginsChanged: (ctx) => {
          // Pass the project path (when the change was project-scoped) so the
          // runtime drops that cwd's cached command list and re-warms it with
          // the merged per-cwd plugin set.
          claudeRuntime?.refreshActivatedPlugins(ctx.projectPath).catch((err) => {
            logger.warn('[Marketplace] Post-install plugin refresh failed', { err });
          });
          // Harness Sync auto-projection (GAP-4): project the changed plugin's
          // assets to the project's other harnesses. Fire-and-forget; the
          // service is internally best-effort and never throws, but we still
          // catch here to honor the no-floating-promise convention.
          runAutoProjection(ctx, { dorkHome }).catch((err) => {
            logger.warn('[Marketplace] Harness auto-projection failed', { err });
          });
        },
      })
    );
    logger.info('[Marketplace] Routes mounted');

    // Mount Shape routes (DOR-355). Apply/fork ride the marketplace block
    // because apply enables extensions (needs `extensionManager`). Schedules
    // degrade to a no-op when the scheduler is off; extensions, chrome, and
    // agent offers still apply. (`shapeApplyDeps` is constructed above the
    // installer so the update path can re-apply the active Shape.)
    app.use(
      '/api/shapes',
      createShapesRouter({
        dorkHome,
        applyDeps: shapeApplyDeps,
        forkDeps: {
          dorkHome,
          logger,
          getEnabledExtensions: getEnabledExtensionIds,
          getActiveShape: getActiveShapeName,
        },
      })
    );
    logger.info('[Shapes] Routes mounted');

    // Personal marketplace bootstrap — runs after the source manager is wired
    // but before the MCP server fields its first request so the personal
    // source is registered when external clients call
    // `marketplace_list_marketplaces`. Failure here is non-fatal: a missing
    // personal marketplace just means the `marketplace_create_package` tool
    // has no destination, every other tool keeps working.
    try {
      await ensurePersonalMarketplace({
        dorkHome,
        sourceManager: marketplaceSourceManager,
        logger,
      });
    } catch (err) {
      logger.warn('[personal-marketplace] bootstrap failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Build the confirmation provider that gates marketplace mutation tools.
    // `MARKETPLACE_AUTO_APPROVE=1` selects the auto-approve provider for CI
    // and tests; everything else uses the token provider, which issues
    // out-of-band tokens that the DorkOS UI resolves via the
    // `POST /api/marketplace/confirmations/:token` route.
    const confirmationProvider: ConfirmationProvider =
      env.MARKETPLACE_AUTO_APPROVE === '1'
        ? new AutoApproveConfirmationProvider()
        : new TokenConfirmationProvider();
    setMarketplaceConfirmationProvider(confirmationProvider);

    marketplaceMcpDeps = {
      dorkHome,
      installer: marketplaceInstaller,
      sourceManager: marketplaceSourceManager,
      fetcher: marketplaceFetcher,
      cache: marketplaceCache,
      uninstallFlow: marketplaceUninstallFlow,
      confirmationProvider,
      listAgentScopes,
      logger,
    };
    logger.info('[Marketplace] MCP tools wired into external /mcp server');
  } else {
    logger.warn(
      '[Marketplace] Routes skipped — requires extensionManager and adapterManager (relay must be enabled and extensions must have initialized successfully)'
    );
  }

  // Embedded terminal (spec right-panel-workbench, Chunk E). Always mounted:
  // PTYs are boundary-confined to the requested cwd, and a terminal id is an
  // unguessable UUID minted only through this auth-gated POST — the WebSocket
  // (attached after listen) authenticates by bearer-of-id.
  // The detached-PTY grace window is operator-configurable (DOR-225): a longer
  // TTL keeps a shell reattachable across a slow reload; a shorter one reclaims
  // idle PTYs faster. Minutes in config → milliseconds for the manager.
  const terminalGraceTtlMinutes = configManager.get('workbench').terminalGraceTtlMinutes;
  terminalManager = new TerminalManager({
    boundary: resolvedBoundary,
    idleTimeoutMs: terminalGraceTtlMinutes * 60_000,
  });
  app.use('/api/terminal', createTerminalRouter(terminalManager));
  logger.info('[Terminal] Routes mounted');

  // Finalize app: API 404 catch-all, error handler, and SPA serving
  finalizeApp(app);

  // Inject relay into the active runtime (a no-op for both runtimes today;
  // the method survives on the interface for future relay-aware runtimes).
  if (relayCore) {
    runtimeRegistry.getDefault().setRelay?.(relayCore);
  }

  const host = env.DORKOS_HOST;

  // Exposure guard (task 1.3): refuse to bind a non-loopback (publicly
  // reachable) interface unless login is enabled AND an owner account exists.
  // A hard gate — binding beyond localhost without credentials would expose the
  // instance. Container images that own their network boundary opt out with
  // DORKOS_ALLOW_INSECURE_BIND=true (see the Dockerfile integration/runtime targets).
  const bindCheck = checkBindAllowed({
    host,
    exposureAllowed: canExpose(),
    allowInsecureBind: env.DORKOS_ALLOW_INSECURE_BIND,
  });
  if (!bindCheck.allowed) {
    logger.error(`[Auth] ${bindCheck.reason}`);
    // Also to stderr: an operator starting from a terminal must see this even
    // when the logger only writes to the log file.
    console.error(`\n${bindCheck.reason}\n`);
    process.exit(1);
  }
  if (bindCheck.warning) {
    logger.warn(`[Auth] ${bindCheck.warning}`);
  }

  const server = app.listen(PORT, host, () => {
    logger.info(`DorkOS server running on http://${host}:${PORT}`);

    // Attach the embedded-terminal WebSocket byte channel once the server is
    // listening (it is the sole HTTP upgrade consumer).
    attachTerminalWebSocket(server, terminalManager!);
    logger.info('[Terminal] WebSocket byte channel attached');

    // Fire-and-forget: record startup in the activity feed so the dashboard
    // shows when the server was last (re)started.
    activityService.emit({
      actorType: 'system',
      actorLabel: 'System',
      category: 'system',
      eventType: 'system.started',
      summary: 'DorkOS started',
    });

    // Register the anonymous daily heartbeat (Tier 1 opt-out; ADR 260713-143958).
    // `config.telemetry.heartbeat` defaults ON, but the send folds in the env
    // kill switch AND the `tier1SendGate` captured at boot (BEFORE the first-run
    // notice wrote `lastPromptedVersion`), so a first-notice boot sends nothing.
    // Payload documented at https://dorkos.ai/telemetry (DOR-293).
    const runtimesConfig = configManager.get('runtimes');
    const runtimesConfigured = [
      'claude-code',
      ...(runtimesConfig.codex.enabled ? ['codex'] : []),
      ...(runtimesConfig.opencode.enabled ? ['opencode'] : []),
    ];
    registerHeartbeat({
      consent:
        resolveTelemetryConsent(telemetryConfig?.heartbeat ?? false, telemetryEnv) && tier1SendGate,
      debug: telemetryDebug,
      dorkHome,
      dorkosVersion: SERVER_VERSION,
      runtimesConfigured,
      tunnelEnabled: configManager.get('tunnel')?.enabled ?? false,
      cloudLinked: configManager.get('cloud')?.instanceToken != null,
      collectCounts: (): HeartbeatCounts => {
        // Best-effort snapshot; any failure just contributes a zero.
        let agentCount = 0;
        try {
          agentCount = db.select().from(agents).all().length;
        } catch {
          /* ignore */
        }
        return {
          agents: agentCount,
          tasks: taskStore?.getTasks().length ?? 0,
          relayAdapters: adapterManager?.listAdapters().length ?? 0,
        };
      },
    });
  });

  // Surface port conflicts with an actionable message instead of a raw EADDRINUSE stack trace
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Port ${PORT} is already in use. ` +
          `Run \`lsof -i :${PORT}\` to find the process, or start with \`--port ${PORT + 1}\`.`
      );
      process.exit(1);
    }
    throw err;
  });

  // Start Tasks scheduler after server is listening
  if (schedulerService) {
    await schedulerService.start();
    logger.info('[Tasks] Scheduler started');
  }

  // Run session health check periodically — only ClaudeCodeRuntime needs this.
  if (claudeRuntime) {
    healthCheckInterval = setInterval(() => {
      claudeRuntime!.checkSessionHealth();
    }, INTERVALS.HEALTH_CHECK_MS);
  }

  // Start ngrok tunnel if enabled. The exposure guard (task 1.3) also gates the
  // boot-time autostart: skip (and log) rather than expose without a login.
  if (env.TUNNEL_ENABLED) {
    if (!canExpose()) {
      logger.warn(
        '[Tunnel] Autostart skipped — exposing DorkOS requires a login. Enable login and ' +
          'create an owner account first (AUTH_REQUIRED_FOR_EXPOSURE).'
      );
    } else {
      const tunnelPort = env.TUNNEL_PORT ?? PORT;

      try {
        const url = await tunnelManager.start({
          port: tunnelPort,
          authtoken: env.NGROK_AUTHTOKEN,
          basicAuth: env.TUNNEL_AUTH,
          domain: env.TUNNEL_DOMAIN,
        });

        const hasAuth = !!env.TUNNEL_AUTH;
        const isDevPort = tunnelPort !== PORT;

        logger.info('[Tunnel] ngrok tunnel active', {
          url,
          port: tunnelPort,
          auth: hasAuth ? 'basic auth enabled' : 'none (open)',
          ...(isDevPort && { mode: `dev (Vite on :${tunnelPort})` }),
        });
      } catch (err) {
        logger.warn(
          '[Tunnel] Failed to start ngrok tunnel — server continues without tunnel.',
          logError(err)
        );
      }
    }
  }

  // Wire tunnel status changes to unified SSE stream
  tunnelManager.on('status_change', (status) => {
    eventFanOut.broadcast('tunnel_status', status);
  });

  // Cloud link (accounts-and-auth P2): if this instance is device-linked to a
  // DorkOS account, heartbeat now and every 15 minutes. Non-blocking and
  // best-effort — independent of local login (config.auth.enabled). A 401 marks
  // the instance unlinked and clears the local token (never retry-loops).
  getCloudLinkManager()
    .initOnStartup()
    .catch((err) => {
      logger.warn('[CloudLink] Startup heartbeat failed', logError(err));
    });
}

// Ordered teardown of all running services WITHOUT calling process.exit().
// Extracted so the admin router can invoke it before a restart.
async function shutdownServices() {
  logger.info('Shutting down services...');
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  // Kill any live PTYs so shutdown never leaves an orphaned shell.
  terminalManager?.destroyAll();
  // Flush any buffered usage events so a clean exit doesn't drop the tail of the
  // queue. No-op when the usage reporter never registered (consent off).
  await shutdownUsageReporter();
  // Same for the opt-in AI-metadata bridge. No-op when it never registered.
  await shutdownAiMetadataReporter();
  // Close the global session-list subscription (and its directory watcher).
  await sessionListBroadcaster.stop();
  if (schedulerService) {
    await schedulerService.stop();
  }
  // Stop adapters before RelayCore — adapters may need to drain in-flight messages
  if (adapterManager) {
    await adapterManager.shutdown();
  }
  if (relayCore) {
    await relayCore.close();
  }
  // Close trace store after RelayCore — ensures final spans are flushed
  if (traceStore) {
    traceStore.close();
  }
  if (taskFileWatcher) {
    await taskFileWatcher.stopAll();
  }
  if (taskReconciler) {
    taskReconciler.stop();
  }
  if (meshCore) {
    meshCore.stopPeriodicReconciliation();
    meshCore.close();
  }
  // Kill the managed OpenCode sidecar (SIGTERM, then SIGKILL after a grace
  // window) so shutdown never leaves an orphan. No-op when it never booted.
  await openCodeServerManager.shutdown();
  await tunnelManager.stop();
  getCloudLinkManager().stop();
  // Flush and tear down debug tracing last so late spans are written. No-op
  // when tracing is off.
  await shutdownObservability();
}

// Graceful shutdown — guarded against concurrent signals (SIGINT + SIGTERM)
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');
  await shutdownServices();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Safety nets — log and exit gracefully on truly unhandled errors instead of
// silently crashing. These should never fire if route-level error handling is
// correct, but they prevent data loss if something slips through.
process.on('uncaughtException', (err) => {
  logger.error('[DorkOS] Uncaught exception — shutting down', {
    message: err.message,
    stack: err.stack,
    name: err.name,
  });
  // Fatal path: bounded-await the crash report so it actually reaches the
  // network before we exit (a bare fire-and-forget would be dropped when the
  // event loop stops on the next line). The timeout guards against a hung
  // endpoint delaying shutdown.
  void flushServerError(err).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logger.error('[DorkOS] Unhandled promise rejection', {
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
  });
  // Non-fatal (we don't exit), so fire-and-forget is fine here.
  void captureServerError(reason);
});

start().catch((err) => {
  const info = logError(err);
  logger.error('[DorkOS] Fatal error during startup', info);

  process.exit(1);
});
