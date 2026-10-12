import { env } from '../env.js';
import { configManager } from '../services/core/config-manager.js';
import { logger } from '../lib/logger.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { isTelemetryDebugEnabled, resolveTelemetryConsent } from '@dorkos/shared/telemetry-consent';
import {
  decideTier1Boot,
  formatFirstRunTelemetryNotice,
} from '../services/core/telemetry-first-run.js';
import { registerDorkosCommunityTelemetry } from '../services/marketplace/telemetry/telemetry-reporter.js';
import { registerUsageReporter, reportUsageEvent } from '../services/core/usage-reporter.js';
import { registerServerErrorReporting } from '../services/core/error-reporter.js';
import { registerAiMetadataReporter } from '../services/core/ai-metadata-reporter.js';
import { registerHeartbeat } from '../services/core/heartbeat-reporter.js';
import { agents } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import type { HeartbeatCounts } from '../services/core/heartbeat-reporter.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';

/** Capture the one pre-notice consent gate before registering the original telemetry senders. */
export function wireStartupTelemetry(dorkHome: string, version: string) {
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
  const tier1Boot = decideTier1Boot(telemetryConfig, version);
  const tier1SendGate = tier1Boot.sendGate;

  // Register the dorkos.ai marketplace install reporter. No-op unless
  // `config.telemetry.install` is on (default false), no env kill switch is set,
  // AND the Tier 1 notice gate is open. The reporter forwards `InstallEvent`s
  // emitted by the marketplace install pipeline to
  // https://dorkos.ai/api/telemetry/install with a stable per-machine install ID
  // stored in dorkHome. Privacy contract: https://dorkos.ai/marketplace/privacy
  const installConsent =
    resolveTelemetryConsent(telemetryConfig?.install ?? false, telemetryEnv) && tier1SendGate;
  registerDorkosCommunityTelemetry(installConsent, dorkHome, version, telemetryDebug);
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
  const usageConsent =
    resolveTelemetryConsent(telemetryConfig?.usage ?? false, telemetryEnv) && tier1SendGate;
  registerUsageReporter({
    enabled: usageConsent,
    debug: telemetryDebug,
    dorkHome,
    dorkosVersion: version,
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
    version: version,
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
    dorkosVersion: version,
  });

  return { telemetryEnv, telemetryDebug, telemetryConfig, tier1SendGate };
}

/** Register the listening-time heartbeat using the original boot's captured consent gate. */
export function wireStartupHeartbeat(
  {
    telemetryEnv,
    telemetryDebug,
    telemetryConfig,
    tier1SendGate,
  }: ReturnType<typeof wireStartupTelemetry>,
  dorkHome: string,
  version: string,
  db: Db,
  readTaskStore: () => TaskStore | undefined,
  readAdapterManager: () => AdapterManager | undefined
) {
  // Register the anonymous daily heartbeat (Tier 1 opt-out; ADR 260713-143958).
  // `config.telemetry.heartbeat` defaults OFF, and the send folds in the env
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
    dorkosVersion: version,
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
        tasks: readTaskStore()?.getTasks().length ?? 0,
        relayAdapters: readAdapterManager()?.listAdapters().length ?? 0,
      };
    },
  });
}
