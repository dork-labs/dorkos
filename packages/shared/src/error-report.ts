/**
 * Opt-in error reporting core — PII scrubbing and PostHog `$exception` mapping,
 * shared by the server and the CLI (DOR-293, consolidated in DOR-318).
 *
 * This is the security-critical layer. Crash reports are built by an
 * **allowlist**: only the fields defined here are ever sent. The raw error
 * message is never sent (it is free-form and could carry session content or
 * prompts); we send the error type plus a stack scrubbed to repo-relative
 * filenames, with home directories, absolute paths, and secret-shaped tokens
 * stripped before anything leaves the machine. Allowlist-by-construction (rather
 * than denylisting a vendor SDK's large auto-captured surface) keeps the CLI
 * bundle small and the privacy guarantee tight. See ADR 260711-153307
 * (scrubbing contract) and ADR 260713-143958 Phase 6 (destination).
 *
 * **Destination (DOR-318):** reports no longer go direct-to-Sentry. They map to
 * a PostHog-native `$exception` event and POST to DorkOS's own ingest at
 * {@link TELEMETRY_EVENTS_ENDPOINT} (`https://dorkos.ai/api/telemetry/events`),
 * which forwards to PostHog Error Tracking server-side. This removes the
 * third-party egress and the founder `SENTRY_DSN` dependency; the consent
 * posture is unchanged (Tier 2 explicit opt-in). The `$exception` wire shape is
 * a documented carve-out defined in `telemetry-events.ts`; we import its type
 * only (no runtime coupling), so this module stays pure.
 *
 * Environment-agnostic and pure except {@link sendExceptionEvent} (uses
 * `fetch`): every input is passed in, so the same code runs in the server and
 * the CLI and is exhaustively testable. Nothing here reads config, env, or the
 * filesystem.
 *
 * @module error-report
 */

import type { ExceptionEvent, ExceptionEventProperties } from './telemetry-events.js';

/** A single scrubbed stack frame — structural location only, never source or locals. */
export interface ScrubbedFrame {
  /** Relativized filename (never absolute, never a home dir). */
  filename: string;
  /** Function name, or `<anonymous>`. */
  function: string;
  /** 1-based line number, when known. */
  lineno?: number;
  /** 1-based column number, when known. */
  colno?: number;
  /** Whether the frame is DorkOS/app code (vs a dependency under node_modules). */
  in_app: boolean;
}

/** The complete allowlist of what a DorkOS error event may contain. */
export interface ErrorEvent {
  event_id: string;
  timestamp: string;
  platform: 'node';
  level: 'error';
  release: string;
  environment: string;
  sdk: { name: string; version: string };
  /** Only non-PII tags: the surface (`server`/`cli`) and OS `platform-arch`. */
  tags: Record<string, string>;
  exception: {
    values: Array<{
      type: string;
      value: string;
      stacktrace: { frames: ScrubbedFrame[] };
    }>;
  };
}

/** Inputs for building an {@link ErrorEvent}. */
export interface BuildErrorEventInput {
  /** The thrown error (or an arbitrary thrown value). */
  error: unknown;
  /** Release identifier, e.g. `dorkos@0.46.0`. */
  release: string;
  /** Deployment environment, e.g. `production` / `development`. */
  environment: string;
  /** Which surface reported it. */
  surface: 'server' | 'cli' | 'client';
  /** OS tag, e.g. `darwin-arm64`. */
  os: string;
  /**
   * Absolute working directory used to relativize in-app stack frames. Frames
   * under this path become repo-relative; never emitted as an absolute path.
   */
  cwd: string;
}

/** Max characters of a (scrubbed) error message that may be sent. */
export const MAX_MESSAGE_LEN = 500;

/** Identifies our minimal reporter to the ingest server. */
export const SDK_NAME = 'dorkos.minimal';

/**
 * Secret-shaped token patterns redacted from any free-form text before send.
 * Covers common provider keys, bearer/authorization headers, and the DorkOS
 * credential-reference schemes (`keychain:`/`env:`/`file:`).
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, // OpenAI/Anthropic-style keys
  /\bgh[posu]_[A-Za-z0-9]{16,}/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]+/gi, // bearer tokens
  /\b(?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, // key: value secrets
  /\b(?:keychain|env|file):[^\s"']+/g, // DorkOS credential references
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g, // JWTs
];

/**
 * Redact home directories and absolute paths from a string, replacing them with
 * a home-relative (`~/…`) or repo-relative form. Removes the username-bearing
 * prefix that absolute paths leak.
 *
 * @param text - Arbitrary text that may embed filesystem paths.
 */
export function redactPaths(text: string): string {
  return (
    text
      // Unix home dirs → ~/ (drops the username segment).
      .replace(/\/(?:Users|home)\/[^/\s:"']+/g, '~')
      // Windows home dirs → ~ (case-insensitive drive + Users\name).
      .replace(/[A-Za-z]:\\Users\\[^\\\s:"']+/gi, '~')
      // Any remaining absolute Unix path → keep from the last node_modules/ or
      // strip to a leading ./ so nothing absolute (or its leading dirs) leaks.
      .replace(/\/[^\s:"']*\/(node_modules\/[^\s:"']+)/g, '$1')
  );
}

/**
 * Redact secret-shaped tokens from a string.
 *
 * @param text - Arbitrary text that may embed credentials.
 */
export function redactTokens(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/**
 * Scrub a free-form error message: redact tokens and paths, then cap length.
 * Applied to the error's `.message` (which can contain arbitrary interpolated
 * data) so no secret or absolute path rides along.
 *
 * @param message - The raw error message.
 */
export function scrubMessage(message: string): string {
  const scrubbed = redactTokens(redactPaths(message));
  return scrubbed.length > MAX_MESSAGE_LEN ? `${scrubbed.slice(0, MAX_MESSAGE_LEN)}…` : scrubbed;
}

/**
 * Relativize a stack-frame filename so it is never absolute and never reveals a
 * home directory: dependency frames keep their `node_modules/<pkg>/…` tail,
 * in-app frames become repo-relative to `cwd`, and anything else collapses to
 * its basename.
 *
 * @param filename - The raw frame filename (often absolute).
 * @param cwd - Absolute working directory for in-app relativization.
 */
export function scrubFilename(filename: string, cwd: string): string {
  let f = filename.replace(/\\/g, '/').replace(/^file:\/\//, '');
  const nm = f.lastIndexOf('node_modules/');
  if (nm !== -1) return f.slice(nm);
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedCwd && f.startsWith(`${normalizedCwd}/`)) {
    return f.slice(normalizedCwd.length + 1);
  }
  // Backstop: strip any remaining home dir, then collapse to the basename
  // whenever an absolute path, a home dir, or a drive path appears ANYWHERE in
  // the string — not just at the start. This catches eval/vm frames like
  // `eval at <anonymous> (~/secret-client/app.js:10:5)` whose EMBEDDED directory
  // (a project or client name) would otherwise survive the leading-anchor check.
  f = redactPaths(f);
  if (
    /^([A-Za-z]:|\/|~)/.test(f) || // starts absolute / home / drive
    f.includes('~/') || // embedded home (post-redaction)
    /\/(?:Users|home)\//.test(f) || // embedded home (belt-and-suspenders)
    /[A-Za-z]:[\\/]/.test(f) || // embedded Windows drive
    /[\s(]\//.test(f) // embedded absolute path after a space or "("
  ) {
    const parts = f.split('/').filter(Boolean);
    return parts.slice(-1)[0] ?? f;
  }
  return f;
}

interface RawFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
}

/**
 * Parse a V8 stack string into raw frames. Handles the two common shapes:
 * `at fn (file:line:col)` and `at file:line:col`.
 *
 * @param stack - The `Error.stack` string.
 */
function parseStack(stack: string): RawFrame[] {
  const frames: RawFrame[] = [];
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;
    const withFn = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(trimmed);
    const withoutFn = /^at\s+(.+?):(\d+):(\d+)$/.exec(trimmed);
    if (withFn) {
      frames.push({
        function: withFn[1],
        filename: withFn[2],
        lineno: Number(withFn[3]),
        colno: Number(withFn[4]),
      });
    } else if (withoutFn) {
      frames.push({
        function: '<anonymous>',
        filename: withoutFn[1],
        lineno: Number(withoutFn[2]),
        colno: Number(withoutFn[3]),
      });
    }
  }
  return frames;
}

/**
 * Scrub a stack string into allowlisted frames: function name, relativized
 * filename, line/column, and an `in_app` flag. Source lines, local variables,
 * and absolute paths are never included.
 *
 * @param stack - The raw `Error.stack`.
 * @param cwd - Absolute working directory for in-app relativization.
 */
export function scrubStack(stack: string | undefined, cwd: string): ScrubbedFrame[] {
  if (!stack) return [];
  return parseStack(stack).map((frame) => {
    const filename = scrubFilename(frame.filename, cwd);
    return {
      filename,
      // Defense in depth: a function name is normally a code identifier, but an
      // eval/vm frame can embed a path or the caller can name a function oddly —
      // scrub it the same way as any other free-form text.
      function: scrubMessage(frame.function),
      ...(frame.lineno !== undefined ? { lineno: frame.lineno } : {}),
      ...(frame.colno !== undefined ? { colno: frame.colno } : {}),
      in_app: !filename.startsWith('node_modules/'),
    };
  });
}

/** Generate a Sentry event id: 32 lowercase hex chars, no dashes. */
function newEventId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

/**
 * Build an allowlisted {@link ErrorEvent} from a thrown value. This is the only
 * place an event is constructed, so the set of fields that can ever be sent is
 * exactly the {@link ErrorEvent} shape.
 *
 * **The raw error message is deliberately NOT sent** (`value` is always empty).
 * A message is free-form and can contain session content, prompts, or user
 * input that no pattern scrubber can reliably catch — so, mirroring the
 * heartbeat's "structural anonymous data only" discipline, we send the error
 * `type` and the scrubbed stack (function + repo-relative file + line) and
 * nothing else. That still pinpoints the failing line in first-party source,
 * which is what a bug report needs, while making session-content leakage
 * structurally impossible. The `type` is still path/token-scrubbed in case a
 * caller poisons `error.name`.
 *
 * @param input - The error plus release/environment/surface/os/cwd context.
 */
export function buildErrorEvent(input: BuildErrorEventInput): ErrorEvent {
  const err = input.error;
  const isError = err instanceof Error;
  const type = isError ? err.name || 'Error' : 'UnknownError';
  const stack = isError ? err.stack : undefined;

  return {
    event_id: newEventId(),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    release: input.release,
    environment: input.environment,
    sdk: { name: SDK_NAME, version: input.release },
    tags: { surface: input.surface, os: input.os },
    exception: {
      values: [
        {
          type: scrubMessage(type),
          // Message omitted by design — see buildErrorEvent TSDoc.
          value: '',
          stacktrace: { frames: scrubStack(stack, input.cwd) },
        },
      ],
    },
  };
}

/** The DorkOS owned-ingest endpoint that both usage and `$exception` events POST to. */
export const TELEMETRY_EVENTS_ENDPOINT = 'https://dorkos.ai/api/telemetry/events';

/**
 * Map the scrubbed {@link ErrorEvent} into the property bag of a PostHog-native
 * `$exception` event (ADR 260713-143958 Phase 6). This is the single place the
 * server and CLI (and the client route, which rebuilds server-side) agree on the
 * wire shape, so the scrubbing done in {@link buildErrorEvent} is preserved
 * end-to-end.
 *
 * Shape notes (verified against `posthog-node`'s error-tracking output, which
 * PostHog Error Tracking is guaranteed to parse):
 *   - `$exception_list[].value` is the empty string — the raw message is never
 *     sent (mirrors {@link buildErrorEvent}); `type` is the scrubbed error name.
 *   - `stacktrace.type` is `'raw'` and each frame carries only structural
 *     location (`platform`, repo-relative `filename`, `function`, line/col,
 *     `in_app`) — no source lines, no locals, never an absolute path. Because we
 *     send pre-scrubbed raw frames with no `chunk_id`/`abs_path`, PostHog does no
 *     source-map fetch against us — grouping keys off the error type + top
 *     in-app frames (its default `$exception_fingerprint`), which is exactly a
 *     bug-report signature.
 *   - `$process_person_profile: false` keeps crash events anonymous (no PostHog
 *     person is created) even though a `distinctId` (the anonymous per-install
 *     `instanceId`) rides along for cross-crash correlation.
 *   - `surface` / `release` / `environment` / `os` mirror the old `ErrorEvent`
 *     tags/fields so crashes stay filterable by client vs server, version, etc.
 *
 * @param event - A scrubbed event from {@link buildErrorEvent}.
 */
export function errorEventToExceptionProperties(event: ErrorEvent): ExceptionEventProperties {
  const surface = event.tags.surface ?? 'server';
  // Browser stacks are web JS; the server and CLI are node JS. PostHog uses this
  // only to classify frames — it never triggers a fetch for our raw frames.
  const platform = surface === 'client' ? 'web:javascript' : 'node:javascript';
  const value = event.exception.values[0];
  return {
    $exception_list: [
      {
        type: value.type,
        // Empty by design — the raw message is never sent (see buildErrorEvent).
        value: '',
        mechanism: { handled: false, synthetic: false },
        stacktrace: {
          type: 'raw',
          frames: value.stacktrace.frames.map((f) => ({
            platform,
            filename: f.filename,
            function: f.function,
            ...(f.lineno !== undefined ? { lineno: f.lineno } : {}),
            ...(f.colno !== undefined ? { colno: f.colno } : {}),
            in_app: f.in_app,
          })),
        },
      },
    ],
    $exception_level: 'error',
    $process_person_profile: false,
    surface,
    release: event.release,
    environment: event.environment,
    os: event.tags.os ?? 'unknown',
  };
}

/** Inputs for building a fully-enveloped {@link ExceptionEvent}. */
export interface BuildExceptionEventInput extends BuildErrorEventInput {
  /** Anonymous per-install id used as the PostHog `distinct_id` (a UUID, not a user). */
  distinctId: string;
  /** Emitting DorkOS version, stamped into the event envelope. */
  dorkosVersion: string;
}

/**
 * Build a fully-enveloped, scrubbed PostHog `$exception` event ready to POST to
 * {@link TELEMETRY_EVENTS_ENDPOINT}. The single constructor for a crash event —
 * allowlisted by construction, exactly like {@link buildErrorEvent} (which it
 * wraps): the set of fields that can ever be sent is precisely the
 * {@link ExceptionEvent} shape.
 *
 * @param input - The error plus release/environment/surface/os/cwd context and
 *   the envelope identity (`distinctId`, `dorkosVersion`).
 */
export function buildExceptionEvent(input: BuildExceptionEventInput): ExceptionEvent {
  const scrubbed = buildErrorEvent(input);
  return {
    event: '$exception',
    properties: errorEventToExceptionProperties(scrubbed),
    distinctId: input.distinctId,
    timestamp: scrubbed.timestamp,
    dorkosVersion: input.dorkosVersion,
  };
}

/** Options for {@link sendExceptionEvent}. */
export interface SendExceptionEventOptions {
  /** Ingest endpoint. Defaults to {@link TELEMETRY_EVENTS_ENDPOINT}; overridable in tests. */
  endpoint?: string;
  /** `fetch` implementation. Defaults to the global; overridable in tests. */
  fetchImpl?: typeof fetch;
  /**
   * Debug mode (`DORKOS_TELEMETRY_DEBUG`): print the exact JSON that WOULD be
   * sent to stderr and send nothing, so a power user can audit the wire format.
   */
  debug?: boolean;
}

/**
 * POST one built {@link ExceptionEvent} to the owned ingest as a single-event
 * batch (`{ events: [event] }`), matching the usage-reporter's wire envelope.
 * Best-effort: any failure (network error, non-2xx) is swallowed — error
 * reporting must never itself crash the process or surface to the user. In debug
 * mode nothing is sent; the payload is printed to stderr instead.
 *
 * @param event - The allowlisted, already-scrubbed `$exception` event.
 * @param options - Endpoint / fetch / debug overrides.
 */
export async function sendExceptionEvent(
  event: ExceptionEvent,
  options: SendExceptionEventOptions = {}
): Promise<void> {
  const endpoint = options.endpoint ?? TELEMETRY_EVENTS_ENDPOINT;
  const body = JSON.stringify({ events: [event] });

  if (options.debug) {
    // process may be undefined in a browser, but this sender only runs in the
    // server/CLI (Node); guard anyway so the pure module stays browser-safe.
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(
        `[Telemetry] DORKOS_TELEMETRY_DEBUG: crash report NOT sent. Would POST to ${endpoint}:\n` +
          `${JSON.stringify({ events: [event] }, null, 2)}\n`
      );
    }
    return;
  }

  try {
    await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch {
    // Telemetry must never fail user operations.
  }
}

/**
 * How long a fatal path (an `uncaughtException` that is about to `process.exit`)
 * waits for a crash report to flush before giving up. Bounded on purpose: a
 * blocked ingest endpoint must never hang shutdown — the timeout is the guard.
 */
export const FATAL_FLUSH_TIMEOUT_MS = 1500;

/**
 * Resolve when `promise` settles OR after `ms`, whichever comes first, and never
 * reject. Used on fatal shutdown paths to give an in-flight `sendErrorEvent` a
 * bounded window to reach the network before the process exits, without letting
 * a hung endpoint delay exit beyond `ms`.
 *
 * @param promise - The work to wait for (typically a fire-and-forget send).
 * @param ms - Maximum time to wait, in milliseconds.
 */
export function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    // `then(done, done)` handles both settlements, so a rejected `promise`
    // never escapes as an unhandled rejection.
    void Promise.resolve(promise).then(done, done);
  });
}
