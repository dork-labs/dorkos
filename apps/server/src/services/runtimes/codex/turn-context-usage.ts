/**
 * Bounded current-context and rate-limit reads from Codex's native rollout tail.
 *
 * The one `token_count` record family Codex writes per model call carries two
 * things DorkOS shows: the active context size (`info`) and the account's
 * rate limits (`rate_limits`, spec `claude-account-fleet` §6 R). Both come
 * from the same bounded tail read, so recording usage costs no new file access.
 *
 * @module services/runtimes/codex/turn-context-usage
 */
import { constants } from 'node:fs';
import { open, opendir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveCodexHome } from './codex-home.js';

const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 2_000;
const DEFAULT_MAX_TAIL_BYTES = 256 * 1024;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;
const MAX_RECORD_AGE_MS = 60_000;

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TokenCountRecordSchema = z.object({
  timestamp: z.string(),
  type: z.literal('event_msg'),
  payload: z.object({
    type: z.literal('token_count'),
    info: z.object({
      last_token_usage: z.object({
        total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
      model_context_window: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
  }),
});

/** Current context occupancy and effective model window from one native Codex turn. */
export interface CodexTurnContextUsage {
  /** Tokens in the active context after the completed turn. */
  contextTokens: number;
  /** Effective model context window recorded by Codex for that turn. */
  contextMaxTokens: number;
}

/**
 * Everything one completed (or failed) Codex turn left in its rollout tail.
 */
export interface CodexTurnReading {
  /** Current context usage, or `null` when the latest record could not be verified. */
  context: CodexTurnContextUsage | null;
  /**
   * The newest `rate_limits` payload of each limit (`limit_id`) recorded during
   * this turn, oldest first, as raw JSON for `codexObservations`. Codex
   * alternates records for the main limit and model-specific ones, so the
   * newest record alone can hide the main limit. A window's `resets_in_seconds`
   * (older Codex builds) is turned into `resets_at` from the record's own
   * timestamp. Empty when the turn recorded none.
   */
  rateLimits: Record<string, unknown>[];
}

/** Options for one bounded native rollout read. */
export interface ReadCodexTurnContextUsageOptions {
  /** Codex thread id emitted by `thread.started`. */
  threadId: string;
  /**
   * Local time when this turn's `turn.started` event was observed. OMITTED to
   * read the rollout's last `token_count` at rest, however old (a session
   * opened with no stored reading, spec `claude-account-fleet` §6 U): the
   * freshness bounds exist to tie a reading to a live turn, and there is none.
   */
  turnStartedAtMs?: number;
  /** Codex home used by the running CLI. */
  codexHome?: string;
  /** Clock seam for deterministic tests. */
  now?: number;
  /** Deadline for directory discovery and the tail read. */
  timeoutMs?: number;
  /** Maximum entries inspected in each candidate directory. */
  maxDirectoryEntries?: number;
  /** Maximum bytes read from the rollout tail. */
  maxTailBytes?: number;
  /** Optional outer cancellation signal. */
  signal?: AbortSignal;
}

function localDateParts(timestampMs: number, dayOffset: number): [string, string, string] {
  const date = new Date(timestampMs);
  date.setDate(date.getDate() + dayOffset);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
}

function liveCandidateDirectories(codexHome: string, timestampMs: number): string[] {
  return [0, -1, 1].map((offset) =>
    path.join(codexHome, 'sessions', ...localDateParts(timestampMs, offset))
  );
}

async function closeQuietly(handle: { close(): Promise<void> } | null): Promise<void> {
  if (handle === null) return;
  try {
    await handle.close();
  } catch {
    // A cancellation callback or async iterator may already have closed it.
  }
}

async function findRollout(
  directories: readonly string[],
  threadId: string,
  maxEntries: number,
  signal: AbortSignal
): Promise<string | null | undefined> {
  const suffix = `-${threadId}.jsonl`;
  let match: string | null = null;

  for (const directory of directories) {
    signal.throwIfAborted();
    let handle: Awaited<ReturnType<typeof opendir>> | null = null;
    const closeOnAbort = (): void => {
      void closeQuietly(handle);
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    try {
      handle = await opendir(directory);
      signal.throwIfAborted();
      let inspected = 0;
      while (true) {
        const entry = await handle.read();
        if (entry === null) break;
        inspected += 1;
        if (inspected > maxEntries) return undefined;
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith(suffix)) {
          continue;
        }
        if (match !== null) return undefined;
        match = path.join(directory, entry.name);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    } finally {
      signal.removeEventListener('abort', closeOnAbort);
      await closeQuietly(handle);
    }
  }

  return match;
}

async function readTail(
  filePath: string,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ text: string; truncatedAtStart: boolean } | null> {
  let handle: FileHandle | null = null;
  const closeOnAbort = (): void => {
    void closeQuietly(handle);
  };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    signal.throwIfAborted();
    const before = await handle.stat();
    if (!before.isFile()) return null;

    const length = Math.min(before.size, maxBytes);
    const offset = before.size - length;
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      signal.throwIfAborted();
      const result = await handle.read(bytes, read, length - read, offset + read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size) return null;
    return {
      text: bytes.subarray(0, read).toString('utf8'),
      truncatedAtStart: offset > 0,
    };
  } catch {
    return null;
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    await closeQuietly(handle);
  }
}

function parseLatestUsage(
  tail: string,
  truncatedAtStart: boolean,
  turnStartedAtMs: number | undefined,
  now: number
): CodexTurnContextUsage | null {
  const lines = tail.split('\n');
  if (truncatedAtStart) lines.shift();
  if (!tail.endsWith('\n')) lines.pop();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (decoded as { payload?: unknown } | null)?.payload;
    if (
      payload === null ||
      typeof payload !== 'object' ||
      (payload as { type?: unknown }).type !== 'token_count'
    ) {
      continue;
    }
    const record = TokenCountRecordSchema.safeParse(decoded);
    if (!record.success) return null;
    const recordedAt = Date.parse(record.data.timestamp);
    if (!Number.isFinite(recordedAt)) return null;
    if (
      turnStartedAtMs !== undefined &&
      (recordedAt < turnStartedAtMs ||
        now - recordedAt > MAX_RECORD_AGE_MS ||
        recordedAt > now + MAX_FUTURE_CLOCK_SKEW_MS)
    ) {
      return null;
    }
    return {
      contextTokens: record.data.payload.info.last_token_usage.total_tokens,
      contextMaxTokens: record.data.payload.info.model_context_window,
    };
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One window with `resets_in_seconds` turned into `resets_at`, seen at `recordedAtMs`. */
function withAbsoluteReset(window: unknown, recordedAtMs: number): unknown {
  if (!isPlainObject(window) || window.resets_at !== undefined) return window;
  const seconds = window.resets_in_seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return window;
  return { ...window, resets_at: Math.round(recordedAtMs / 1000 + seconds) };
}

/**
 * The newest `rate_limits` payload per limit written during this turn. Uses the
 * same freshness bounds as the context reading when `turnStartedAtMs` is given.
 * Tolerant: a line that is not JSON or not a `token_count`, or a record without
 * `rate_limits`, is skipped, never thrown on.
 */
function parseTurnRateLimits(
  tail: string,
  truncatedAtStart: boolean,
  turnStartedAtMs: number | undefined,
  now: number
): Record<string, unknown>[] {
  const lines = tail.split('\n');
  if (truncatedAtStart) lines.shift();
  if (!tail.endsWith('\n')) lines.pop();

  const newestByLimit = new Map<string, Record<string, unknown>>();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(decoded) || decoded.type !== 'event_msg') continue;
    const payload = decoded.payload;
    if (!isPlainObject(payload) || payload.type !== 'token_count') continue;
    const recordedAt = typeof decoded.timestamp === 'string' ? Date.parse(decoded.timestamp) : NaN;
    if (!Number.isFinite(recordedAt)) continue;
    if (recordedAt > now + MAX_FUTURE_CLOCK_SKEW_MS) continue;
    // Older than this turn: every earlier record is older still.
    if (turnStartedAtMs !== undefined && recordedAt < turnStartedAtMs) break;
    const rateLimits = payload.rate_limits;
    if (!isPlainObject(rateLimits)) continue;
    // No `limit_id` IS the main limit (contract §1.2), so it shares `codex`'s key.
    const limitKey =
      typeof rateLimits.limit_id === 'string' && rateLimits.limit_id !== ''
        ? rateLimits.limit_id
        : 'codex';
    if (newestByLimit.has(limitKey)) continue;
    newestByLimit.set(limitKey, {
      ...rateLimits,
      primary: withAbsoluteReset(rateLimits.primary, recordedAt),
      secondary: withAbsoluteReset(rateLimits.secondary, recordedAt),
    });
  }
  return [...newestByLimit.values()].reverse();
}

async function readWithinDeadline(
  options: ReadCodexTurnContextUsageOptions,
  signal: AbortSignal
): Promise<CodexTurnReading | null> {
  const match = UUID_V7.exec(options.threadId);
  if (match === null) return null;
  const timestampMs = Number.parseInt(`${match[1]}${match[2]}`, 16);
  if (!Number.isSafeInteger(timestampMs)) return null;

  const codexHome = options.codexHome ?? resolveCodexHome();
  const liveFile = await findRollout(
    liveCandidateDirectories(codexHome, timestampMs),
    options.threadId.toLowerCase(),
    options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES,
    signal
  );
  if (liveFile === undefined) return null;
  const filePath =
    liveFile ??
    (await findRollout(
      [path.join(codexHome, 'archived_sessions')],
      options.threadId.toLowerCase(),
      options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES,
      signal
    ));
  if (filePath == null) return null;
  const tail = await readTail(filePath, options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES, signal);
  if (tail === null) return null;
  const now = options.now ?? Date.now();
  return {
    context: parseLatestUsage(tail.text, tail.truncatedAtStart, options.turnStartedAtMs, now),
    rateLimits: parseTurnRateLimits(tail.text, tail.truncatedAtStart, options.turnStartedAtMs, now),
  };
}

/**
 * Read the latest current-context measurement written by this completed turn.
 *
 * Codex 0.154.0 defines `last_token_usage.total_tokens` as the latest active
 * context size and `total_token_usage` as the accumulated session total. Its
 * own context gauge uses the former:
 * https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/token_usage.rs
 *
 * The thread UUID encodes its creation time, which bounds discovery to three
 * adjacent daily directories plus the flat archive. Each directory and the
 * file tail have hard size limits, and the whole operation has a deadline.
 * Missing or unverifiable data returns `null`; cumulative SDK input is never
 * substituted for current context.
 *
 * @param options - Thread identity, current-turn boundary, and read limits.
 * @returns Current context usage, or `null` when native evidence is unavailable.
 */
export async function readCodexTurnContextUsage(
  options: ReadCodexTurnContextUsageOptions
): Promise<CodexTurnContextUsage | null> {
  return (await readCodexTurnReading(options))?.context ?? null;
}

/**
 * Read what this turn left in its rollout tail: the current-context measurement
 * ({@link readCodexTurnContextUsage}) and the account's rate limits, from ONE
 * bounded read under the same limits and deadline.
 *
 * @param options - Thread identity, current-turn boundary, and read limits.
 * @returns The reading, or `null` when the rollout could not be found or read in time.
 */
export async function readCodexTurnReading(
  options: ReadCodexTurnContextUsageOptions
): Promise<CodexTurnReading | null> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const aborted = new Promise<null>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(null), { once: true });
  });

  try {
    return await Promise.race([readWithinDeadline(options, controller.signal), aborted]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
