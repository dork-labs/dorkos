/**
 * Opt-in CLI error reporting (DOR-293, consolidated in DOR-318).
 *
 * Wires the shared allowlist-scrubbing error-report core to the CLI so a crash
 * in a standalone command (`doctor`, `feedback`, `package`, `harness`, …) can be
 * reported. The cockpit-boot path (`dorkos` with no subcommand) runs the server
 * in-process, and the server installs its OWN reporter and handlers — so the
 * caller uninstalls the CLI handlers before importing the server to avoid
 * double-reporting.
 *
 * Same gate as the server: reporting happens only when
 * `config.telemetry.errorReporting === true` (read from `~/.dork/config.json`)
 * AND no env kill switch is set (`DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED`).
 * There is no longer a `SENTRY_DSN` requirement — crash reports map to a PostHog
 * `$exception` event and POST to DorkOS's own ingest
 * (`https://dorkos.ai/api/telemetry/events`), which forwards to PostHog Error
 * Tracking server-side (ADR 260713-143958 Phase 6). The error message is omitted
 * and paths/tokens scrubbed by the shared core. `DORKOS_TELEMETRY_DEBUG=1` prints
 * the exact payload to stderr instead of sending it.
 *
 * @module cli/lib/error-reporter
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildExceptionEvent,
  sendExceptionEvent,
  raceWithTimeout,
  FATAL_FLUSH_TIMEOUT_MS,
} from '@dorkos/shared/error-report';
import {
  isTelemetryDisabledByEnv,
  isTelemetryDebugEnabled,
} from '@dorkos/shared/telemetry-consent';

/**
 * File (under dorkHome) holding the anonymous per-install UUID. Mirrors
 * `INSTANCE_ID_FILENAME` in `apps/server/src/lib/instance-id.ts` — the CLI can't
 * import from the server package, so the name is duplicated with this note.
 */
const INSTANCE_ID_FILENAME = 'telemetry-install-id';

/** A live CLI error reporter. `capture` is fire-and-forget and never throws. */
export interface CliErrorReporter {
  /** Scrub and send one error report. Swallows all failures. */
  capture(error: unknown): Promise<void>;
}

/** Options for {@link initCliErrorReporting}. */
export interface InitCliErrorReportingOptions {
  /** Resolved `~/.dork` directory (holds `config.json` + the install id). */
  dorkHome: string;
  /** CLI version (`__CLI_VERSION__`) used as the release + event `dorkosVersion`. */
  version: string;
}

/**
 * Read `telemetry.errorReporting` from `<dorkHome>/config.json`. Best-effort:
 * a missing or unparseable config means no consent (returns `false`).
 *
 * @param dorkHome - The resolved `~/.dork` directory.
 * @internal Exported for testing.
 */
export function readErrorReportingConsent(dorkHome: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { telemetry?: { errorReporting?: unknown } };
    return parsed.telemetry?.errorReporting === true;
  } catch {
    return false;
  }
}

/**
 * Read the anonymous per-install id shared with every dorkos.ai channel. Falls
 * back to a fresh random UUID when the file is missing (a standalone CLI command
 * that has never sent a heartbeat): still anonymous, and PostHog groups crashes
 * by fingerprint, not `distinct_id`.
 *
 * @param dorkHome - The resolved `~/.dork` directory.
 */
function readInstanceId(dorkHome: string): string {
  try {
    const raw = fs.readFileSync(path.join(dorkHome, INSTANCE_ID_FILENAME), 'utf-8').trim();
    if (raw) return raw;
  } catch {
    // Missing or unreadable — fall through to an ephemeral anonymous id.
  }
  return randomUUID();
}

/**
 * Build a CLI error reporter, or return `null` when reporting is off.
 *
 * Returns `null` (and sends nothing) unless the user opted in via config AND no
 * env kill switch is set.
 *
 * @param options - The dorkHome (for config + install id) and CLI version.
 */
export function initCliErrorReporting(
  options: InitCliErrorReportingOptions
): CliErrorReporter | null {
  if (!readErrorReportingConsent(options.dorkHome)) return null;
  // Env kill switch (DOR-312) beats config: DO_NOT_TRACK / DORKOS_TELEMETRY_DISABLED
  // force every outbound channel off. Read process.env at call time, matching the
  // CLI's imperative env convention (see cli.ts).
  // eslint-disable-next-line no-restricted-syntax -- call-time env resolution (CLI convention)
  if (isTelemetryDisabledByEnv(process.env)) return null;

  const release = `dorkos@${options.version}`;
  // eslint-disable-next-line no-restricted-syntax -- call-time env resolution (CLI convention)
  const environment = process.env.NODE_ENV ?? 'production';
  // eslint-disable-next-line no-restricted-syntax -- call-time env resolution (CLI convention)
  const debug = isTelemetryDebugEnabled(process.env);
  const os = `${process.platform}-${process.arch}`;
  const distinctId = readInstanceId(options.dorkHome);

  return {
    async capture(error: unknown): Promise<void> {
      const event = buildExceptionEvent({
        error,
        release,
        environment,
        surface: 'cli',
        os,
        cwd: process.cwd(),
        distinctId,
        dorkosVersion: options.version,
      });
      await sendExceptionEvent(event, { debug });
    },
  };
}

/**
 * Bounded-await a crash report on a fatal path (about to `process.exit`). Gives
 * the send up to {@link FATAL_FLUSH_TIMEOUT_MS} to reach the network, then
 * resolves so shutdown proceeds even if the ingest endpoint is blocked. No-op
 * when `reporter` is `null`. Never throws.
 *
 * @param reporter - The active reporter, or `null` when reporting is off.
 * @param error - The fatal error to report.
 */
export async function flushCliError(
  reporter: CliErrorReporter | null,
  error: unknown
): Promise<void> {
  if (!reporter) return;
  await raceWithTimeout(reporter.capture(error), FATAL_FLUSH_TIMEOUT_MS);
}

/**
 * Install CLI-level `uncaughtException` / `unhandledRejection` handlers that
 * report through `reporter`, then preserve the CLI's default crash semantics —
 * both handlers print and `process.exit(1)`. Registering an `unhandledRejection`
 * listener disables Node's default `--unhandled-rejections=throw`, so the
 * handler restores the non-zero exit itself.
 *
 * Only call this when reporting is ON (a non-null reporter). When off, install
 * nothing so Node's own crash behavior stands unchanged. Returns an uninstall
 * function — the caller MUST call it before importing the in-process server so
 * the server's own handlers are the only ones on the cockpit-boot path.
 *
 * @param reporter - The active reporter (never null; reporting is on).
 */
export function installCliErrorHandlers(reporter: CliErrorReporter): () => void {
  const flushAndCrash = (value: unknown): void => {
    void flushCliError(reporter, value).finally(() => {
      console.error(value instanceof Error ? (value.stack ?? value.message) : String(value));
      process.exit(1);
    });
  };

  process.on('uncaughtException', flushAndCrash);
  process.on('unhandledRejection', flushAndCrash);

  return () => {
    process.removeListener('uncaughtException', flushAndCrash);
    process.removeListener('unhandledRejection', flushAndCrash);
  };
}
