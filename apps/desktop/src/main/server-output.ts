/**
 * The child server's stderr, made safe to show a person.
 *
 * A server that refuses to start writes the actionable sentence here — a data
 * directory already held by a `dorkos` CLI server, a failed migration, a port
 * it could not bind — and then exits. The shell's job is to get that in front
 * of the user instead of an exit code, without letting the rest of the stream
 * (which carries normal operational logging) come along for the ride.
 *
 * Kept apart from `server-spawn.ts` because the modules that show this text
 * have no business importing the module that spawns processes.
 */

/**
 * How many of the child's most recent stderr lines to keep.
 *
 * Enough to carry a refusal-to-boot message and its context, few enough that a
 * dialog stays readable — the server logs to this stream in normal operation
 * too, so most of what passes through is noise nobody needs to see.
 */
const STDERR_TAIL_LINES = 8;

/** Longest single stderr line kept; the rest is truncated. */
const STDERR_LINE_MAX_CHARS = 200;

/**
 * Shapes that must never reach a dialog, even though the server writes them to
 * this stream in normal operation (it logs a generated MCP token path at every
 * boot, for one).
 *
 * This is a safety net on delivery, not an attempt to understand the message.
 * Everything else is passed through verbatim: the server owns that copy, and
 * the desktop shell owns only getting it in front of the user.
 */
const SECRET_SHAPED = [
  // DorkOS API keys: `dork_` followed by a long hex run.
  /\bdork_[0-9a-f]{8,}\b/gi,
  // Bearer tokens, auth secrets, instance tokens — a long unbroken run of the
  // token alphabet. Prose and file paths break well before this length.
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

/** A bounded, redacted view of a child's most recent stderr output. */
export interface StderrTail {
  record(chunk: string): void;
  lines(): string[];
}

/** Replace anything secret-shaped in `line` with a marker. */
function redactSecrets(line: string): string {
  return SECRET_SHAPED.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), line);
}

/** Ring buffer over the child's stderr, redacted and truncated on the way in. */
export function createStderrTail(): StderrTail {
  const kept: string[] = [];
  return {
    record(chunk: string) {
      for (const raw of chunk.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const safe = redactSecrets(line);
        kept.push(
          safe.length > STDERR_LINE_MAX_CHARS ? `${safe.slice(0, STDERR_LINE_MAX_CHARS)}…` : safe
        );
        if (kept.length > STDERR_TAIL_LINES) kept.shift();
      }
    },
    lines: () => [...kept],
  };
}

/**
 * Render a stderr tail for a person to read, or `''` when the child said
 * nothing.
 *
 * Deliberately not parsed, matched on, or reworded — a server that refuses to
 * boot has already written the actionable sentence, and the only way to get it
 * wrong is to try to improve it.
 *
 * @param lines - The tail, most recent last.
 */
export function formatServerOutput(lines: string[]): string {
  return lines.length > 0 ? `The server reported:\n${lines.join('\n')}` : '';
}
