/**
 * Open work that has stalled (DOR-3674): the half of the `commitments` gatherer
 * that sees what the agent started or owes going quiet, not only what falls due.
 *
 * On 2026-11-02 every lane chat ended its turn and nothing woke them for about
 * five hours: a beat read mentions, promises due, schedules and health, and
 * never saw work that simply stopped. So a beat now counts as work when:
 *
 * - a spin-off chat the agent started (a lane) has been idle for
 *   {@link LANE_STALL_MS}; or
 * - the agent has an open promise, due or not, and none of its chats but its
 *   own beat chats has run for {@link IDLE_WITH_PROMISE_MS}.
 *
 * Each item is named by its id, with the time it went quiet, in a fixed line: never the
 * text a chat or a promise carries, which can come from a room (Security on DOR-3674). It
 * only reads, and starts or messages nothing; the beat decides what to do. A stall wakes the agent at
 * most {@link MAX_NUDGES} times: its key carries how many stall periods have
 * passed, capped, so once the cap is reached the key stops changing and the
 * standing rule (`triage-rules.ts`) counts it no more. A lane that runs again
 * gets a new idle time, so a new stall starts from one.
 *
 * It lives inside `commitments` on purpose: every `HEARTBEAT.md` watches that
 * gatherer already, and a new gatherer name would reach nobody whose file lists
 * its own `watch:`. A paused agent, or one whose beats are off, never gets here
 * (`beat-runner.ts` gates both before any gatherer runs).
 *
 * @module services/heartbeats/gatherers/open-work
 */
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import type { Change, GatherContext } from './types.js';

/** How long a lane may sit idle before it counts as stalled. */
export const LANE_STALL_MS = 2 * 60 * 60 * 1000;

/** How long the agent may run no chat at all, with a promise open, before it counts. */
export const IDLE_WITH_PROMISE_MS = 30 * 60 * 1000;

/** How many times one stall may wake the agent before it only shows. */
export const MAX_NUDGES = 2;

/** One spin-off chat the agent started. */
export interface OpenLane {
  /** The lane's chat id. */
  sessionId: string;
  /** When it was started (ISO 8601). */
  startedAt: string;
}

/** What open-work reads, besides the agent's promises. */
export interface OpenWorkReader {
  /** The lanes the agent started that are recent enough to still be its work. */
  lanesOf(agent: GatherContext['agent'], now: Date): Promise<OpenLane[]>;
  /** Whether a chat is mid-turn right now. */
  isRunning(sessionId: string): boolean;
  /** When a chat was last seen active (ms), or undefined when this process never saw it. */
  lastActiveAt(sessionId: string): number | undefined;
  /**
   * Whether any of the agent's chats but `excluding` runs now (`'running'`), else when one was
   * last seen active (ms), or undefined when this process never saw one.
   */
  agentActivity(agentId: string, excluding: ReadonlySet<string>): 'running' | number | undefined;
  /** When this process started watching (ms): the floor for "since" when nothing was seen. */
  watchingSince(): number;
}

/**
 * How many stall periods a quiet stretch has run, capped at {@link MAX_NUDGES}; 0 before the
 * first. It is part of the change key, so the cap is what stops the waking.
 */
function nudgeOf(idleMs: number, firstAfterMs: number, periodMs: number): number {
  if (idleMs < firstAfterMs) return 0;
  return Math.min(MAX_NUDGES, 1 + Math.floor((idleMs - firstAfterMs) / periodMs));
}

/** One stalled item, as a change. */
function stalled(key: string, summary: string, since: number, ref: Change['ref']): Change {
  return {
    gatherer: 'commitments',
    key,
    summary,
    at: new Date(since).toISOString(),
    ...(ref ? { ref } : {}),
    signal: 'work-stalled',
  };
}

/**
 * The stalled lanes and promises for one beat.
 *
 * @param ctx - The beat's context.
 * @param promises - The agent's open promises.
 * @param reader - Where lanes and chat activity are read.
 */
export async function openWorkChanges(
  ctx: GatherContext,
  promises: readonly Commitment[],
  reader: OpenWorkReader
): Promise<Change[]> {
  const now = ctx.now.getTime();
  const floor = reader.watchingSince();
  const changes: Change[] = [];

  for (const lane of await reader.lanesOf(ctx.agent, ctx.now)) {
    if (ctx.ownBeatSessions.has(lane.sessionId) || reader.isRunning(lane.sessionId)) continue;
    const started = Date.parse(lane.startedAt);
    const since = Math.max(
      reader.lastActiveAt(lane.sessionId) ?? floor,
      Number.isNaN(started) ? floor : started
    );
    const nudge = nudgeOf(now - since, LANE_STALL_MS, LANE_STALL_MS);
    if (nudge === 0) continue;
    changes.push(
      stalled(
        `stalled:lane:${lane.sessionId}@${since}#${nudge}`,
        `Lane ${lane.sessionId} quiet since ${new Date(since).toISOString()}`,
        since,
        { kind: 'session', id: lane.sessionId }
      )
    );
  }

  if (promises.length > 0) {
    const activity = reader.agentActivity(ctx.agent.id, ctx.ownBeatSessions);
    if (activity !== 'running') {
      const since = Math.max(activity ?? floor, floor);
      const nudge = nudgeOf(now - since, IDLE_WITH_PROMISE_MS, LANE_STALL_MS);
      if (nudge > 0) {
        for (const promise of promises) {
          changes.push(
            stalled(
              `stalled:commitment:${promise.id}@${since}#${nudge}`,
              `Commitment ${promise.id} open, no chat running since ${new Date(since).toISOString()}`,
              since,
              { kind: 'commitment', id: promise.id }
            )
          );
        }
      }
    }
  }
  return changes;
}
