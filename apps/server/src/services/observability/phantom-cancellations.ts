/**
 * The DOR-1087 tripwire: how often the CLI cancels its own pending tool calls,
 * counted rather than remembered.
 *
 * > On 2026-08-09 one session produced eight phantom cancellations and zero real
 * > denies. Everyone knew the number because somebody sat and watched it happen.
 *
 * A phantom is the Claude Code CLI writing its interrupt sentinel as a
 * `tool_result` when NO operator decision is behind it — not a UI deny (which
 * carries its own wording) and not an operator stop (which goes through
 * `interruptQuery` and stamps the session). The detection itself lives in
 * `runtimes/claude-code/messaging/phantom-cancellation.ts`; this module is only
 * the counting, and it exists because of what the persistent-session programme
 * is about to claim.
 *
 * **Persistence is HYPOTHESISED to remove this class entirely** — with a
 * persistent stream DorkOS stops racing the CLI's internal queue. That
 * hypothesis is unverified, and spec `persistent-session-runtime` task 5.1 is
 * the measurement that settles it. A rate needs a denominator and a
 * before/after, so {@link PhantomCancellationStats.byPath} splits the count by
 * which path produced it: `turn` is the resume-per-message path (the flag off),
 * `pump` is the persistent one (the flag on). Two numbers off one process, from
 * the same workload, are the whole measurement.
 *
 * Deliberately NOT persisted, for the same reason as
 * {@link module:services/observability/dispatch-buffers}: the NDJSON log is the
 * durable record, and a ring written to disk is a second, worse log. These
 * counters die with the process; every line
 * {@link recordPhantomCancellation} writes survives it.
 *
 * @module services/observability/phantom-cancellations
 */
import { logger } from '../../lib/logger.js';

/**
 * Which sender produced the phantom.
 *
 * - `turn` — `messaging/message-sender.ts`, one SDK query per message. The path
 *   the 2026-08-09 incident was observed on.
 * - `pump` — `sessions/pump-turn-stream.ts`, one turn window on a persistent
 *   process. The path whose phantom count is expected to be zero.
 */
export type PhantomPath = 'turn' | 'pump';

/**
 * How many phantom batches the ring remembers.
 *
 * Smaller than the dispatch ring because a phantom is rare by construction: if
 * 64 of them are in memory at once, the count is the story and the individual
 * rows stopped mattering several dozen ago.
 */
export const PHANTOM_BUFFER_SIZE = 64;

/** One SDK message's worth of phantoms, as the ring remembers it. */
export interface PhantomCancellationRecord {
  /** ISO 8601. */
  at: string;
  /** The DorkOS session id the turn belonged to. */
  sessionId: string;
  path: PhantomPath;
  /** Every tool call the CLI cancelled in this one message. */
  toolUseIds: string[];
  /** True when the cancelled calls belong to the main thread, not a subagent. */
  mainThread: boolean;
  /** The `Task` call that dispatched the subagent, or `null` on the main thread. */
  parentToolUseId: string | null;
  /** Whether a corrective note was steered back into the live turn. */
  steered: boolean;
}

/** Everything the tripwire knows, for task 5.1's measurement. */
export interface PhantomCancellationStats {
  /** Individual tool calls cancelled — the number the rate is built from. */
  total: number;
  /** SDK messages that carried at least one. The CLI cancels a batch at a time. */
  batches: number;
  /** The flag-off / flag-on split. Both zero is the outcome 5.1 hopes for. */
  byPath: Record<PhantomPath, number>;
  /** Cancelled calls on the main thread. */
  mainThread: number;
  /** Cancelled calls inside a subagent. */
  subagent: number;
  /** Batches a corrective note was steered for. */
  steered: number;
  /** Distinct sessions that saw at least one. */
  sessions: number;
  /** ISO 8601 — when this process started counting. */
  since: string;
  /** The most recent batches, newest first. */
  recent: PhantomCancellationRecord[];
}

/** What {@link recordPhantomCancellation} needs to count and log one batch. */
export interface PhantomCancellationReport {
  sessionId: string;
  path: PhantomPath;
  /** Every phantom found in ONE streamed SDK message. Must be non-empty. */
  phantoms: ReadonlyArray<{
    toolUseId: string;
    mainThread: boolean;
    parentToolUseId: string | null;
  }>;
  /** Whether the sender steered a corrective note back into the turn. */
  steered: boolean;
}

const slots: Array<PhantomCancellationRecord | undefined> = new Array<
  PhantomCancellationRecord | undefined
>(PHANTOM_BUFFER_SIZE);
let cursor = 0;
const sessionsSeen = new Set<string>();
let since = new Date().toISOString();
const counts = {
  total: 0,
  batches: 0,
  turn: 0,
  pump: 0,
  mainThread: 0,
  subagent: 0,
  steered: 0,
};

/**
 * Count one message's phantoms and write the line that proves it happened.
 *
 * The log and the counter are the same call on purpose: two call sites logging
 * their own differently-worded warning is how the 2026-08-09 rate ended up
 * being a number somebody remembered rather than one anybody could query. Every
 * line is greppable as `[phantom-cancellation]` and carries `path`, so the
 * flag-off and flag-on legs of task 5.1 are separable from the log alone if the
 * process is gone by the time anybody asks.
 *
 * Level is always `warn`: a phantom is invisible to the operator except for a
 * single status line, and the model has already been told something false.
 *
 * @param report - The session, the path, the batch, and whether it was corrected.
 */
export function recordPhantomCancellation(report: PhantomCancellationReport): void {
  const { sessionId, path, phantoms, steered } = report;
  if (phantoms.length === 0) return;

  const toolUseIds = phantoms.map((p) => p.toolUseId);
  // `parent_tool_use_id` is a MESSAGE-level field, so one batch is uniformly
  // main-thread or uniformly one subagent's — never a mix. See
  // `detectPhantomCancellations`.
  const mainThread = phantoms.some((p) => p.mainThread);
  const parentToolUseId = phantoms.find((p) => !p.mainThread)?.parentToolUseId ?? null;

  counts.total += phantoms.length;
  counts.batches += 1;
  counts[path] += phantoms.length;
  if (mainThread) counts.mainThread += phantoms.length;
  else counts.subagent += phantoms.length;
  if (steered) counts.steered += 1;
  sessionsSeen.add(sessionId);

  const record: PhantomCancellationRecord = {
    at: new Date().toISOString(),
    sessionId,
    path,
    toolUseIds,
    mainThread,
    parentToolUseId,
    steered,
  };
  slots[cursor] = record;
  cursor = (cursor + 1) % PHANTOM_BUFFER_SIZE;

  logger.warn(
    '[phantom-cancellation] the CLI cancelled its own pending tool calls; no operator deny or stop behind it',
    {
      session: sessionId,
      path,
      toolUseIds,
      count: phantoms.length,
      mainThread,
      // Named so a reader can tell WHICH subagent's work was abandoned; `null`
      // on the main thread rather than absent, so the field is always present.
      parentToolUseId,
      steered,
      // The running totals ride along, so one line answers "how often" without
      // anybody counting lines or the process still being alive to ask.
      totalSinceBoot: counts.total,
      pathTotalSinceBoot: counts[path],
    }
  );
}

/**
 * Everything the tripwire has counted since this process started.
 *
 * Read by `GET /api/debug/phantom-cancellations`, which is how task 5.1 samples
 * it between the flag-off and flag-on legs of the measurement.
 *
 * @param limit - How many recent batches to include. Clamped to what the ring holds.
 */
export function phantomCancellationStats(limit = PHANTOM_BUFFER_SIZE): PhantomCancellationStats {
  const held = Math.min(counts.batches, PHANTOM_BUFFER_SIZE);
  const wanted = Math.max(0, Math.min(limit, held));
  const recent: PhantomCancellationRecord[] = [];
  for (let i = 1; i <= wanted; i += 1) {
    const slot = slots[(cursor - i + PHANTOM_BUFFER_SIZE) % PHANTOM_BUFFER_SIZE];
    if (slot !== undefined) recent.push(slot);
  }
  return {
    total: counts.total,
    batches: counts.batches,
    byPath: { turn: counts.turn, pump: counts.pump },
    mainThread: counts.mainThread,
    subagent: counts.subagent,
    steered: counts.steered,
    sessions: sessionsSeen.size,
    since,
    recent,
  };
}

/** Forget everything counted. Test isolation only — nothing in the server calls it. */
export function resetPhantomCancellations(): void {
  slots.fill(undefined);
  cursor = 0;
  sessionsSeen.clear();
  since = new Date().toISOString();
  counts.total = 0;
  counts.batches = 0;
  counts.turn = 0;
  counts.pump = 0;
  counts.mainThread = 0;
  counts.subagent = 0;
  counts.steered = 0;
}
