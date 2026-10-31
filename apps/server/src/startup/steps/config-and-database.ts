/**
 * Settings and the database: load the config, wire the account usage store and
 * keep-awake, start observability, and open the database with its pre-migration
 * snapshot. The migrations themselves run in `index.ts`, right after this.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/config-and-database
 */
import {
  initConfigManager,
  ConfigBootError,
  configManager,
} from '../../services/core/config-manager.js';
import { accountSigninPolicy } from '../../services/health/account-signin-policy.js';
import { readAccountLoginMetadata } from '../../services/runtimes/claude-code/accounts/account-login-metadata.js';
import { signinAccounts } from '../../services/runtimes/connect/signin-accounts.js';
import { logger, initLogger } from '../../lib/logger.js';
import { warnMalformedAccountRules } from '../../services/core/usage/account-eligibility.js';
import { initCredentialProvider } from '../../services/core/credential-provider.js';
import { initClaudeAccountApplier } from '../../services/core/operator/config-patch.js';
import { applyClaudeAccountChange } from '../../services/runtimes/claude-code/account-switch.js';
import { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';
import { readConfigFile } from '../../services/core/usage/account-usage-reconcile.js';
import { claudeDefaultAccountFolder } from '../../services/runtimes/claude-code/claude-config-dir.js';
import { machineDefaultCodexHome } from '../../services/runtimes/codex/codex-home.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { setAccountUsageStore } from '../../services/core/usage/current-usage-store.js';
import { keepAwakeService } from '../../services/core/keep-awake/index.js';
import path from 'path';
import { initObservability, isOtlpExporting } from '../../services/observability/index.js';
import { env } from '../../env.js';
import { SERVER_VERSION } from '../../lib/version.js';
import { createDb, databaseHoldsUserData, snapshotBeforeMigrations, type Db } from '@dorkos/db';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { ServerRefs } from '../server-refs.js';
import { currentServerRole } from '../../lib/server-role.js';

/** What {@link openConfigAndDatabase} reads from the startup steps before it. */
export interface OpenConfigAndDatabaseInput {
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  logLevel: ClaimDataDirectoryResult['logLevel'];
}

/**
 * Load the settings and open the database, snapshotting it before any migration.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function openConfigAndDatabase(
  refs: ServerRefs,
  built: OpenConfigAndDatabaseInput
): Promise<{ dbPath: string; backupsDir: string; db: Db; firstBoot: boolean }> {
  const { dorkHome, logLevel } = built;
  try {
    initConfigManager(dorkHome);
  } catch (error) {
    if (!(error instanceof ConfigBootError)) throw error;
    // The settings file is intact and DorkOS cannot use it, so stopping is the
    // honest outcome: booting on defaults would quietly run with someone else's
    // security posture. Same stderr reasoning as the instance lock above — an
    // operator starting from a terminal has to see this.
    logger.error(error.message);
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  // Before usage polling or any launch, preserve the identities an existing
  // install already used. Metadata is non-secret; excluded folders never enter it.
  accountSigninPolicy()?.initializeInstall(
    !configManager.isFirstRun,
    signinAccounts().map((account) => account.path),
    readAccountLoginMetadata
  );
  // A hand-edited account rule of the wrong shape reads as "no rule" rather than
  // refusing the file (spec `flow-multiproject` §8.1); say so once.
  warnMalformedAccountRules(configManager, (message, meta) => logger.warn(message, meta));
  // Credential substrate (ADR-0315): resolves stored credential references to
  // secrets at each runtime's env-injection seam. Must precede any runtime spawn.
  initCredentialProvider(dorkHome);

  // A Claude account change re-derives its caches live, and ONLY in a server
  // process (spec `claude-code-accounts` D5, seam added by DOR-1247). The same
  // config write happens from `dorkos config set`, where there is no registry to
  // re-derive and no client to tell — so the applier is wired here rather than
  // imported by the write path, and an unwired write says so instead of claiming
  // an apply that never happened.
  initClaudeAccountApplier(() => void applyClaudeAccountChange());

  // Per-account usage for every runtime (spec `claude-account-fleet` D2, §6 R):
  // the ledger files under `<dorkHome>/runtimes/<runtime>/usage/` are its
  // persistence, shared with flow. Built right after config so the first turn
  // already records into it. `default` resolves from config and the OS home
  // only (the two helpers below), never from this process's environment.
  refs.accountUsageStore = new AccountUsageStore({
    dorkHome,
    readConfig: () => readConfigFile(configManager.path),
    resolveDefaultRoot: (runtime, config) =>
      runtime === 'claude-code'
        ? claudeDefaultAccountFolder(config)
        : runtime === 'codex'
          ? { path: machineDefaultCodexHome(), warnings: [] }
          : { path: null, warnings: [] },
    broadcast: (usage) => eventFanOut.broadcast('account_usage', usage),
  });
  await refs.accountUsageStore.load().catch((err: unknown) => {
    logger.warn('[DorkOS] account usage store failed to load; usage starts empty', {
      err: String(err),
    });
  });
  setAccountUsageStore(refs.accountUsageStore);
  // An in-app account change is reconciled at once; `flow accounts add` and hand
  // edits never reach onChange, which is why the store's 60 s scan reconciles too.
  configManager.onChange((change) => {
    if (change.sections.includes('runtimes')) void refs.accountUsageStore?.reconcileAccounts();
  });

  // Keep this computer awake while agents work (spec `keep-awake`). Started
  // right after config, before any runtime is registered, so the holder exists
  // for the first turn; the registry wrapper counts turns from there. The
  // setting is read live, so a toggle needs no restart. A hub runs no agents
  // and has no computer of its own to keep awake, so it never starts.
  if (currentServerRole() !== 'hub') {
    keepAwakeService.start({
      readSettings: () => configManager.get('keepAwake'),
      onSettingsChange: (listener) => configManager.onChange((change) => listener(change.sections)),
      broadcast: (status) => eventFanOut.broadcast('keep_awake_status', status),
    });
  }

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
  const backupsDir = path.join(dorkHome, 'backups');
  const db = createDb(dbPath);

  // Asked BEFORE migrating, because afterwards it can no longer be answered: a
  // first boot comes out of `runMigrations` holding every table and not one row,
  // indistinguishable by shape from an install that has been running for a year.
  const firstBoot = !databaseHoldsUserData(db);

  // Snapshot BEFORE migrating, and only when a migration is actually about to
  // change something. This database holds the only copy of every room, DM and
  // thread conversation on the machine, and migrations apply themselves at every
  // boot with nobody asked. Deliberately NOT wrapped in a try/catch: if the
  // snapshot cannot be written, the right answer is to stop and say so rather
  // than take an irreversible step with no way back (`snapshotBeforeMigrations`).
  const preMigrationSnapshot = snapshotBeforeMigrations(db, { dir: backupsDir });
  if (preMigrationSnapshot) {
    logger.info(`[DB] Snapshot taken before migrating: ${preMigrationSnapshot}`);
  }
  return { dbPath, backupsDir, db, firstBoot };
}

/** What {@link openConfigAndDatabase} hands the steps after it. */
export type OpenConfigAndDatabaseResult = Awaited<ReturnType<typeof openConfigAndDatabase>>;
