/**
 * Server log excerpt for bug reports (feedback-pipeline spec Part 2).
 *
 * Tails the current day's NDJSON log file (`getLogDir()`'s `dorkos.log`) and,
 * when that tail is thin, falls back to the most recently rotated file too —
 * the rotation-boundary case where a report filed just after midnight would
 * otherwise see almost nothing. Filters to `warn`+ severity and joins into a
 * single bounded string.
 *
 * **Scrubbing is mandatory before this ever leaves the process.** Log lines
 * are operator-facing today and not guaranteed PII-clean (unlike the
 * allowlisted `$exception` event), so every line runs through the same
 * `redactPaths`/`redactTokens` pair the crash-report pipeline already uses
 * (`@dorkos/shared/error-report`) before this function returns anything.
 *
 * Kept as a sibling of `logger.ts` (not inside it) so the write path stays
 * focused on writing; this module only reads. Called from the feedback route,
 * never the client — the client cannot read the log file itself.
 *
 * @module lib/log-excerpt
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { redactPaths, redactTokens } from '@dorkos/shared/error-report';
import { MAX_LOG_EXCERPT_LEN } from '@dorkos/shared/telemetry-events';

import { getLogDir } from './logger.js';

/** One parsed NDJSON log line, reduced to the fields this module reads. */
interface LogLine {
  level?: string;
  time?: string;
  msg?: string;
  tag?: string;
}

/** consola severities at or above `warn` — the only lines a bug report needs. */
const WARN_OR_ABOVE = new Set(['fatal', 'error', 'warn']);

/** Default number of matching lines {@link getRecentLogExcerpt} keeps (newest last). */
export const DEFAULT_LOG_EXCERPT_MAX_LINES = 200;

/** Default recency window {@link getRecentLogExcerpt} reads within: 30 minutes. */
export const DEFAULT_LOG_EXCERPT_MAX_AGE_MS = 30 * 60 * 1000;

/** Rotated log filenames, matching `rotateIfNeeded`'s naming in `logger.ts`. */
const ROTATED_LOG_FILENAME = /^dorkos\.\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/;

/** Parse one NDJSON line, or `undefined` when it is missing or not well-formed JSON. */
function parseLine(raw: string): LogLine | undefined {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as LogLine;
  } catch {
    return undefined;
  }
}

/**
 * Format one log line for the excerpt: `time level [tag] message`.
 *
 * **Known gap, recorded so it is not rediscovered as a bug.** Since DOR-802 the
 * NDJSON line also carries `error`, `stack` and the `cause` chain, and this
 * excerpt shows none of it — a bug report still says "Failed to load workspaces"
 * without the reason underneath. Widening it is not free: every added field goes
 * through the same scrubbing and competes for `MAX_LOG_EXCERPT_LEN`, and a raw
 * stack is a poor trade against the number of lines it would displace. Deciding
 * that trade is its own piece of work, not a line to slip in here.
 */
function formatLine(line: LogLine): string {
  const tag = line.tag ? `[${line.tag}] ` : '';
  return `${line.time ?? ''} ${line.level ?? 'info'} ${tag}${line.msg ?? ''}`.trim();
}

/** Read one NDJSON file's lines in append order. A missing/unreadable file resolves to `[]`. */
async function readLines(filePath: string): Promise<string[]> {
  try {
    const contents = await readFile(filePath, 'utf-8');
    return contents.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * The most recently rotated log file in `logDir`, or `undefined` when none
 * exists. Excludes the live `dorkos.log` itself.
 *
 * @param logDir - The resolved log directory.
 * @param currentFile - The live log file's full path (excluded from the scan).
 */
async function findPriorRotatedFile(
  logDir: string,
  currentFile: string
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return undefined;
  }
  const rotated = entries
    .filter((f) => ROTATED_LOG_FILENAME.test(f) && path.join(logDir, f) !== currentFile)
    .sort()
    .reverse();
  return rotated[0] ? path.join(logDir, rotated[0]) : undefined;
}

/** Parse, filter (severity + recency), and reduce raw NDJSON lines to {@link LogLine}s. */
function collectMatching(rawLines: string[], cutoffMs: number): LogLine[] {
  return rawLines
    .map(parseLine)
    .filter((line): line is LogLine => line !== undefined)
    .filter((line) => WARN_OR_ABOVE.has(line.level ?? ''))
    .filter((line) => (line.time ? new Date(line.time).getTime() >= cutoffMs : true));
}

/**
 * Gather a bounded, scrubbed excerpt of the server's recent `warn`+ log lines,
 * for attaching to a bug report. Never throws: a missing log directory, an
 * unreadable file, or malformed NDJSON all resolve to `undefined` rather than
 * blocking a feedback submission.
 *
 * @param maxLines - How many matching lines to keep, newest last. Defaults to
 *   {@link DEFAULT_LOG_EXCERPT_MAX_LINES}.
 * @param maxAgeMs - How far back (from now) a line may be to qualify. Defaults
 *   to {@link DEFAULT_LOG_EXCERPT_MAX_AGE_MS}.
 * @returns The scrubbed, bounded excerpt (never containing a home directory,
 *   absolute path, or secret-shaped token), or `undefined` when no log
 *   directory is configured or no matching lines were found.
 */
export async function getRecentLogExcerpt(
  maxLines: number = DEFAULT_LOG_EXCERPT_MAX_LINES,
  maxAgeMs: number = DEFAULT_LOG_EXCERPT_MAX_AGE_MS
): Promise<string | undefined> {
  const logDir = getLogDir();
  if (!logDir) return undefined;

  const currentFile = path.join(logDir, 'dorkos.log');
  const cutoffMs = Date.now() - maxAgeMs;

  let matched = collectMatching(await readLines(currentFile), cutoffMs);

  // Thin tail (e.g. just after a rotation): fold in the most recent rotated
  // file too, oldest-first, so a report filed right after midnight still sees
  // useful context instead of an almost-empty excerpt.
  if (matched.length < maxLines) {
    const priorFile = await findPriorRotatedFile(logDir, currentFile);
    if (priorFile) {
      const prior = collectMatching(await readLines(priorFile), cutoffMs);
      matched = [...prior, ...matched];
    }
  }

  if (matched.length === 0) return undefined;

  const tail = matched.slice(-maxLines);
  const scrubbed = redactTokens(redactPaths(tail.map(formatLine).join('\n')));

  // Reserve one character for the ellipsis so a truncated excerpt never
  // exceeds MAX_LOG_EXCERPT_LEN by one (the schema bound this feeds).
  return scrubbed.length > MAX_LOG_EXCERPT_LEN
    ? `${scrubbed.slice(0, MAX_LOG_EXCERPT_LEN - 1)}…`
    : scrubbed;
}
