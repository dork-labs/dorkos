/**
 * The watch-only spam and rule checks on new posts (spec `official-community-space` D15; research
 * `20261006_decision-models.md` §5).
 *
 * **Never in the post's way.** The post route knows nothing of this module. The worker reads
 * messages only after they committed, on its own timer, through its own small connection pool
 * (`startup/space-server.ts`), in short transactions that take no lock a post waits on. A check
 * that hangs, fails or runs out of budget changes nothing about any message.
 *
 * **Watch-only.** For each new message: the built-in rules (rung 0) first; when they do not flag
 * it, each armed decision model (rung 1) side by side on the same message. Every rung writes one
 * `decision.*` audit row; a rung that flags the message files a report with `source='check'`
 * into the moderation queue. Nothing is hidden, held or removed, and no result reaches a
 * permission: the only things written are audit rows and reports.
 *
 * **Two phases.** The rules (and the claim) run on a whole batch first; the model calls run after,
 * in a bounded queue of their own, so a slow model never holds up the free checks.
 *
 * **One check per message.** The rung-0 row is the claim (a unique index), so two replicas never
 * check, or pay for, the same message twice.
 *
 * **Private channels stay on this server.** Their messages get the built-in rules only; no model
 * outside the server ever reads them.
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
import { buildRecord, fileCheckReport, writeRecord } from './record.js';
import { createPostRules, readPostFacts } from './rules.js';
import type { ModelSlot } from './settings.js';

/** The longest stretch of a message a model reads. */
export const MAX_ITEM_CHARS = 8_000;

/** Settings for {@link checkNewPosts} and {@link startDecisionWorker}. */
export interface DecisionWorkerOptions {
  /** The worker's own pool, apart from the one requests use. */
  pool: Pool;
  /** Keys each record's input hash. */
  authSecret: string;
  /** The armed decision models; empty runs the built-in rules alone. */
  models: readonly ModelSlot[];
  /** Calls per model per UTC day. */
  dailyCallCap: number;
  /** Only messages newer than this are checked. Default ten minutes. */
  lookbackMs?: number;
  /** Messages the rules check per sweep. Default 50. */
  batch?: number;
  /** Messages sent to the models at once. Default 4. */
  concurrency?: number;
  /** The most messages waiting for the models; past it a message gets the rules only. Default 200. */
  maxQueued?: number;
  /** The longest one model's check may take. Default 20 seconds. */
  timeoutMs?: number;
  /** The rung-0 bridge. Default the built-in post rules. */
  rules?: DecisionModel;
  /** Clock for the daily cap. Default `Date.now`. */
  now?: () => number;
  /** Told once per model per day when its cap is reached. */
  onCapReached?: (check: string) => void;
}

/** One message waiting for the models. */
interface ModelJob {
  id: string;
  communityId: string;
  ownerMemberId: string;
  text: string;
  agent: boolean;
  reply: boolean;
  rulesText: string | null;
}

interface Candidate {
  id: string;
  community_id: string;
  text: string;
  author_member_id: string | null;
  author_agent_id: string | null;
  owner_member_id: string | null;
  parent_entry_id: string | null;
  public: boolean;
  rules_text: string | null;
}

/** What one worker remembers between sweeps. */
export interface WorkerState {
  /** Models whose cap was reached and reported today. */
  capTold: Set<string>;
  /** Messages whose check failed in this process; not retried, so one cannot block the rest. */
  failed: Set<string>;
  /** Messages waiting for the models. */
  queue: ModelJob[];
  /** Model checks running now. */
  running: number;
  /** Messages that got the rules only because the model queue was full. */
  overflowed: number;
  /** Model checks in flight, so a caller can wait for them. */
  inFlight: Set<Promise<void>>;
}

/** A fresh {@link WorkerState}. */
export const workerState = (): WorkerState => ({
  capTold: new Set(),
  failed: new Set(),
  queue: [],
  running: 0,
  overflowed: 0,
  inFlight: new Set(),
});

/** The most failed messages remembered; they age out of the look-back window anyway. */
const MAX_FAILED = 1_000;

/** Messages that committed recently and no replica has claimed, oldest first. */
async function candidates(
  pool: Pool,
  lookbackMs: number,
  batch: number,
  skip: ReadonlySet<string>
): Promise<Candidate[]> {
  const result = await pool.query<Candidate>(
    `SELECT e.id,e.community_id,e.text,e.author_member_id,e.author_agent_id,
       CASE WHEN e.author_agent_id IS NULL THEN e.author_member_id ELSE a.owner_member_id END
         AS owner_member_id,
       e.parent_entry_id,(ch.visibility='public') AS public,c.rules_text
     FROM entries e
     JOIN communities c ON c.id=e.community_id AND c.lifecycle='active'
     JOIN channels ch ON ch.id=e.channel_id AND ch.community_id=e.community_id
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

/** Today's (UTC) date, as the cap counts it. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A daily counter for one model, seeded from the checks already recorded today so a restart does
 * not reset the cap. A cap counts checks: an OpenAI-format server that returns no token
 * probabilities is asked twice per check. Each model check seeds its own count when it starts, so
 * the checks in flight at once (on every replica) can run past the cap by at most their number.
 */
async function slotCounter(pool: Pool, check: string, day: string): Promise<DailyCallCounter> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events
     WHERE action='decision.rung1' AND origin='native'
       AND created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
       AND decision->>'check'=$2 AND NOT (decision ? 'skipped')`,
    [day, check]
  );
  const seeded = result.rows[0]?.n ?? 0;
  let extra = 0;
  return {
    count: (_useCase, _rung, d) => (d === day ? seeded : 0) + extra,
    increment: () => {
      extra += 1;
    },
  };
}

/** Rung 0 has no cap; the ladder never asks this counter, but it needs one. */
const NO_CALLS: DailyCallCounter = { count: () => 0, increment: () => undefined };

/**
 * Claim one message and run the rules on it, in one short transaction. Returns the job for the
 * models when the message needs them.
 */
async function claimAndRule(
  opts: DecisionWorkerOptions,
  entry: Candidate,
  rules: DecisionModel
): Promise<ModelJob | undefined> {
  const owner = entry.owner_member_id;
  const authorId = entry.author_agent_id ?? entry.author_member_id;
  // An agent whose owner is gone has nobody its posts count as.
  if (owner === null || authorId === null) return undefined;
  const target = { communityId: entry.community_id, entryId: entry.id, ownerMemberId: owner };
  const needsModels = await transaction(opts.pool, async (client) => {
    const facts = await readPostFacts(client, {
      id: entry.id,
      author: { kind: entry.author_agent_id ? 'agent' : 'human', id: authorId },
      text: entry.text,
    });
    const outcome = await runLadder(
      rulesPolicy(),
      { rules },
      { item: entry.text.slice(0, MAX_ITEM_CHARS), context: { facts } },
      { counter: NO_CALLS }
    );
    const step = outcome.steps[0];
    if (!step) return false;
    const rec = buildRecord(outcome, step, 'rules', opts.authSecret);
    if (!(await writeRecord(client, target, rec))) return false;
    const counts = { rate: facts.postsLastMinute, repeat: facts.sameTextToday, links: facts.links };
    await fileCheckReport(client, target, rec, counts);
    // A message the rules already flag needs no model: a flood never buys model calls.
    return rec.verdict !== 'flagged';
  });
  if (!needsModels || !entry.public || opts.models.length === 0) return undefined;
  return {
    id: entry.id,
    communityId: entry.community_id,
    ownerMemberId: owner,
    text: entry.text,
    agent: entry.author_agent_id !== null,
    reply: entry.parent_entry_id !== null,
    rulesText: entry.rules_text,
  };
}

/** Ask every armed model about one message, side by side, and record what each said. */
async function askModels(
  opts: DecisionWorkerOptions,
  job: ModelJob,
  state: WorkerState
): Promise<void> {
  const day = utcDay((opts.now ?? Date.now)());
  const policy = postPolicy(parseRules(job.rulesText), opts.dailyCallCap);
  const request = {
    item: job.text.slice(0, MAX_ITEM_CHARS),
    context: { author: job.agent ? 'agent' : 'person', reply: job.reply },
  };
  const steps = await Promise.all(
    opts.models.map(async (slot) => {
      const outcome = await runLadder(policy, { decision: slot.model }, request, {
        counter: await slotCounter(opts.pool, slot.check, day),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        now: opts.now,
      });
      const step = outcome.steps[0];
      if (step && 'skipped' in step && !state.capTold.has(slot.check)) {
        state.capTold.add(slot.check);
        opts.onCapReached?.(slot.check);
      }
      return step ? { outcome, step, check: slot.check as string } : undefined;
    })
  );
  const pending = steps.filter(
    (p): p is { outcome: LadderOutcome; step: LadderStep; check: string } => p !== undefined
  );
  if (pending.length === 0) return;
  const target = {
    communityId: job.communityId,
    entryId: job.id,
    ownerMemberId: job.ownerMemberId,
  };
  await transaction(opts.pool, async (client) => {
    for (const p of pending) {
      const rec = buildRecord(p.outcome, p.step, p.check, opts.authSecret);
      if (await writeRecord(client, target, rec)) await fileCheckReport(client, target, rec);
    }
  });
}

/** Start queued model checks up to the concurrency. Each one starts the next as it ends. */
function pump(opts: DecisionWorkerOptions, state: WorkerState): void {
  while (state.running < (opts.concurrency ?? 4) && state.queue.length > 0) {
    const job = state.queue.shift()!;
    state.running += 1;
    const run: Promise<void> = askModels(opts, job, state)
      .catch((error: unknown) => {
        state.failed.add(job.id);
        console.error(
          'Community post check failed',
          error instanceof Error ? error.name : 'unknown'
        );
      })
      .finally(() => {
        state.running -= 1;
        state.inFlight.delete(run);
        pump(opts, state);
      });
    state.inFlight.add(run);
  }
}

/**
 * One sweep's first phase: claim up to `batch` new messages and run the rules on each, then hand
 * the ones that need a model to the model queue. A message that fails is left unchecked
 * (watch-only: an unchecked message is just unchecked), remembered so it is not retried, and the
 * sweep goes on.
 *
 * @returns How many messages it looked at.
 */
export async function sweepNewPosts(
  opts: DecisionWorkerOptions,
  state: WorkerState
): Promise<{ checked: number }> {
  if (state.failed.size > MAX_FAILED) state.failed.clear();
  const list = await candidates(
    opts.pool,
    opts.lookbackMs ?? 10 * 60_000,
    opts.batch ?? 50,
    state.failed
  );
  const rules = opts.rules ?? createPostRules();
  for (const entry of list) {
    try {
      const job = await claimAndRule(opts, entry, rules);
      if (!job) continue;
      if (state.queue.length >= (opts.maxQueued ?? 200)) state.overflowed += 1;
      else state.queue.push(job);
    } catch (error) {
      state.failed.add(entry.id);
      console.error('Community post check failed', error instanceof Error ? error.name : 'unknown');
    }
  }
  pump(opts, state);
  return { checked: list.length };
}

/**
 * One whole sweep, both phases, waiting for every model check it started. Tests and one-off runs
 * use it; the timer runs the phases apart.
 */
export async function checkNewPosts(
  opts: DecisionWorkerOptions,
  state: WorkerState = workerState()
): Promise<{ checked: number }> {
  const result = await sweepNewPosts(opts, state);
  while (state.inFlight.size > 0) await Promise.all([...state.inFlight]);
  return result;
}

/** How often the worker looks for new messages. */
export const DECISION_POLL_MS = 2_000;

/**
 * Start the checks on a timer. One rules sweep at a time; model checks run beside it from their
 * own queue. The timer is `unref`'d, and stopping it is the caller's (shutdown's) job.
 */
export function startDecisionWorker(opts: DecisionWorkerOptions): NodeJS.Timeout {
  let sweeping = false;
  let capDay = '';
  let overflowTold = 0;
  const state = workerState();
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    const day = utcDay((opts.now ?? Date.now)());
    if (day !== capDay) {
      capDay = day;
      state.capTold.clear();
    }
    void sweepNewPosts(opts, state)
      .catch((error: unknown) => {
        console.error(
          'Community post checks unavailable',
          error instanceof Error ? error.name : 'unknown'
        );
      })
      .finally(() => {
        sweeping = false;
        if (state.overflowed > overflowTold) {
          console.warn(
            `Community post checks: ${state.overflowed - overflowTold} posts got the built-in rules only; the models were busy.`
          );
          overflowTold = state.overflowed;
        }
      });
  }, DECISION_POLL_MS);
  timer.unref();
  return timer;
}
