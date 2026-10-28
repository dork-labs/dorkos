/**
 * Marketplace install recovery, the directory boundary, every telemetry
 * channel, the extension system and the agent runtimes, in that order.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/telemetry-extensions-runtimes
 */
import { currentRecordOwner } from '../../services/marketplace/lib/records/record-owner.js';
import {
  recoverInterruptedInstalls,
  globalSweepDirs,
} from '../../services/marketplace/recovery/backup-janitor.js';
import { logger, logError } from '../../lib/logger.js';
import { scanInstallationsAcrossScopes } from '../../services/marketplace/installed-scanner.js';
import { migrateSavedCopies } from '../../services/marketplace/lib/saved-copies/migrate-saved-copies.js';
import { withInstallTargetLock } from '../../services/marketplace/transaction.js';
import { globalApprovalCarryOver } from '../../services/marketplace/lib/saved-copies/saved-copies-consent.js';
import { env } from '../../env.js';
import { initBoundary } from '../../lib/boundary.js';
import { isTelemetryDebugEnabled, resolveTelemetryConsent } from '@dorkos/shared/telemetry-consent';
import { configManager } from '../../services/core/config-manager.js';
import {
  decideTier1Boot,
  formatFirstRunTelemetryNotice,
} from '../../services/core/telemetry-first-run.js';
import { SERVER_VERSION } from '../../lib/version.js';
import { registerDorkosCommunityTelemetry } from '../../services/marketplace/telemetry/telemetry-reporter.js';
import { logConfigWrite } from '../../services/core/operator/config-write.js';
import { registerUsageReporter } from '../../services/core/usage-reporter.js';
import { startInstallFunnel } from '../../services/core/telemetry/install-funnel.js';
import { registerServerErrorReporting } from '../../services/core/error-reporter.js';
import { registerAiMetadataReporter } from '../../services/core/ai-metadata-reporter.js';
import type { CoreExtensionInfo } from '../../services/extensions/extension-enable-resolution.js';
import { ensureCoreExtensions } from '../../services/core-extensions/ensure-core-extensions.js';
import { warnRedundantEnabledEntries } from '../../services/core-extensions/warn-redundant-enabled.js';
import { startExtensions } from '../extensions.js';
import { registerRuntimes } from '../runtimes.js';
import { getAgentSendService } from '../../services/extensions/agent-send/agent-send.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { ServerRefs } from '../server-refs.js';
import type { installSweepLogger } from '../../services/marketplace/recovery/install-sweep-log.js';

/** What {@link startTelemetryExtensionsAndRuntimes} reads from the startup steps before it. */
export interface StartTelemetryExtensionsAndRuntimesInput {
  logInstallSweep: ReturnType<typeof installSweepLogger>;
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  db: OpenConfigAndDatabaseResult['db'];
}

/**
 * Recover installs, set the boundary, register telemetry, then start extensions and runtimes.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function startTelemetryExtensionsAndRuntimes(
  refs: ServerRefs,
  built: StartTelemetryExtensionsAndRuntimesInput
) {
  const { logInstallSweep, dorkHome, db } = built;
  // Settle marketplace installs a crash interrupted (DOR-2273): restore the
  // previous version of a package whose reinstall never finished, remove a
  // half-written fresh install, and delete leftovers of finished ones. Runs
  // before the app serves anything, so nothing lists a half-written package.
  // Project installs are swept once Mesh knows the projects (below); see
  // services/marketplace/recovery/install-recovery.ts for the rules.
  try {
    // Read this process's own start time now, as close to its real start as
    // possible: records it writes carry it, and a wall-clock step between
    // start and a late first read would misstate it (record-owner.ts).
    currentRecordOwner();
    logInstallSweep(
      'global installs',
      await recoverInterruptedInstalls(globalSweepDirs(dorkHome), logger)
    );
  } catch (err) {
    logger.warn('[Marketplace] Startup install recovery failed', logError(err));
  }
  // Copies an earlier version saved aside in a global install stop running
  // and loading (DOR-2340), before anything loads the global packages. Once
  // per install (a marker), and an approved package stays approved.
  try {
    const globalInstalls = await scanInstallationsAcrossScopes(dorkHome, []);
    await migrateSavedCopies(
      globalInstalls.map((i) => i.installPath),
      withInstallTargetLock,
      logger,
      globalApprovalCarryOver(dorkHome)
    );
  } catch (err) {
    logger.warn('[Marketplace] Could not check saved copies in global installs', logError(err));
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

  // Anonymous telemetry (ADR 260713-143958, posture revised by 260727-182651).
  // The heartbeat, install, and feature-usage channels default OFF; on top of
  // that the Homebrew ordering rule requires a first-run notice before anything
  // sends, so the gate below is a second lock, not the only one.
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
  // `config.telemetry.install` is on (default false), no env kill switch is set,
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
    logConfigWrite(
      'the first-run telemetry notice',
      'telemetry',
      current,
      configManager.get('telemetry')
    );
  }

  // Register the anonymous feature-usage reporter (DOR-315, ADR 260713-143958
  // Phase 3). `telemetry.usage` defaults OFF, and sends only when no env
  // kill switch is set (`resolveTelemetryConsent`) AND the CAPTURED pre-notice
  // `tier1SendGate` above is open — the same snapshotted gate the install and
  // heartbeat senders use, never re-read after the notice writes
  // `lastPromptedVersion`, so a never-prompted install sends nothing this boot.
  // No-op (no timer, no network) unless all three hold. Curated events flow
  // through the owned ingest at https://dorkos.ai/api/telemetry/events.
  // `?? false`, matching the install and heartbeat gates above and below. A
  // config block that is present but missing this key is not a person saying
  // yes to it, and absence is never read as consent.
  // `isConsentLive` re-reads the setting on every send, so turning usage off
  // mid-run stops the reporter at once (DOR-2862).
  const usageOn = () =>
    resolveTelemetryConsent(configManager.get('telemetry')?.usage ?? false, telemetryEnv);
  const usageConsent = usageOn() && tier1SendGate;
  registerUsageReporter({
    enabled: usageConsent,
    isConsentLive: usageOn,
    debug: telemetryDebug,
    dorkHome,
    dorkosVersion: SERVER_VERSION,
  });
  if (usageConsent) {
    // `app_started` now, `first_run_completed` once per install (with the
    // dorkos.ai install ref, if any) and `instance_active` once a day (DOR-2862).
    startInstallFunnel({ dorkHome, config: configManager });
    logger.info('[Telemetry] Usage reporter active (consent: opt-in, notice-gated)');
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
  refs.extensionManager = await startExtensions(
    dorkHome,
    coreExtensions,
    env.DORKOS_DEFAULT_CWD ?? null,
    // Agents' own folders hold the mini apps they made (DOR-3068).
    () => refs.meshCore?.listWithPaths().map((agent) => agent.projectPath) ?? []
  );

  // --- Register runtime: TestModeRuntime in test mode, ClaudeCodeRuntime otherwise ---
  ({
    claudeRuntime: refs.claudeRuntime,
    doeRuntime: refs.doeRuntime,
    relayAgentRuntime: refs.relayAgentRuntime,
    creditsRelay: refs.creditsRelay,
  } = await registerRuntimes({
    db,
    dorkHome,
    currentCreditsRelay: () => refs.creditsRelay,
  }));

  // Every runtime is registered, so the messages extensions sent before a
  // restart can be settled and re-armed, and held ones retried.
  await getAgentSendService()
    ?.start()
    .catch((err: unknown) =>
      logger.warn('[DorkOS] could not resume extension messages', { err: String(err) })
    );
  return { resolvedBoundary, telemetryEnv, telemetryDebug, telemetryConfig, tier1SendGate };
}

/** What {@link startTelemetryExtensionsAndRuntimes} hands the steps after it. */
export type StartTelemetryExtensionsAndRuntimesResult = Awaited<
  ReturnType<typeof startTelemetryExtensionsAndRuntimes>
>;
