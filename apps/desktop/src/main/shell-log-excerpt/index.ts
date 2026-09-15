import { ipcMain } from 'electron';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import log from 'electron-log';
import { redactPaths, redactTokens } from '@dorkos/shared/error-report';
import { MAX_LOG_EXCERPT_LEN } from '@dorkos/shared/telemetry-events';
import { isCockpitSender } from '../window-manager';

/**
 * The shell's own recent log, for a bug report filed from the desktop app
 * (DOR-2045).
 *
 * Two renderer reload loops shipped nine days apart, and each was diagnosed only
 * because a person went and opened `main.log` by hand. Every report they filed
 * already carried the SERVER's log; none of them carried the log of the process
 * that was doing the reloading, because the server child does not run in the
 * Electron main process and cannot see that file at all. So the shell gathers
 * this one and the client carries it — the single exception to the feedback
 * route's rule that the server authors the diagnostics, written down at that
 * call site too.
 *
 * **What it deliberately leaves out.** Everything the server child writes is
 * forwarded into this same file, and on a real install that is most of it. The
 * same report already carries the server's own log as `serverLogExcerpt`,
 * gathered from the structured NDJSON where the levels mean what they say, so
 * re-sending the child's stream here would duplicate it and displace the
 * shell's own lines.
 *
 * The forwarder marks those lines `[server:stdout]` / `[server:stderr]`
 * (`server-spawn.ts`) precisely so this filter can find them. **A plain
 * `[server]` line is the shell's own prose and is kept** — twelve call sites
 * write one, including "The server stopped unexpectedly" and "Restarting the
 * server failed", which are exactly the lines a desktop bug report is filed
 * about. Dropping those was a real defect, caught in review: the tag looked
 * like the forwarder's and was not.
 *
 * **Why `info` and not `warn`.** The sibling excerpt in `log-excerpt.ts` keeps
 * `warn` and above, which is right for the server and wrong here: the
 * `[renderer]` lines that name the cause of a reload loop are written at `info`,
 * so a warn-and-above filter returns everything except the answer. Raising those
 * lines to `warn` so such a filter would catch them was considered and rejected
 * — a level is a claim about severity, and "a new page started loading" is not a
 * warning.
 *
 * The cost of that choice is volume, and it is real: on the operator's own
 * machine this filter keeps roughly 7,000 of 11,700 lines, most of them
 * `[permissions]`. {@link MAX_LOG_EXCERPT_LEN} is what actually bounds the
 * result, and it keeps the newest end. (Some of that volume is unit-test output
 * written into the real log, DOR-2042, which also polluted the sample the
 * original info-vs-warn measurement was taken on — the conclusion survives
 * because it rests on WHICH lines carry the cause, not on how many there are.)
 *
 * Nothing here may throw. A missing file, an unreadable directory or a line in a
 * shape this does not know all end as `undefined`, because none of them is a
 * reason to fail a bug report someone is trying to send.
 *
 * @module main/shell-log-excerpt/index
 */

/**
 * How many shell-authored entries a bug report carries, newest last.
 *
 * A ceiling, not the usual bound: at any realistic line length 200 entries
 * exceed {@link MAX_LOG_EXCERPT_LEN}, so the character cap is what normally
 * decides (a default run against the operator's real log returned 87 lines, cut
 * by the character cap). This one matters for a log of unusually short lines,
 * and keeps the work bounded regardless.
 */
export const DEFAULT_SHELL_EXCERPT_MAX_LINES = 200;

/** How far back (from now) an entry may be to qualify: 30 minutes. */
export const DEFAULT_SHELL_EXCERPT_MAX_AGE_MS = 30 * 60 * 1000;

/** IPC channel the renderer asks for the excerpt on (mirrored in `preload/index.ts`). */
export const SHELL_LOG_EXCERPT_CHANNEL = 'shell:log-excerpt';

/**
 * How much of each log file's tail is read.
 *
 * electron-log rotates `main.log` at 1 MiB, so half of that is a generous window
 * on the live file and still a ceiling rather than an assumption. A bound is the
 * point: this runs on the thread that draws the UI, at the moment a person
 * presses Send, so slurping a whole rotation's worth and parsing it is a pause
 * they would feel.
 *
 * Deliberately not `LOG_TAIL_BYTES` from `../diagnostics/index.ts`, though it means
 * the same kind of thing: importing it would drag the archive builder — and
 * through it `server-process.ts` and the updater — into a leaf that the feedback
 * path calls on every desktop bug report.
 */
const SHELL_LOG_TAIL_BYTES = 512 * 1024;

/** Levels kept, in the order electron-log names them. Below `info` is noise here. */
const KEPT_LEVELS = new Set(['error', 'warn', 'info']);

/**
 * One line of electron-log's file format:
 * `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}`.
 *
 * Applied to lines already split on `\r?\n`, because the transport ends them
 * with `os.EOL`: on Windows that is `\r\n`, and a trailing `\r` left on every
 * line matches nothing here, which returned an empty excerpt on that platform
 * for every report (caught in review).
 *
 * The timestamp carries no zone, which is correct rather than a gap:
 * `new Date('2026-09-14 15:25:25.123')` parses as local time, which is the
 * timezone the transport wrote it in. No conversion is needed here and none may
 * be added.
 */
const ENTRY_LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[([a-z]+)\][ \t]*(.*)$/;

/**
 * Prefix the forwarder stamps on a line it relayed from the server child
 * (`[server:stdout]`, `[server:stderr]`) — mirrors `server-spawn.ts`.
 *
 * Matched as a PREFIX rather than as either whole tag, so a third stream added
 * later is filtered without a second edit here. It deliberately does not match
 * the shell's own `[server]` prose, which has no colon.
 */
const FORWARDED_OUTPUT_TAG = '[server:';

/**
 * How many unparsed lines may attach to one entry.
 *
 * A line that does not match {@link ENTRY_LINE} is a continuation — almost
 * always a stack frame, which is the half of an error that says where it
 * happened. Node's default `Error.stackTraceLimit` is 10, so twenty leaves room
 * for a cause chain and still refuses to let one pathological entry eat the
 * whole excerpt.
 */
const MAX_CONTINUATION_LINES = 20;

/** One parsed log entry: its first line, plus whatever wrapped onto the next ones. */
interface ShellLogEntry {
  /** Epoch milliseconds the entry was written, from its local-time stamp. */
  at: number;
  /** The stamp exactly as the transport wrote it, so the excerpt reads like the file. */
  timestamp: string;
  /** electron-log's level name. */
  level: string;
  /** Everything after the level — the tag, if any, and the message. */
  text: string;
  /** Continuation lines (stack frames), verbatim and in order. */
  continuations: string[];
}

/**
 * Read at most `maxBytes` from the end of a file.
 *
 * The tail rather than the head, for the reason the diagnostics archive gives:
 * the interesting part of a log is what happened just before the person gave up.
 * The first line of the result is usually cut mid-sentence, which costs nothing
 * — it fails {@link ENTRY_LINE} and is dropped as a continuation with nothing to
 * continue.
 *
 * @param filePath - Absolute path of the file to read.
 * @param maxBytes - Ceiling on how much to return.
 * @returns The decoded tail, or `''` when the file cannot be read.
 */
function readTail(filePath: string, maxBytes: number): string {
  let handle: number;
  try {
    handle = openSync(filePath, 'r');
  } catch {
    // No such file (a fresh install, a rotation that has not happened yet), or
    // no permission to read it.
    return '';
  }
  try {
    const { size } = fstatSync(handle);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    // Sliced to what was actually read: the file is live, and a rotation between
    // the `fstat` and the read would otherwise leave the tail as the zeroes
    // `alloc` put there.
    const bytesRead = readSync(handle, buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(handle);
  }
}

/**
 * Parse a log file's text into entries, attaching continuation lines to the
 * entry above them.
 *
 * @param contents - Raw file text, oldest line first.
 */
function parseEntries(contents: string): ShellLogEntry[] {
  const entries: ShellLogEntry[] = [];
  // `\r?\n`, not `\n`: electron-log writes `os.EOL`, so on Windows the separator
  // is `\r\n` and splitting on `\n` alone leaves a `\r` on the end of every line.
  for (const raw of contents.split(/\r?\n/)) {
    const match = ENTRY_LINE.exec(raw);
    if (match) {
      const [, timestamp, level, text] = match;
      entries.push({
        at: new Date(timestamp).getTime(),
        timestamp,
        level,
        text,
        continuations: [],
      });
      continue;
    }
    if (!raw.trim()) continue;
    // A continuation of the entry above — or, for the partial first line a tail
    // read starts on, a continuation of nothing, which is dropped.
    const current = entries[entries.length - 1];
    if (current && current.continuations.length < MAX_CONTINUATION_LINES) {
      // A lone trailing `\r` survives the split only on a final line with no
      // newline after it; stripped so a Windows excerpt is byte-identical.
      current.continuations.push(raw.replace(/\r$/, ''));
    }
  }
  return entries;
}

/**
 * Keep the entries a bug report is for: the shell's own, at `info` and above,
 * inside the recency window.
 *
 * @param entries - Parsed entries, oldest first.
 * @param cutoffMs - The oldest instant (epoch ms) still worth carrying.
 */
function keepShellAuthored(entries: ShellLogEntry[], cutoffMs: number): ShellLogEntry[] {
  return entries.filter(
    (entry) =>
      !entry.text.startsWith(FORWARDED_OUTPUT_TAG) &&
      KEPT_LEVELS.has(entry.level) &&
      Number.isFinite(entry.at) &&
      entry.at >= cutoffMs
  );
}

/**
 * Any `http(s)` URL, up to the first character that cannot be part of one.
 *
 * Intentionally greedy about the tail: everything from the `?` or `#` onward is
 * thrown away, so the pattern only has to find where a URL starts.
 */
const HTTP_URL = /\bhttps?:\/\/[^\s<>"'`]+/g;

/**
 * Drop the query string and fragment from every URL in `text`, keeping the
 * scheme, host and path.
 *
 * The shell logs URLs it did not write: `permissions/index.ts` records the page
 * that asked for a permission, and in the canvas browser that is any site the
 * person opened. Their query strings carry session ids, account numbers, search
 * terms and — measured in review — OAuth credentials. `redactTokens` catches
 * the credential shapes it knows; this removes the whole class ahead of it,
 * because the query string is never the part of a URL a bug report needs.
 *
 * Runs BEFORE {@link redactPaths}, whose `/…/…` rules would otherwise chew a
 * URL's path into a relative-looking fragment.
 *
 * @param text - Lines already joined, before any other scrubbing.
 */
function stripUrlQueries(text: string): string {
  return text.replace(HTTP_URL, (url) => url.replace(/[?#].*$/, ''));
}

/**
 * Render one entry the way `log-excerpt.ts` renders the server's: `time level
 * text`, with its continuation lines underneath, unchanged.
 *
 * The timestamp is passed through exactly as the transport wrote it — local
 * time, no zone — so a line in the report can be found in `main.log` by looking
 * for it, which is the whole point of shipping the excerpt.
 */
function formatEntry(entry: ShellLogEntry): string {
  return [`${entry.timestamp} ${entry.level} ${entry.text}`.trim()]
    .concat(entry.continuations)
    .join('\n');
}

/**
 * Gather a bounded, scrubbed excerpt of the shell's own recent log lines.
 *
 * Reads the tail of the live `main.log` and, when that comes back thin, folds in
 * the rotated `main.old.log` ahead of it — electron-log rotates at 1 MiB, so a
 * report filed just after a rotation would otherwise see almost nothing.
 *
 * Never throws; see the module doc for why that is load-bearing rather than
 * defensive.
 *
 * @param maxLines - How many entries to keep, newest last. Defaults to
 *   {@link DEFAULT_SHELL_EXCERPT_MAX_LINES}.
 * @param maxAgeMs - How far back (from now) an entry may be to qualify. Defaults
 *   to {@link DEFAULT_SHELL_EXCERPT_MAX_AGE_MS}.
 * @returns The scrubbed, bounded excerpt, or `undefined` when there is no log
 *   file, or nothing in it the report wants. Scrubbed means home directories
 *   and absolute paths removed, URL queries and fragments dropped, and known
 *   token shapes replaced — a filter over free-form prose, not a proof that
 *   nothing sensitive can survive it.
 */
export function getShellLogExcerpt(
  maxLines: number = DEFAULT_SHELL_EXCERPT_MAX_LINES,
  maxAgeMs: number = DEFAULT_SHELL_EXCERPT_MAX_AGE_MS
): string | undefined {
  let livePath: string;
  try {
    livePath = log.transports.file.getFile().path;
  } catch {
    // The transport has no file — logging to disk is off, or the directory could
    // not be created. There is nothing to excerpt and nothing to report about it.
    return undefined;
  }

  try {
    const cutoffMs = Date.now() - maxAgeMs;
    let kept = keepShellAuthored(parseEntries(readTail(livePath, SHELL_LOG_TAIL_BYTES)), cutoffMs);

    if (kept.length < maxLines) {
      const rotated = readTail(join(dirname(livePath), 'main.old.log'), SHELL_LOG_TAIL_BYTES);
      kept = [...keepShellAuthored(parseEntries(rotated), cutoffMs), ...kept];
    }

    if (kept.length === 0) return undefined;

    const scrubbed = redactTokens(
      redactPaths(stripUrlQueries(kept.slice(-maxLines).map(formatEntry).join('\n')))
    );

    // Cut from the FRONT with a leading ellipsis, exactly as `log-excerpt.ts`
    // does and for the same reason (DOR-1976): the slice above has already
    // decided the newest entries are the ones worth keeping, and a report is
    // filed about the moment at the END of the log. One character is reserved
    // for the ellipsis so a truncated excerpt never exceeds the schema bound.
    return scrubbed.length > MAX_LOG_EXCERPT_LEN
      ? `…${scrubbed.slice(-(MAX_LOG_EXCERPT_LEN - 1))}`
      : scrubbed;
  } catch {
    return undefined;
  }
}

/**
 * Register the channel the preload bridge asks for the excerpt on.
 *
 * Call once, before the window is created, alongside the other IPC setup in
 * `index.ts`.
 *
 * **Who may ask.** Only a page on the app's own origin, through the same
 * predicate the link guards and the permission policy use. That is a weaker gate
 * than the three recovery actions get (`isFallbackPageSender`), and deliberately
 * so: the feedback dialog lives in the app's own page, not on the recovery page.
 * Marketplace extension code runs as ordinary modules in that page and can
 * therefore reach this — already true of every bridge method, and a scrubbed
 * 8,000-character log tail is a lower-value target than the diagnostics archive
 * the recovery page can already write to the Desktop.
 *
 * **What "scrubbed" does and does not promise.** Home directories and absolute
 * paths are removed structurally, URL queries and fragments are dropped whole,
 * and token shapes `redactTokens` knows are replaced. It is a filter over
 * free-form prose, not a proof: a secret in a shape nothing recognises, inside
 * a message some other module chose to log, can still come through. That is the
 * same guarantee the server's own excerpt gives, and it is why this is attached
 * only to a report a person deliberately sent.
 *
 * @param getRendererUrl - Live accessor for the app's own origin, shared with
 *   the windows themselves so "is this our own page?" has one answer. Read fresh
 *   on every call: the server's port moves across a restart.
 */
export function registerShellLogExcerptHandler(getRendererUrl: () => string | undefined): void {
  ipcMain.handle(SHELL_LOG_EXCERPT_CHANNEL, (event): string | undefined => {
    try {
      // Inside the `try` on purpose: this reads `event.sender.getURL()`, which
      // throws on a webContents being torn down.
      if (!isCockpitSender(event, getRendererUrl)) return undefined;
    } catch {
      return undefined;
    }
    return getShellLogExcerpt();
  });
}
