/**
 * Opt-in server error reporting (DOR-293 PR-B).
 *
 * Wires the shared, allowlist-scrubbing error-report core
 * (`@dorkos/shared/error-report`) to the server. Crash reports go to a **third
 * party** (Sentry, or a self-hosted GlitchTip using the same protocol), so this
 * is a **separate, explicit opt-in** — it never rides on the first-run
 * "share anonymous data" choice, which covers only the first-party anonymous
 * channels. Reporting fires only when BOTH hold:
 *
 *   1. `config.telemetry.errorReporting === true` (default false), and
 *   2. a valid `SENTRY_DSN` is configured.
 *
 * Missing either → {@link initServerErrorReporting} returns `null` and nothing
 * is ever sent. The message is omitted and paths/tokens are scrubbed by the
 * shared core; see ADR 260711-153307 and https://dorkos.ai/telemetry.
 *
 * @module services/core/error-reporter
 */

import {
  buildErrorEvent,
  parseDsn,
  raceWithTimeout,
  sendErrorEvent,
  FATAL_FLUSH_TIMEOUT_MS,
} from '@dorkos/shared/error-report';
import { logger } from '../../lib/logger.js';

/** A live server error reporter. `capture` never throws; it resolves when the send settles. */
export interface ServerErrorReporter {
  /**
   * Scrub and send one error report. Swallows all failures. Returns the send
   * promise so a fatal path can bounded-await it (see {@link flushServerError}).
   */
  capture(error: unknown): Promise<void>;
}

/** Options for {@link initServerErrorReporting}. */
export interface InitServerErrorReportingOptions {
  /** The `config.telemetry.errorReporting` opt-in flag. */
  consent: boolean;
  /** The Sentry/GlitchTip DSN (from `SENTRY_DSN`); `undefined` disables reporting. */
  dsn: string | undefined;
  /** DorkOS version (e.g. `0.46.0`) used as the Sentry release. */
  version: string;
  /** Deployment environment (e.g. `production` / `development`). */
  environment: string;
  /** Absolute working directory, for relativizing in-app stack frames. */
  cwd: string;
}

/**
 * Build a server error reporter, or return `null` when reporting is off.
 *
 * Returns `null` (and sends nothing, ever) unless the user opted in AND a valid
 * DSN is present. A malformed DSN logs a warning and disables reporting rather
 * than failing loudly.
 *
 * @param options - Consent, DSN, and release/environment context.
 */
export function initServerErrorReporting(
  options: InitServerErrorReportingOptions
): ServerErrorReporter | null {
  if (!options.consent) return null;
  if (!options.dsn) {
    logger.warn(
      '[Telemetry] Error reporting is enabled in config but no SENTRY_DSN is set — skipping'
    );
    return null;
  }
  if (!parseDsn(options.dsn)) {
    logger.warn('[Telemetry] Error reporting disabled — SENTRY_DSN is malformed');
    return null;
  }

  const dsn = options.dsn;
  const release = `dorkos@${options.version}`;
  const os = `${process.platform}-${process.arch}`;
  logger.info('[Telemetry] Error reporting enabled (Sentry/GlitchTip, opt-in)');

  return {
    capture(error: unknown): Promise<void> {
      const event = buildErrorEvent({
        error,
        release,
        environment: options.environment,
        surface: 'server',
        os,
        cwd: options.cwd,
      });
      return sendErrorEvent(event, dsn);
    },
  };
}

/**
 * Bounded-await a crash report on a fatal path (an `uncaughtException` about to
 * `process.exit`). Gives the send up to {@link FATAL_FLUSH_TIMEOUT_MS} to reach
 * the network, then resolves so shutdown proceeds even if the ingest endpoint is
 * blocked. No-op when `reporter` is `null`. Never throws.
 *
 * @param reporter - The active reporter, or `null` when reporting is off.
 * @param error - The fatal error to report.
 */
export async function flushServerError(
  reporter: ServerErrorReporter | null,
  error: unknown
): Promise<void> {
  if (!reporter) return;
  await raceWithTimeout(reporter.capture(error), FATAL_FLUSH_TIMEOUT_MS);
}
