/**
 * Opt-in CLI error reporting (DOR-293 PR-B).
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
 * AND a `SENTRY_DSN` env var is set. Missing either → `null`, nothing sent. The
 * error message is omitted and paths/tokens scrubbed by the shared core.
 *
 * @module cli/lib/error-reporter
 */

import fs from 'fs';
import path from 'path';
import { buildErrorEvent, parseDsn, sendErrorEvent } from '@dorkos/shared/error-report';

/** A live CLI error reporter. `capture` is fire-and-forget and never throws. */
export interface CliErrorReporter {
  /** Scrub and send one error report. Swallows all failures. */
  capture(error: unknown): Promise<void>;
}

/** Options for {@link initCliErrorReporting}. */
export interface InitCliErrorReportingOptions {
  /** Resolved `~/.dork` directory (holds `config.json`). */
  dorkHome: string;
  /** CLI version (`__CLI_VERSION__`) used as the Sentry release. */
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
 * Build a CLI error reporter, or return `null` when reporting is off.
 *
 * Returns `null` (and sends nothing) unless the user opted in via config AND a
 * valid `SENTRY_DSN` is present.
 *
 * @param options - The dorkHome (for config) and CLI version.
 */
export function initCliErrorReporting(
  options: InitCliErrorReportingOptions
): CliErrorReporter | null {
  if (!readErrorReportingConsent(options.dorkHome)) return null;
  // Read at call time, not from env.ts's import-time snapshot: the DSN is set by
  // the operator's shell right before running, and the CLI resolves its
  // environment imperatively (see the DORK_HOME convention in cli.ts).
  // eslint-disable-next-line no-restricted-syntax -- call-time env resolution (CLI convention)
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || !parseDsn(dsn)) return null;

  const release = `dorkos@${options.version}`;
  // eslint-disable-next-line no-restricted-syntax -- call-time env resolution (CLI convention)
  const environment = process.env.NODE_ENV ?? 'production';
  const os = `${process.platform}-${process.arch}`;

  return {
    async capture(error: unknown): Promise<void> {
      const event = buildErrorEvent({
        error,
        release,
        environment,
        surface: 'cli',
        os,
        cwd: process.cwd(),
      });
      await sendErrorEvent(event, dsn);
    },
  };
}

/**
 * Install CLI-level `uncaughtException` / `unhandledRejection` handlers that
 * report through `reporter` (when non-null) and then preserve the CLI's normal
 * behavior. Returns an uninstall function — the caller MUST call it before
 * importing the in-process server so the server's own handlers are the only
 * ones on the cockpit-boot path.
 *
 * @param reporter - The reporter, or `null` to install pass-through handlers.
 */
export function installCliErrorHandlers(reporter: CliErrorReporter | null): () => void {
  const onException = (err: unknown): void => {
    void reporter?.capture(err);
    // Preserve the pre-existing crash behavior: print and exit non-zero.
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  };
  const onRejection = (reason: unknown): void => {
    void reporter?.capture(reason);
    console.error(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  };

  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);

  return () => {
    process.removeListener('uncaughtException', onException);
    process.removeListener('unhandledRejection', onRejection);
  };
}
