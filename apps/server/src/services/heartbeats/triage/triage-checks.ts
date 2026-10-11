/**
 * What the Heartbeat page says about cheap checks (spec `heartbeats` §6.3,
 * §7.6), and the one-time offer to run them on DorkOS credits.
 *
 * - **The live state, never the configured one.** "Checks run on DorkOS
 *   credits." only while rung 1 would really run there now; credits that
 *   dropped out read as the agent's own runtime.
 * - **Today's checks and their tokens** come from this agent's beat rows (the
 *   rung-1 steps in each row's `triage`), counted in its chain person's day.
 *   No dollar figure: the endpoint reports none, and this repo holds no prices.
 * - **The offer is made once.** On a computer linked to a DorkOS account, while
 *   nobody has answered (`heartbeats.triageOnCredits` is `null`), the owner sees
 *   a card on every agent's Heartbeat page and gets one notification. The
 *   notification is remembered in a small state file beside DorkOS's data, so
 *   a restart does not raise it again.
 *
 * @module services/heartbeats/triage/triage-checks
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, gte } from 'drizzle-orm';
import { heartbeatBeats, type Db } from '@dorkos/db';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { HeartbeatChecks } from '@dorkos/shared/heartbeat-schemas';
import { zonedDay } from '@dorkos/shared/working-hours';
import { logger } from '../../../lib/logger.js';

/** What today's checks used. */
export interface ChecksToday {
  /** Checks run on a decision model today. */
  checks: number;
  /** Their tokens, read and written. */
  tokens: number;
}

/** One rung-1 step as a beat row stores it. */
interface StoredStep {
  rung?: unknown;
  requests?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown };
}

/**
 * The rung-1 steps in one beat row's `triage` column that sent at least one
 * request. A step the fuse skipped, or whose token was gone before anything
 * went out, was never a check.
 */
function sentSteps(raw: string | null): StoredStep[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { steps?: unknown };
    return Array.isArray(parsed.steps)
      ? (parsed.steps as StoredStep[]).filter((step) => step.rung === 1 && requestsOf(step) > 0)
      : [];
  } catch {
    return [];
  }
}

/** Requests a step sent. */
function requestsOf(step: StoredStep): number {
  return typeof step.requests === 'number' && Number.isFinite(step.requests) ? step.requests : 0;
}

/** A token count, or 0 when it is not one. */
function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The checks one beat row's `triage` column records, and their tokens.
 *
 * @param raw - The column.
 */
export function checksInBeat(raw: string | null): ChecksToday {
  let tokensUsed = 0;
  const steps = sentSteps(raw);
  for (const step of steps) {
    tokensUsed += tokens(step.usage?.inputTokens) + tokens(step.usage?.outputTokens);
  }
  return { checks: steps.length, tokens: tokensUsed };
}

/** A little over a day back, so every beat of any zone's today is read. */
const LOOKBACK_MS = 50 * 60 * 60 * 1000;

/**
 * Count an agent's checks on a decision model today, and their tokens.
 *
 * @param db - The server's database.
 * @param agentId - The agent.
 * @param now - Now.
 * @param timezone - Its chain person's zone, which decides what "today" is.
 */
export function checksToday(db: Db, agentId: string, now: Date, timezone: string): ChecksToday {
  const today = zonedDay(now, timezone);
  const rows = db
    .select({ startedAt: heartbeatBeats.startedAt, triage: heartbeatBeats.triage })
    .from(heartbeatBeats)
    .where(
      and(
        eq(heartbeatBeats.agentId, agentId),
        gte(heartbeatBeats.startedAt, new Date(now.getTime() - LOOKBACK_MS).toISOString())
      )
    )
    .all();
  let checks = 0;
  let used = 0;
  for (const row of rows) {
    if (zonedDay(new Date(row.startedAt), timezone) !== today) continue;
    const beat = checksInBeat(row.triage);
    checks += beat.checks;
    used += beat.tokens;
  }
  return { checks, tokens: used };
}

/**
 * Requests every agent's checks sent to the credits endpoint today (UTC, the
 * fuse's day), read from the beat record at startup so a restart does not
 * reset the fuse.
 *
 * @param db - The server's database.
 * @param now - Now.
 */
export function requestsTodayUtc(db: Db, now: Date): number {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const rows = db
    .select({ triage: heartbeatBeats.triage })
    .from(heartbeatBeats)
    .where(gte(heartbeatBeats.startedAt, dayStart))
    .all();
  let requests = 0;
  for (const row of rows) for (const step of sentSteps(row.triage)) requests += requestsOf(step);
  return requests;
}

/** What the page's checks block is built from. */
export interface ChecksInput {
  /** Where the next check runs, live. */
  runsOn: 'credits' | 'runtime';
  /** The agent's runtime type. */
  runtime: string;
  /** Today's checks. */
  today: ChecksToday;
  /** Whether the offer stands: linked, and nobody has answered. */
  offerOpen: boolean;
  /** Whether the viewer owns this install: only the owner may answer. */
  viewerIsOwner: boolean;
}

/**
 * The Heartbeat page's checks block.
 *
 * @param input - What it is built from.
 */
export function checksStatus(input: ChecksInput): HeartbeatChecks {
  return {
    runsOn: input.runsOn,
    runtime: input.runtime,
    today: input.today.checks,
    tokens: input.today.tokens,
    offer: input.offerOpen && input.viewerIsOwner,
  };
}

/**
 * Whether the one-time offer stands. Never while heartbeats are off: nothing
 * would use the answer, and the one notification would be spent on nothing.
 *
 * @param choice - `heartbeats.triageOnCredits`.
 * @param creditsCanBeHad - Linked, and credits not switched off.
 * @param heartbeatsEnabled - `heartbeats.enabled`.
 */
export function offerOpen(
  choice: boolean | null | undefined,
  creditsCanBeHad: boolean,
  heartbeatsEnabled: boolean
): boolean {
  return heartbeatsEnabled && (choice ?? null) === null && creditsCanBeHad;
}

/** Where the offer's notification is remembered, under the data directory. */
const OFFER_STATE_FILE = path.join('state', 'heartbeat-credits-offer.json');

/** What the offer needs to raise its one notification. */
export interface OfferNotifyDeps {
  /** The data directory. */
  dorkHome: string;
  /** Whether the offer stands now. */
  open(): boolean;
  /** Raise the notification. */
  notify(): Promise<unknown>;
  /** Now, as ISO 8601. */
  nowIso(): string;
}

/**
 * Raise the offer's one notification, if the offer stands and it was never
 * raised on this computer. Never throws.
 *
 * @param deps - Where it is remembered, and how it is raised.
 * @returns Whether it was raised now.
 */
export async function notifyOfferOnce(deps: OfferNotifyDeps): Promise<boolean> {
  if (!deps.open()) return false;
  const file = path.join(deps.dorkHome, OFFER_STATE_FILE);
  try {
    if (await alreadyRaised(file)) return false;
    // Remembered first: a notification that fails to raise is a missed
    // notification, never a second one.
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify({ raisedAt: deps.nowIso() }));
    await deps.notify();
    return true;
  } catch (err) {
    logger.debug('[Heartbeats] Could not raise the credits offer', { err });
    return false;
  }
}

/** Whether the offer's notification was raised on this computer before. */
async function alreadyRaised(file: string): Promise<boolean> {
  try {
    await readFile(file, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
