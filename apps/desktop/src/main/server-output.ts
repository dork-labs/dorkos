import { scrubMessage } from '@dorkos/shared/error-report';

/**
 * The child server's stderr, made safe and short enough to show a person.
 *
 * A server that refuses to start writes the actionable sentence here — a data
 * directory another process already holds, a failed migration, a port it could
 * not bind — and then exits. The shell's job is to get that in front of the
 * user instead of an exit code, without letting the rest of the stream come
 * along for the ride.
 *
 * Kept apart from `server-spawn.ts` because the modules that show this text
 * have no business importing the module that spawns processes.
 */

/**
 * Lines kept from the start of the stream.
 *
 * A real boot failure is a reason line followed by a stack, and Node's default
 * `Error.stackTraceLimit` is 10 — so a pure tail would evict the only sentence
 * worth reading and show frames instead. The head is what guarantees the reason
 * survives.
 */
const STDERR_HEAD_LINES = 6;

/** Lines kept from the end of the stream, for whatever state came last. */
const STDERR_TAIL_LINES = 6;

/** Longest single line shown; the rest is truncated. */
const STDERR_LINE_MAX_CHARS = 200;

/**
 * Longest run of a single line this will hold on to, before or after its
 * newline arrives.
 *
 * Two problems, one bound. A child that ends its lines with `\r` (progress
 * output) or emits one enormous record would otherwise grow the carried
 * partial for the whole life of the server, in a module whose contract is a
 * *bounded* view. And `scrubMessage` runs regexes that backtrack
 * superlinearly on a long unbroken run of word characters — ~0.06 ms at 200
 * characters but ~100 ms at 6400 — which would be spent blocking the main
 * process, the thread that draws the UI.
 *
 * Overflow past this is discarded rather than flushed as its own line: a
 * flush would split a line mid-token and hand the halves to `scrubMessage`
 * separately, which is exactly the chunk-boundary hole this module carries a
 * partial to avoid. Discarding is safe because the budget is well past
 * {@link STDERR_LINE_MAX_CHARS} — nothing beyond it could ever be displayed,
 * even after redaction shortens what precedes it.
 */
const MAX_RAW_LINE_CHARS = 512;

/**
 * A stack frame (`    at fn (/path/file.js:1:2)`).
 *
 * Dropped on the way in: frames are the bulk of a crash dump and the least
 * useful thing to put in a dialog. `electron-log` still receives the whole
 * trace for whoever needs it.
 */
const STACK_FRAME = /^\s*at\s/;

/** A bounded, redacted view of a child's stderr output. */
export interface StderrTail {
  /** Absorb a raw stderr chunk, which may begin or end mid-line. */
  record(chunk: string): void;
  /**
   * The kept lines, oldest first, with an elision marker if any were dropped.
   *
   * **Consumes any unterminated final line** — this is a getter with a side
   * effect, deliberately, because a process that dies mid-sentence still owes
   * us that sentence. That makes it safe only at a terminal moment: every
   * caller today reads it as the child is going away, on an exit or right
   * before a kill.
   *
   * Do not poll it on a live server. Taking a half-written line early leaves
   * its remainder to be assembled and scrubbed as a separate line, which is
   * the chunk-boundary hole this type exists to close, reopened through the
   * read path.
   */
  lines(): string[];
}

/**
 * Keep the beginning and the end of the child's stderr, dropping the middle.
 *
 * Chunk boundaries do not respect lines: one logical line can arrive as two
 * `data` events, and splitting each chunk independently would cut a token in
 * half so that neither piece looks secret-shaped any more. The trailing partial
 * is therefore carried until its newline arrives, and redaction only ever runs
 * on whole lines.
 */
export function createStderrTail(): StderrTail {
  const head: string[] = [];
  const tail: string[] = [];
  let dropped = 0;
  let partial = '';

  const accept = (raw: string): void => {
    const line = raw.trim();
    if (!line || STACK_FRAME.test(raw)) return;
    const safe = scrubMessage(line);
    const capped =
      safe.length > STDERR_LINE_MAX_CHARS ? `${safe.slice(0, STDERR_LINE_MAX_CHARS)}…` : safe;
    if (head.length < STDERR_HEAD_LINES) {
      head.push(capped);
      return;
    }
    tail.push(capped);
    if (tail.length > STDERR_TAIL_LINES) {
      tail.shift();
      dropped += 1;
    }
  };

  /** Add to the line being assembled, up to {@link MAX_RAW_LINE_CHARS}. */
  const grow = (text: string): void => {
    if (partial.length >= MAX_RAW_LINE_CHARS) return;
    partial = (partial + text).slice(0, MAX_RAW_LINE_CHARS);
  };

  return {
    record(chunk: string) {
      let rest = chunk;
      for (;;) {
        const newline = rest.indexOf('\n');
        if (newline === -1) {
          // No newline yet: the line is still being written. Hold it — a
          // chunk can end mid-token, and scrubbing half a token finds
          // nothing.
          grow(rest);
          return;
        }
        grow(rest.slice(0, newline));
        accept(partial);
        partial = '';
        rest = rest.slice(newline + 1);
      }
    },
    lines() {
      // A dying process often never terminates its last line, and this is the
      // moment someone is asking what it said. Take it.
      if (partial.trim()) {
        accept(partial);
        partial = '';
      }
      if (dropped === 0) return [...head, ...tail];
      return [...head, `… ${dropped} more line${dropped === 1 ? '' : 's'} …`, ...tail];
    },
  };
}

/**
 * Render a stderr tail for a person to read, or `''` when the child said
 * nothing.
 *
 * Deliberately not parsed, matched on, or reworded — a server that refuses to
 * boot has already written the actionable sentence, and the surest way to get
 * it wrong is to try to improve it. The one thing done to it is
 * {@link scrubMessage}, this repo's shared redactor, because the text reaches a
 * dialog someone may screenshot.
 *
 * @param lines - The kept lines, oldest first.
 */
export function formatServerOutput(lines: string[]): string {
  return lines.length > 0 ? `The server reported:\n${lines.join('\n')}` : '';
}
