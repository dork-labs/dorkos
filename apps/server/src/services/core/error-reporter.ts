/**
 * Opt-in server error reporting (DOR-293, consolidated in DOR-318).
 *
 * Wires the shared, allowlist-scrubbing error-report core
 * (`@dorkos/shared/error-report`) to the server. Crash reports map to a
 * PostHog-native `$exception` event and POST to DorkOS's own ingest at
 * {@link TELEMETRY_EVENTS_ENDPOINT} (`https://dorkos.ai/api/telemetry/events`),
 * which forwards to PostHog Error Tracking server-side — there is no more
 * third-party egress and no `SENTRY_DSN` dependency (ADR 260713-143958 Phase 6).
 *
 * Consent is unchanged: this is a **separate, explicit opt-in** (Tier 2). It
 * never rides on the first-run "share anonymous data" choice. Reporting fires
 * only when `config.telemetry.errorReporting === true` AND no env kill switch is
 * set — the caller folds both through `resolveTelemetryConsent` and passes the
 * result as `consent`. The raw message is omitted and paths/tokens are scrubbed
 * by the shared core; see ADR 260711-153307 and https://dorkos.ai/telemetry.
 *
 * State is a module singleton (mirroring the usage-reporter) so the thin
 * `POST /api/errors` route can report client-side crashes through the same gate
 * without threading a handle through app construction. When consent is off the
 * singleton is null and every capture path is a silent no-op.
 *
 * @module services/core/error-reporter
 */

import {
  buildExceptionEvent,
  sendExceptionEvent,
  raceWithTimeout,
  FATAL_FLUSH_TIMEOUT_MS,
} from '@dorkos/shared/error-report';

import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { logger } from '../../lib/logger.js';

/** Options for {@link registerServerErrorReporting}. */
export interface RegisterServerErrorReportingOptions {
  /**
   * The `config.telemetry.errorReporting` opt-in, already folded through the env
   * kill switches (`resolveTelemetryConsent`). When false, registration clears
   * the reporter and every capture path is a no-op.
   */
  consent: boolean;
  /** DorkOS version (e.g. `0.46.0`) used as the release and event `dorkosVersion`. */
  version: string;
  /** Deployment environment (e.g. `production` / `development`). */
  environment: string;
  /** Absolute working directory, for relativizing in-app stack frames. */
  cwd: string;
  /** Resolved `~/.dork` directory, for the anonymous per-install instance id. */
  dorkHome: string;
  /** Debug mode (`DORKOS_TELEMETRY_DEBUG`): print the payload to stderr, send nothing. */
  debug: boolean;
  /** Override the ingest endpoint (tests). Defaults to the shared constant. */
  endpoint?: string;
  /** Override `fetch` (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** Live reporter state; `null` when reporting is off. */
interface ReporterState {
  release: string;
  environment: string;
  cwd: string;
  dorkHome: string;
  os: string;
  version: string;
  debug: boolean;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Cached anonymous instance id, resolved lazily on the first capture. */
  instanceId: string | null;
}

let state: ReporterState | null = null;

/**
 * Register (or, when `consent` is false, tear down) the server error reporter
 * for the lifetime of the server. Idempotent — calling it again replaces the
 * prior registration. No network or filesystem work happens here; the instance
 * id is resolved lazily on the first actual capture.
 *
 * @param options - Consent, release/environment context, and delivery inputs.
 */
export function registerServerErrorReporting(options: RegisterServerErrorReportingOptions): void {
  if (!options.consent) {
    state = null;
    return;
  }
  state = {
    release: `dorkos@${options.version}`,
    environment: options.environment,
    cwd: options.cwd,
    dorkHome: options.dorkHome,
    os: `${process.platform}-${process.arch}`,
    version: options.version,
    debug: options.debug,
    endpoint: options.endpoint,
    fetchImpl: options.fetchImpl,
    instanceId: null,
  };
  logger.info('[Telemetry] Error reporting enabled (owned ingest → PostHog, opt-in)');
}

/** Whether error reporting is currently on. Exported for the route + tests. */
export function isServerErrorReportingEnabled(): boolean {
  return state !== null;
}

/** Resolve (and cache) the anonymous per-install id, or `null` if it can't be read. */
async function resolveInstanceId(s: ReporterState): Promise<string | null> {
  if (s.instanceId != null) return s.instanceId;
  try {
    s.instanceId = await getOrCreateInstanceId(s.dorkHome);
  } catch {
    // Can't identify the install — skip this report; a later capture retries.
    return null;
  }
  return s.instanceId;
}

/**
 * Scrub and send one crash report. Swallows all failures. Returns the send
 * promise so a fatal path can bounded-await it (see {@link flushServerError}).
 * A no-op (resolves immediately) when reporting is off.
 *
 * @param error - The thrown value to report.
 * @param surface - Which surface crashed. Defaults to `'server'`; the
 *   `/api/errors` route passes `'client'` for cockpit crashes.
 */
export async function captureServerError(
  error: unknown,
  surface: 'server' | 'client' = 'server'
): Promise<void> {
  const s = state;
  if (!s) return;
  const distinctId = await resolveInstanceId(s);
  if (!distinctId) return;
  const event = buildExceptionEvent({
    error,
    release: s.release,
    environment: s.environment,
    surface,
    os: s.os,
    cwd: s.cwd,
    distinctId,
    dorkosVersion: s.version,
  });
  await sendExceptionEvent(event, {
    endpoint: s.endpoint,
    fetchImpl: s.fetchImpl,
    debug: s.debug,
  });
}

/** The untrusted client crash payload accepted by `POST /api/errors`. */
export interface ClientErrorPayload {
  /** Error constructor name (e.g. `TypeError`). */
  name?: string;
  /** Raw error message — NEVER trusted or sent; used only to rebuild an Error server-side. */
  message?: string;
  /** Raw `Error.stack` string — scrubbed server-side to repo-relative frames. */
  stack?: string;
}

/**
 * Report a cockpit (browser) crash relayed by the client via `POST /api/errors`.
 *
 * The client payload is **never trusted**: we accept only `name`/`message`/`stack`
 * strings, rebuild a plain `Error` from them, and run it through the SAME
 * server-side scrubber as any other crash (`buildExceptionEvent`) so absolute
 * paths, home dirs, and tokens a hostile or buggy client might include are
 * stripped here, not on the client. The message is dropped entirely, as always.
 * A no-op when reporting is off (the route still accepts the request).
 *
 * @param payload - The untrusted `{ name, message, stack }` from the client.
 */
export async function captureClientError(payload: ClientErrorPayload): Promise<void> {
  if (!state) return;
  const err = new Error(typeof payload.message === 'string' ? payload.message : '');
  if (typeof payload.name === 'string' && payload.name) err.name = payload.name;
  // Assign the client stack (if any) so the scrubber can extract frames; if the
  // client sent none, the rebuilt Error's own (server) stack is scrubbed instead
  // and simply carries no useful app frames — never a leak.
  if (typeof payload.stack === 'string') err.stack = payload.stack;
  await captureServerError(err, 'client');
}

/**
 * Bounded-await a crash report on a fatal path (an `uncaughtException` about to
 * `process.exit`). Gives the send up to {@link FATAL_FLUSH_TIMEOUT_MS} to reach
 * the network, then resolves so shutdown proceeds even if the ingest endpoint is
 * blocked. No-op when reporting is off. Never throws.
 *
 * @param error - The fatal error to report.
 */
export async function flushServerError(error: unknown): Promise<void> {
  if (!state) return;
  await raceWithTimeout(captureServerError(error), FATAL_FLUSH_TIMEOUT_MS);
}
