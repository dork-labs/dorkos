import { createConsola, type LogObject } from 'consola';
import fs from 'fs';
import path from 'path';
import { currentDispatchId } from './dispatch-context.js';
import { normalizeLogContext } from './serialize-error.js';

/**
 * Central logger module for DorkOS server.
 *
 * Provides a singleton logger backed by consola. Before `initLogger()` is called,
 * the logger outputs to console only at info level. After `initLogger()`, it also
 * appends structured NDJSON entries to `{DORK_HOME}/logs/dorkos.log` with automatic
 * daily rotation and configurable size-based rotation.
 *
 * @module lib/logger
 */

const DEFAULT_MAX_LOG_SIZE = 500 * 1024; // 500KB
const DEFAULT_MAX_LOG_FILES = 14;

// Module-scoped mutable state, set by initLogger()
let logDir: string | undefined;
let logFile: string | undefined;
let maxLogSize = DEFAULT_MAX_LOG_SIZE;
let maxLogFiles = DEFAULT_MAX_LOG_FILES;
let configuredLevel = 3; // info

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
        fs.appendFileSync(logFile, entry + '\n');
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

/** Format a date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Rotate log file using dual triggers: date change and size threshold.
 *
 * - If `dorkos.log` mtime is from a previous day, rename to `dorkos.YYYY-MM-DD.log`
 * - If `dorkos.log` exceeds maxLogSize, rename to `dorkos.YYYY-MM-DD.N.log`
 * - Cleanup: delete rotated files beyond maxLogFiles
 *
 * Errors during rotation are silently ignored to avoid crashing on startup.
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
    } else if (stat.size > maxLogSize) {
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

/** Delete rotated log files beyond maxLogFiles. */
function cleanupOldFiles(): void {
  if (!logDir) return;
  try {
    const files = fs
      .readdirSync(logDir)
      .filter((f) => /^dorkos\.\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f))
      .sort()
      .reverse();
    for (const old of files.slice(maxLogFiles)) {
      fs.unlinkSync(path.join(logDir, old));
    }
  } catch {
    // Cleanup failure is non-fatal
  }
}

/** Default logger instance (console-only until initLogger is called). */
export let logger = createConsola({
  level: 3, // info
});

/**
 * Initialize the logger with file persistence and configured log level.
 * Call once at server startup after config is loaded.
 *
 * @param options - Configuration options
 * @param options.logDir - Log directory path (required).
 * @param options.level - Numeric log level (0=fatal … 5=trace). Defaults to 4 (debug) in dev, 3 (info) in production.
 * @param options.maxLogSize - Max log file size in bytes before rotation. Defaults to 500KB.
 * @param options.maxLogFiles - Max number of rotated log files to retain. Defaults to 14.
 */
export function initLogger(options: {
  logDir: string;
  level?: number;
  maxLogSize?: number;
  maxLogFiles?: number;
}): void {
  logDir = options.logDir;
  logFile = path.join(logDir, 'dorkos.log');
  maxLogSize = options?.maxLogSize ?? DEFAULT_MAX_LOG_SIZE;
  maxLogFiles = options?.maxLogFiles ?? DEFAULT_MAX_LOG_FILES;

  fs.mkdirSync(logDir, { recursive: true });
  rotateIfNeeded();

  const level = options?.level ?? (process.env.NODE_ENV === 'production' ? 3 : 4);
  configuredLevel = level;

  logger = createConsola({ level });
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
 */
export function logError(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) return { error: err.message, stack: err.stack };
  return { error: String(err) };
}
