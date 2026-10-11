/**
 * The `health` gatherer (spec `heartbeats` §5, canon §5.4 step 6): the agent's
 * own errors and refusals, connections that lost access, its beat turns'
 * failures, and a beat-turn day well above its usual.
 *
 * What the agent's own beat turns did is left out of the errors and refusals:
 * a beat looking at what its last beat tripped over would feed itself. A heavy
 * day is a record line, never a reason for another turn (triage reads it as
 * quiet).
 *
 * @module services/heartbeats/gatherers/health
 */
import { and, desc, eq, gt, inArray, like, not } from 'drizzle-orm';
import {
  agentConnectionAttachments,
  auditEvents,
  connections,
  heartbeatBeats,
  type Db,
} from '@dorkos/db';
import type { Change, GatherContext, Gatherer } from './types.js';

/** One day, in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The most audit rows one beat reads. */
const AUDIT_LIMIT = 20;

/** Beat outcomes that ran a turn. */
const TURN_OUTCOMES: readonly string[] = ['worked', 'no-end-beat', 'failed'];

/** A day well above usual: twice the seven-day daily average. */
export const USAGE_HIGH_FACTOR = 2;

/**
 * The agent's own failed or refused actions since the last beat, its beats'
 * own turns left out.
 *
 * @param db - The database.
 * @param ctx - The beat.
 * @param since - The window's start.
 */
function ownFailures(db: Db, ctx: GatherContext, since: string): Change[] {
  return db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      action: auditEvents.action,
      outcome: auditEvents.outcome,
      sessionId: auditEvents.sessionId,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorId, ctx.agent.id),
        inArray(auditEvents.outcome, ['failed', 'refused']),
        gt(auditEvents.at, since),
        not(like(auditEvents.action, 'heartbeat.%'))
      )
    )
    .orderBy(desc(auditEvents.seq))
    .limit(AUDIT_LIMIT)
    .all()
    .filter((row) => !row.sessionId || !ctx.ownBeatSessions.has(row.sessionId))
    .map((row) => ({
      gatherer: 'health' as const,
      key: `audit:${row.id}`,
      summary: `${row.action} was ${row.outcome === 'refused' ? 'refused' : 'a failure'}.`,
      at: row.at,
      ref: { kind: 'audit', id: row.id },
      signal: 'self-refused' as const,
    }));
}

/**
 * The agent's connections that lost access. A standing condition: the runner
 * counts it as work only the first time its key (which carries the status)
 * appears.
 *
 * @param db - The database.
 * @param ctx - The beat.
 */
function lostConnections(db: Db, ctx: GatherContext): Change[] {
  return db
    .select({ id: connections.id, label: connections.label, status: connections.status })
    .from(agentConnectionAttachments)
    .innerJoin(connections, eq(connections.id, agentConnectionAttachments.connectionId))
    .where(
      and(
        eq(agentConnectionAttachments.agentId, ctx.agent.id),
        inArray(connections.status, ['expired', 'revoked']),
        eq(connections.lifecycleState, 'connected')
      )
    )
    .all()
    .map((connection) => ({
      gatherer: 'health' as const,
      key: `connection:${connection.id}:${connection.status}`,
      summary: `Your "${connection.label}" connection lost access (${connection.status}).`,
      at: ctx.now.toISOString(),
      ref: { kind: 'connection', id: connection.id },
      signal: 'connection-lost' as const,
    }));
}

/**
 * Its failed beats since the last one, and a heavy day of beat turns.
 *
 * @param db - The database.
 * @param ctx - The beat.
 * @param since - The window's start.
 */
function beatHealth(db: Db, ctx: GatherContext, since: string): Change[] {
  const now = ctx.now.getTime();
  const beats = db
    .select({
      id: heartbeatBeats.id,
      startedAt: heartbeatBeats.startedAt,
      outcome: heartbeatBeats.outcome,
    })
    .from(heartbeatBeats)
    .where(
      and(
        eq(heartbeatBeats.agentId, ctx.agent.id),
        gt(heartbeatBeats.startedAt, new Date(now - 7 * DAY_MS).toISOString())
      )
    )
    .all();
  const changes: Change[] = beats
    .filter((beat) => beat.outcome === 'failed' && beat.startedAt > since)
    .map((beat) => ({
      gatherer: 'health',
      key: `beat-failed:${beat.id}`,
      summary: 'One of your beats failed.',
      at: beat.startedAt,
      ref: { kind: 'beat', id: beat.id },
      signal: 'beat-failed',
    }));
  const turns = beats.filter((beat) => TURN_OUTCOMES.includes(beat.outcome ?? ''));
  const today = turns.filter((beat) => Date.parse(beat.startedAt) >= now - DAY_MS).length;
  const average = (turns.length - today) / 6;
  if (average > 0 && today > USAGE_HIGH_FACTOR * average) {
    changes.push({
      gatherer: 'health',
      key: `usage:${ctx.now.toISOString().slice(0, 10)}`,
      summary: `Your beats ran ${today} turns in the last day, against about ${Math.round(average)} a day.`,
      at: ctx.now.toISOString(),
      signal: 'usage-high',
    });
  }
  return changes;
}

/**
 * Build the gatherer over the audit, connection and beat tables.
 *
 * @param db - The server's database.
 */
export function createHealthGatherer(db: Db): Gatherer {
  return async (ctx: GatherContext): Promise<Change[]> => {
    const since = ctx.since ?? new Date(ctx.now.getTime() - DAY_MS).toISOString();
    return [
      ...ownFailures(db, ctx, since),
      ...lostConnections(db, ctx),
      ...beatHealth(db, ctx, since),
    ];
  };
}
