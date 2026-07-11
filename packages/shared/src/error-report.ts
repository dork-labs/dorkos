/**
 * Opt-in error reporting core — DSN parsing, PII scrubbing, and Sentry-envelope
 * building/sending, shared by the server and the CLI (DOR-293 PR-B).
 *
 * This is the security-critical layer. Crash reports go to a **third party**
 * (Sentry or a self-hosted GlitchTip, which speaks the same protocol), so the
 * event is built by an **allowlist**: only the fields defined here are ever
 * sent. The raw error message is never sent (it is free-form and could carry
 * session content or prompts); we send the error type plus a stack scrubbed to
 * repo-relative filenames, with home directories, absolute paths, and
 * secret-shaped tokens stripped before anything leaves the machine. There is
 * deliberately no full Sentry SDK — a minimal reporter lets us allowlist by
 * construction (rather than denylist the SDK's large auto-captured surface) and
 * keeps the CLI bundle small. See ADR 260711-153307.
 *
 * Environment-agnostic and pure except {@link sendErrorEvent} (uses `fetch`):
 * every input is passed in, so the same code runs in the server and the CLI and
 * is exhaustively testable. Nothing here reads config, env, or the filesystem.
 *
 * @module error-report
 */

/** A DSN parsed into the pieces needed to build the ingest URL and auth header. */
export interface ParsedDsn {
  /** The Sentry/GlitchTip envelope ingest URL. */
  ingestUrl: string;
  /** The public key (DSN username) used in the auth header. */
  publicKey: string;
  /** The numeric project id (last path segment of the DSN). */
  projectId: string;
}

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
  surface: 'server' | 'cli';
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
  // Backstop: strip any remaining home dir, then never return an absolute path,
  // a Windows drive path, or a home-relative path (all can carry the leading
  // dirs a project/client name lives in) — collapse those to the basename.
  f = redactPaths(f);
  if (/^([A-Za-z]:|\/|~)/.test(f)) {
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
      function: frame.function,
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

/**
 * Parse a Sentry/GlitchTip DSN into its ingest URL, public key, and project id.
 * Returns `null` for anything malformed so callers can no-op safely.
 *
 * DSN form: `https://<publicKey>@<host>[/<path>]/<projectId>`.
 *
 * @param dsn - The DSN string (from `SENTRY_DSN` or config).
 */
export function parseDsn(dsn: string): ParsedDsn | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const publicKey = url.username;
  if (!publicKey) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!projectId) return null;
  const prefix = segments.length > 0 ? `/${segments.join('/')}` : '';
  const ingestUrl = `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`;
  return { ingestUrl, publicKey, projectId };
}

/**
 * Send a built {@link ErrorEvent} to the DSN's envelope endpoint. Best-effort:
 * any failure (bad DSN, network error, non-2xx) is swallowed — error reporting
 * must never itself crash the process or surface to the user.
 *
 * @param event - The allowlisted, already-scrubbed event.
 * @param dsn - The Sentry/GlitchTip DSN.
 */
export async function sendErrorEvent(event: ErrorEvent, dsn: string): Promise<void> {
  const parsed = parseDsn(dsn);
  if (!parsed) return;
  const header = { event_id: event.event_id, sent_at: new Date().toISOString(), dsn };
  const itemHeader = { type: 'event' as const, content_type: 'application/json' };
  const envelope = `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(event)}\n`;
  try {
    await fetch(parsed.ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_client=${SDK_NAME}/${event.release}, sentry_key=${parsed.publicKey}`,
      },
      body: envelope,
    });
  } catch {
    // Telemetry must never fail user operations.
  }
}
