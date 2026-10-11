/**
 * The watch-only spam and rule checks on new posts (spec `official-community-space` D15; research
 * `20261006_decision-models.md` §5).
 *
 * **Never in the post's way.** The post route knows nothing of this module. The worker reads
 * messages only after they committed, on its own timer, from its own short transactions, and
 * takes no lock a post waits on. A check that hangs, fails or runs out of budget changes nothing
 * about any message.
 *
 * **Watch-only.** For each new message: the built-in rules (rung 0) first; when they do not flag
 * it, each armed decision model (rung 1) side by side on the same message. Every rung writes one
 * `decision.*` audit row; a rung that flags the message files a report with `source='check'`
 * into the moderation queue. Nothing is hidden, held or removed, and no result reaches a
 * permission: the only things written are audit rows and reports.
 *
 * **One check per message.** The rung-0 row is the claim (a unique index), so two replicas never
 * check, or pay for, the same message twice.
 *
 * @module decisions/worker
 */
import type { Pool } from 'pg';
import {
  runLadder,
  type DailyCallCounter,
  type LadderOutcome,
  type LadderStep,
} from '@dorkos/decisions';
import type { DecisionModel } from '@dorkos/shared/decision-model';
import { transaction } from '../data.js';
import { parseRules, postPolicy, rulesPolicy } from './policy.js';
import { buildRecord, fileCheckReport, writeRecord, type RuleCounts } from './record.js';
import { createPostRules, readPostFacts } from './rules.js';
import type { ModelSlot } from './settings.js';

/** The longest stretch of a message a model reads. */
export const MAX_ITEM_CHARS = 8_000;

/** Settings for {@link checkNewPosts} and {@link startDecisionWorker}. */
export interface DecisionWorkerOptions {
  pool: Pool;
  /** Keys each record's input hash. */
  authSecret: string;
  /** The armed decision models; empty runs the built-in rules alone. */
  models: readonly ModelSlot[];
  /** Calls per model per UTC day. */
  dailyCallCap: number;
  /** Only messages newer than this are checked. Default ten minutes. */
  lookbackMs?: number;
  /** Messages per sweep. Default 20. */
  batch?: number;
  /** Messages checked at once. Default 4. */
  concurrency?: number;
  /** The longest one model call may take. Default 30 seconds. */
  timeoutMs?: number;
  /** The rung-0 bridge. Default the built-in post rules. */
  rules?: DecisionModel;
  /** Clock for the daily cap. Default `Date.now`. */
  now?: () => number;
  /** Told once per model per day when its cap is reached. */
  onCapReached?: (check: string) => void;
}

interface Candidate {
  id: string;
  community_id: string;
  text: string;
  author_agent_id: string | null;
  owner_member_id: string | null;
  parent_entry_id: string | null;
  rules_text: string | null;
}

/** Messages that committed recently and no replica has claimed, oldest first. */
async function candidates(
  pool: Pool,
  lookbackMs: number,
  batch: number,
  skip: ReadonlySet<string>
): Promise<Candidate[]> {
  const result = await pool.query<Candidate>(
    `SELECT e.id,e.community_id,e.text,e.author_agent_id,
       COALESCE(e.author_member_id,a.owner_member_id) AS owner_member_id,
       e.parent_entry_id,c.rules_text
     FROM entries e
     JOIN communities c ON c.id=e.community_id AND c.lifecycle='active'
     LEFT JOIN agents a ON a.id=e.author_agent_id
     WHERE e.created_at > now() - make_interval(secs => $1::float8 / 1000)
       AND e.removed_at IS NULL AND e.erased_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM audit_events ae
         WHERE ae.community_id=e.community_id AND ae.subject_id=e.id::text
           AND ae.action='decision.rung0' AND ae.origin='native')
       AND NOT (e.id = ANY($3::uuid[]))
     ORDER BY e.created_at,e.id LIMIT $2`,
    [lookbackMs, batch, [...skip]]
  );
  return result.rows;
}

/** Today's (UTC) start, as the cap counts it. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A daily counter per model slot, seeded from the calls already recorded today so a restart does
 * not reset the cap. Several replicas may each run a few calls past it at once; never more than
 * their concurrency.
 */
async function slotCounters(
  pool: Pool,
  models: readonly ModelSlot[],
  day: string
): Promise<Map<string, DailyCallCounter>> {
  const counts = new Map<string, number>();
  if (models.length > 0) {
    const result = await pool.query<{ check: string; n: number }>(
      `SELECT decision->>'check' AS check,count(*)::int AS n FROM audit_events
       WHERE action LIKE 'decision.%' AND origin='native'
         AND created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
         AND decision->>'rung'='1' AND NOT (decision ? 'skipped')
       GROUP BY 1`,
      [day]
    );
    for (const row of result.rows) counts.set(row.check, row.n);
  }
  const counters = new Map<string, DailyCallCounter>();
  for (const slot of models) {
    const extra = new Map<string, number>();
    counters.set(slot.check, {
      count: (_useCase, _rung, d) =>
        (d === day ? (counts.get(slot.check) ?? 0) : 0) + (extra.get(d) ?? 0),
      increment: (_useCase, _rung, d) => {
        extra.set(d, (extra.get(d) ?? 0) + 1);
      },
    });
  }
  return counters;
}

/** One rung's record to write, with what it belongs to. */
interface Pending {
  outcome: LadderOutcome;
  step: LadderStep;
  check: string;
  counts?: RuleCounts;
}

/** Write records (and reports for the flagged ones) about one message, in one transaction. */
async function record(
  pool: Pool,
  target: { communityId: string; entryId: string },
  pending: readonly Pending[],
  authSecret: string
): Promise<void> {
  if (pending.length === 0) return;
  await transaction(pool, async (client) => {
    for (const p of pending) {
      const rec = buildRecord(p.outcome, p.step, p.check, authSecret);
      if (await writeRecord(client, target, rec))
        await fileCheckReport(client, target, rec, p.counts);
    }
  });
}

/** Check one message: claim it with the rules, then ask the armed models side by side. */
async function checkOne(
  opts: Required<Pick<DecisionWorkerOptions, 'timeoutMs'>> & DecisionWorkerOptions,
  entry: Candidate,
  counters: Map<string, DailyCallCounter>,
  state: WorkerState,
  rules: DecisionModel
): Promise<void> {
  const owner = entry.owner_member_id;
  // An agent whose owner is gone has nobody its posts count as; the rules have nothing to read.
  if (owner === null) return;
  const target = { communityId: entry.community_id, entryId: entry.id };
  // Rung 0, and the claim, in one short transaction.
  const claimed = await transaction(opts.pool, async (client) => {
    const facts = await readPostFacts(client, {
      id: entry.id,
      communityId: entry.community_id,
      ownerMemberId: owner,
      text: entry.text,
    });
    const outcome = await runLadder(
      rulesPolicy(),
      { rules },
      { item: entry.text.slice(0, MAX_ITEM_CHARS), context: { facts } },
      { counter: NO_CALLS }
    );
    const step = outcome.steps[0];
    if (!step) return { claimed: false, flagged: false };
    const rec = buildRecord(outcome, step, 'rules', opts.authSecret);
    if (!(await writeRecord(client, target, rec))) return { claimed: false, flagged: false };
    const counts = { rate: facts.postsLastMinute, repeat: facts.sameTextToday, links: facts.links };
    await fileCheckReport(client, target, rec, counts);
    return { claimed: true, flagged: rec.verdict === 'flagged' };
  });
  // A message the rules already flag needs no model: a flood never buys model calls.
  if (!claimed.claimed || claimed.flagged || opts.models.length === 0) return;

  const policy = postPolicy(parseRules(entry.rules_text), opts.dailyCallCap);
  const request = {
    item: entry.text.slice(0, MAX_ITEM_CHARS),
    context: {
      author: entry.author_agent_id ? 'agent' : 'person',
      reply: entry.parent_entry_id !== null,
    },
  };
  const outcomes = await Promise.all(
    opts.models.map(async (slot): Promise<Pending | undefined> => {
      const counter = counters.get(slot.check);
      if (!counter) return undefined;
      const outcome = await runLadder(policy, { decision: slot.model }, request, {
        counter,
        signal: AbortSignal.timeout(opts.timeoutMs),
        now: opts.now,
      });
      const step = outcome.steps[0];
      if (!step) return undefined;
      if ('skipped' in step && !state.capTold.has(slot.check)) {
        state.capTold.add(slot.check);
        opts.onCapReached?.(slot.check);
      }
      return { outcome, step, check: slot.check };
    })
  );
  await record(
    opts.pool,
    target,
    outcomes.filter((p): p is Pending => p !== undefined),
    opts.authSecret
  );
}

/** Rung 0 has no cap; the ladder never asks this counter, but it needs one. */
const NO_CALLS: DailyCallCounter = { count: () => 0, increment: () => undefined };

/** What one worker remembers between sweeps. */
export interface WorkerState {
  /** Models whose cap was reached and reported today. */
  capTold: Set<string>;
  /** Messages whose check failed in this process; not retried, so one cannot block the rest. */
  failed: Set<string>;
}

/** A fresh {@link WorkerState}. */
export const workerState = (): WorkerState => ({ capTold: new Set(), failed: new Set() });

/** The most failed messages remembered; they age out of the look-back window anyway. */
const MAX_FAILED = 1_000;

/**
 * One sweep: check up to `batch` new messages, `concurrency` at a time. A message that fails is
 * left unchecked (watch-only: an unchecked message is just unchecked), remembered so it is not
 * retried, and the sweep goes on.
 *
 * @returns How many messages it looked at.
 */
export async function checkNewPosts(
  opts: DecisionWorkerOptions,
  state: WorkerState = workerState()
): Promise<{ checked: number }> {
  const now = opts.now ?? Date.now;
  if (state.failed.size > MAX_FAILED) state.failed.clear();
  const list = await candidates(
    opts.pool,
    opts.lookbackMs ?? 10 * 60_000,
    opts.batch ?? 20,
    state.failed
  );
  if (list.length === 0) return { checked: 0 };
  const counters = await slotCounters(opts.pool, opts.models, utcDay(now()));
  const rules = opts.rules ?? createPostRules();
  const full = { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 };
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      const entry = list[next++]!;
      try {
        await checkOne(full, entry, counters, state, rules);
      } catch (error) {
        state.failed.add(entry.id);
        console.error(
          'Community post check failed',
          error instanceof Error ? error.name : 'unknown'
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, lane));
  return { checked: list.length };
}

/** How often the worker looks for new messages. */
export const DECISION_POLL_MS = 2_000;

/**
 * Start the checks on a timer. One sweep at a time; a slow sweep skips ticks rather than piling
 * up. The timer is `unref`'d, and stopping it is the caller's (shutdown's) job.
 */
export function startDecisionWorker(opts: DecisionWorkerOptions): NodeJS.Timeout {
  let running = false;
  let capDay = '';
  const state = workerState();
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const day = utcDay((opts.now ?? Date.now)());
    if (day !== capDay) {
      capDay = day;
      state.capTold.clear();
    }
    void checkNewPosts(opts, state)
      .catch((error: unknown) => {
        console.error(
          'Community post checks unavailable',
          error instanceof Error ? error.name : 'unknown'
        );
      })
      .finally(() => {
        running = false;
      });
  }, DECISION_POLL_MS);
  timer.unref();
  return timer;
}
