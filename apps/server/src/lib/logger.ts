import { createConsola, type ConsolaInstance, type ConsolaReporter, type LogObject } from 'consola';
import fs from 'fs';
import path from 'path';
import { currentDispatchId } from './dispatch-context.js';
import { clipFlattenedError, clipLogArgs, normalizeLogContext } from './serialize-error.js';

/**
 * Central logger module for DorkOS server.
 *
 * Provides a singleton logger backed by consola. Before `initLogger()` is called,
 * the logger outputs to console only at info level. After `initLogger()`, it also
 * appends structured NDJSON entries to `{DORK_HOME}/logs/dorkos.log` with automatic
 * daily rotation and configurable size-based rotation, both checked as lines are
 * written.
 *
 * @module lib/logger
 */

const DEFAULT_MAX_LOG_SIZE = 500 * 1024; // 500KB
const DEFAULT_MAX_LOG_FILES = 14;
/**
 * The most the rotated logs may hold on disk together. Rotation runs while the
 * server is up (DOR-2902), so a busy day makes many files; the day count keeps
 * the history, and this keeps it from filling a disk.
 */
const DEFAULT_MAX_ROTATED_LOG_BYTES = 200 * 1024 * 1024;

// Module-scoped mutable state, set by initLogger()
let logDir: string | undefined;
let logFile: string | undefined;
let maxLogSize = DEFAULT_MAX_LOG_SIZE;
let maxLogFiles = DEFAULT_MAX_LOG_FILES;
let maxRotatedLogBytes = DEFAULT_MAX_ROTATED_LOG_BYTES;
let configuredLevel = 3; // info

// The open log file (DOR-2902). Opening, appending and closing the file for
// every line cost about 25 µs a line against about 1 µs through a handle kept
// open, all of it on the event loop. Writes stay synchronous on purpose: a line
// written just before a crash is the line somebody needs.
let fd: number | undefined;
/** Bytes in the open file, counted as they are written. */
let fileBytes = 0;
/** The UTC day the open file belongs to. */
let fileDay: string | undefined;
/** Size at which the open file is next rotated; moves on if a rotation fails. */
let rotateAtBytes = DEFAULT_MAX_LOG_SIZE;
let linesSinceIdentityCheck = 0;
/** How often the open handle is checked against the path, in lines. */
const IDENTITY_CHECK_LINES = 500;

/**
 * Create an NDJSON file reporter that appends structured log entries to disk.
 *
 * Two things happen here that happen nowhere else, and both are retrofits — they
 * give hundreds of existing call sites a field they never asked for:
 *
 * 1. **The ambient dispatch id.** If a dispatch is in scope, every line written
 *    inside it carries `dispatchId` without the call site mentioning it. The
 *    read happens only when a line is actually written — after the level filter
 *    — so a suppressed `debug` costs nothing.
 * 2. **The tag.** `logObj.tag` (set by `createTaggedLogger`) is populated on
 *    three call sites in the whole server; the `'[tag] message'` string prefix
 *    is used by hundreds. Lifting the prefix into the field is what makes
 *    `jq 'select(.tag=="rooms")'` match anything at all.
 *
 * An explicit `dispatchId` in a call site's context object wins over the ambient
 * one, so a caller that legitimately logs about a DIFFERENT dispatch is not
 * silently mislabelled. Same for an explicit `tag`.
 *
 * The context is passed through `normalizeLogContext` on the way in, because
 * spreading an Error yields `{}` — see `lib/serialize-error.ts` (DOR-802).
 *
 * Nothing here may throw back at the caller. Most of these call sites are inside
 * a `catch` block, so a reporter that throws replaces the failure being reported
 * with one of its own — and a context object can still defeat serialization
 * (a cycle, a getter that throws). Those lines degrade to a line that names the
 * serialization failure instead of disappearing.
 */
function createFileReporter() {
  return {
    log(logObj: LogObject) {
      if (!logFile) return;
      // Respect the configured log level — skip entries above the threshold
      if (logObj.level > configuredLevel) return;

      const time = logObj.date.toISOString();
      // Declared out here so the fallback line below can still use whatever
      // message text was assembled before something threw.
      const msgParts: string[] = [];
      let entry: string;

      try {
        // Separate structured context objects from string message parts
        let context: Record<string, unknown> | undefined;
        for (const arg of logObj.args) {
          if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
            context = arg as Record<string, unknown>;
          } else {
            msgParts.push(String(arg));
          }
        }

        const dispatchId = currentDispatchId();
        entry = JSON.stringify({
          level: logObj.type,
          time,
          msg: msgParts.join(' '),
          tag: logObj.tag || extractTag(msgParts[0]),
          ...(dispatchId !== undefined ? { dispatchId } : {}),
          ...(context !== undefined ? normalizeLogContext(context) : {}),
        });
      } catch (err) {
        entry = JSON.stringify({
          level: logObj.type,
          time,
          msg: msgParts.join(' '),
          tag: logObj.tag || extractTag(msgParts[0]),
          logSerializationError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }

      try {
        writeLogLine(entry + '\n', formatDate(new Date()));
      } catch {
        // A log that cannot be written is not worth taking the caller down for.
      }
    },
  };
}

/**
 * A leading `[tag]` in a log message, for the NDJSON `tag` field.
 *
 * Anchored and character-bounded, which excludes exactly one shape worth naming:
 * the `[object Object]` a stringified argument produces has a space inside the
 * brackets, so it never matches.
 *
 * **A date WOULD match** — `[2026-07-31] …` yields `tag: "2026-07-31"`, because
 * a hyphen is a legal tag character (`[stall-guard]`) and there is no way to
 * exclude one without excluding the other. That is left alone rather than
 * special-cased: no logger call site in the server, relay or mesh opens with a
 * bracketed date, so the rule would be machinery guarding nothing, and a
 * date-shaped `tag` on a line nobody writes is a harmless outcome next to a
 * pattern the next reader has to decode.
 *
 * The message itself is left untouched either way — the tag stays where every
 * existing `grep` expects to find it, and gains a field where `jq` can reach it.
 */
const TAG_PREFIX_PATTERN = /^\[([a-zA-Z0-9:_-]+)\]\s/;

/**
 * Lift a leading `[tag]` out of a message.
 *
 * @param message - The first string argument of the log call, if there was one.
 * @returns The tag, or `undefined` when the message does not open with one.
 */
function extractTag(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return TAG_PREFIX_PATTERN.exec(message)?.[1];
}

/**
 * Append one line to the log file through the open handle, rotating first when
 * the day has turned or the file has grown past its size. Rotation used to run
 * only at startup, so a server that stayed up wrote one file without limit (one
 * reached 53 MB).
 *
 * Every {@link IDENTITY_CHECK_LINES} lines the handle is checked against the
 * path: a file deleted or moved aside by somebody else is reopened, rather than
 * written to unseen. Somebody else is usually the CLI, whose `initLogger`
 * rotates at its own start; until the check, lines go to the renamed file,
 * which is kept like any rotated file.
 *
 * @param line - The NDJSON line, newline included.
 * @param day - Today's UTC day, `YYYY-MM-DD`, by the same clock that dated the
 *   open file.
 */
function writeLogLine(line: string, day: string): void {
  if (fd === undefined) {
    openLogFile();
  } else if (day !== fileDay || fileBytes >= rotateAtBytes) {
    closeLogFile();
    rotateIfNeeded();
    openLogFile();
  } else if (++linesSinceIdentityCheck >= IDENTITY_CHECK_LINES) {
    linesSinceIdentityCheck = 0;
    if (!handleStillAtPath()) {
      closeLogFile();
      openLogFile();
    }
  }
  if (fd === undefined) return;
  fs.writeSync(fd, line);
  fileBytes += Buffer.byteLength(line);
}

/** Open the log file for appending and take its size and day. */
function openLogFile(): void {
  if (!logFile) return;
  try {
    fd = fs.openSync(logFile, 'a');
    fileBytes = fs.fstatSync(fd).size;
  } catch {
    fd = undefined;
    fileBytes = 0;
  }
  fileDay = formatDate(new Date());
  // A file still over the size after a rotation was tried (the rename failed)
  // is tried again only after another full size, not on every line.
  rotateAtBytes = fileBytes >= maxLogSize ? fileBytes + maxLogSize : maxLogSize;
  linesSinceIdentityCheck = 0;
}

/** Close the open log file, if any. */
function closeLogFile(): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // Already gone; nothing to release.
  }
  fd = undefined;
}

/** Whether the open handle is still the file at the log path. */
function handleStillAtPath(): boolean {
  if (fd === undefined || !logFile) return false;
  try {
    return fs.statSync(logFile).ino === fs.fstatSync(fd).ino;
  } catch {
    return false;
  }
}

/** Format a date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Rotate log file using dual triggers: date change and size threshold.
 *
 * - If `dorkos.log` mtime is from a previous day, rename to `dorkos.YYYY-MM-DD.log`
 * - If `dorkos.log` exceeds maxLogSize, rename to `dorkos.YYYY-MM-DD.N.log`
 * - Cleanup: keep the newest maxLogFiles days, within a total size
 *
 * Runs at startup and again whenever a write finds the day turned or the file
 * full. Errors during rotation are silently ignored: logging carries on in the
 * file as it is.
 */
function rotateIfNeeded(): void {
  if (!logDir || !logFile) return;

  try {
    const stat = fs.statSync(logFile);
    const today = formatDate(new Date());
    const fileDate = formatDate(stat.mtime);
    let rotated = false;

    if (fileDate !== today) {
      // Date rotation: file is from a previous day
      const target = path.join(logDir, `dorkos.${fileDate}.log`);
      if (!fs.existsSync(target)) {
        fs.renameSync(logFile, target);
      } else {
        // Date file exists — find next sequence number
        const seq = nextSequenceNumber(fileDate);
        fs.renameSync(logFile, path.join(logDir, `dorkos.${fileDate}.${seq}.log`));
      }
      rotated = true;
    } else if (stat.size >= maxLogSize) {
      // Size rotation within same day
      const seq = nextSequenceNumber(today);
      fs.renameSync(logFile, path.join(logDir, `dorkos.${today}.${seq}.log`));
      rotated = true;
    }

    if (rotated) {
      cleanupOldFiles();
    }
  } catch {
    // File doesn't exist yet or rotation failed — continue
  }
}

/** Find the next sequence number for a given date's rotated files. */
function nextSequenceNumber(date: string): number {
  if (!logDir) return 1;
  try {
    const files = fs.readdirSync(logDir);
    const pattern = new RegExp(`^dorkos\\.${date}\\.(\\d+)\\.log$`);
    let max = 0;
    for (const f of files) {
      const m = f.match(pattern);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/** A file's size, or 0 when it is already gone. */
function sizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** A rotated log file's name, parsed: `dorkos.YYYY-MM-DD[.N].log`. */
const ROTATED_LOG_PATTERN = /^dorkos\.(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

/**
 * Delete rotated log files outside the newest `maxLogFiles` days, then the
 * oldest of the rest until they fit the total size (`maxRotatedLogBytes`, default
 * {@link DEFAULT_MAX_ROTATED_LOG_BYTES}).
 *
 * Ordered by the parsed day and sequence number, never by name: as text,
 * `.10.log` sorts before `.9.log`, so once a busy day passed ten rotations the
 * newest files were the ones deleted (DOR-2902 review).
 */
function cleanupOldFiles(): void {
  if (!logDir) return;
  try {
    const rotated = fs
      .readdirSync(logDir)
      .flatMap((name) => {
        const match = ROTATED_LOG_PATTERN.exec(name);
        // The undated-sequence file is the day's last: the midnight rename
        // comes after that day's size rotations.
        const seq = match?.[2] === undefined ? Infinity : Number(match[2]);
        return match ? [{ name, day: match[1]!, seq }] : [];
      })
      .sort((a, b) => (a.day === b.day ? b.seq - a.seq : a.day < b.day ? 1 : -1));
    const keptDays = new Set([...new Set(rotated.map((file) => file.day))].slice(0, maxLogFiles));
    let total = 0;
    for (const file of rotated) {
      const filePath = path.join(logDir, file.name);
      total += keptDays.has(file.day) ? sizeOf(filePath) : Infinity;
      if (total <= maxRotatedLogBytes) continue;
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Already gone; nothing to delete.
      }
    }
  } catch {
    // Cleanup failure is non-fatal
  }
}

/**
 * Wrap a reporter so an oversized payload is cut down before it is formatted.
 *
 * This wraps rather than replaces consola's console reporter, which is the
 * whole point: the reporter still does the formatting, so colours, level
 * badges, the tag, the terminal-width layout and the indented stack frames are
 * exactly what they were. Only the arguments handed to it are smaller.
 *
 * The clip runs per reporter on a COPY of the log object, never in place — the
 * file reporter is a separate reporter reading the same object, and it does its
 * own clipping on the way to the NDJSON line. Mutating here would hand it text
 * that had already been marked truncated once.
 *
 * Nothing here may throw: a reporter runs inside whatever `catch` block called
 * the logger, so a reporter that throws replaces the failure being reported
 * with one of its own. The walk already contains the everyday hazard — a
 * property whose getter throws costs only that property — so this `catch` is a
 * last resort for the exotic remainder (a Proxy that refuses to be enumerated,
 * a `Symbol.toPrimitive` that throws). It prints the line unclipped rather than
 * not at all, which is the right trade only because it is now genuinely rare.
 */
function withClipping(inner: ConsolaReporter): ConsolaReporter {
  return {
    log(logObj, ctx) {
      let args: unknown[];
      try {
        args = clipLogArgs(logObj.args as unknown[]);
      } catch {
        args = logObj.args as unknown[];
      }
      inner.log(args === logObj.args ? logObj : { ...logObj, args }, ctx);
    },
  };
}

/**
 * A consola instance whose console output is bounded (DOR-1728).
 *
 * @param level - Numeric log level (0=fatal … 5=trace).
 */
function createClippedConsola(level: number): ConsolaInstance {
  const instance = createConsola({ level });
  instance.setReporters(instance.options.reporters.map(withClipping));
  return instance;
}

/** Default logger instance (console-only until initLogger is called). */
export let logger = createClippedConsola(3); // info

/**
 * Initialize the logger with file persistence and configured log level.
 * Call once at server startup after config is loaded.
 *
 * @param options - Configuration options
 * @param options.logDir - Log directory path (required).
 * @param options.level - Numeric log level (0=fatal … 5=trace). Defaults to 4 (debug) in dev, 3 (info) in production.
 * @param options.maxLogSize - Max log file size in bytes before rotation. Defaults to 500KB.
 * @param options.maxLogFiles - How many days of rotated logs to keep. Defaults to 14.
 * @param options.maxRotatedLogBytes - The most those days may hold together; the
 *   oldest files go first. Defaults to 200 MB.
 */
export function initLogger(options: {
  logDir: string;
  level?: number;
  maxLogSize?: number;
  maxLogFiles?: number;
  maxRotatedLogBytes?: number;
}): void {
  closeLogFile();
  logDir = options.logDir;
  logFile = path.join(logDir, 'dorkos.log');
  maxLogSize = options?.maxLogSize ?? DEFAULT_MAX_LOG_SIZE;
  maxLogFiles = options?.maxLogFiles ?? DEFAULT_MAX_LOG_FILES;
  maxRotatedLogBytes = options?.maxRotatedLogBytes ?? DEFAULT_MAX_ROTATED_LOG_BYTES;

  fs.mkdirSync(logDir, { recursive: true });
  rotateIfNeeded();

  const level = options?.level ?? (process.env.NODE_ENV === 'production' ? 3 : 4);
  configuredLevel = level;

  logger = createClippedConsola(level);
  logger.addReporter(createFileReporter());
}

/** Get the resolved log directory path. Returns undefined if initLogger hasn't been called. */
export function getLogDir(): string | undefined {
  return logDir;
}

/** Create a child logger with a consistent component tag for NDJSON `tag` field. */
export function createTaggedLogger(tag: string) {
  return logger.withTag(tag);
}

/**
 * Extract structured error fields for consistent NDJSON logging.
 *
 * Handing the error straight to the logger — `logger.error(msg, err)` — now
 * writes the same `error` and `stack` fields on its own (DOR-802), so this is
 * for call sites that fold an error into a wider context object.
 *
 * The fields come back already clipped, because flattening an error into
 * strings here is what puts it out of reach of the clipping both reporters do
 * later — they can only bound what they can still recognise as an error
 * (DOR-1827). An error of ordinary size comes back untouched.
 */
export function logError(err: unknown): { error: string; stack?: string } {
  return clipFlattenedError(err);
}
