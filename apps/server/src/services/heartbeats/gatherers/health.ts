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
 * A tool that failed inside one of the agent's runtimes (`runtime.tool_used`)
 * is mostly normal work: a grep with no match, a `--help` that exits 1. The
 * turn that ran it already saw the error and went on. So one such failure is
 * information, and it asks for a turn only when it looks like real trouble
 * (see {@link isTroubleToolFailure}).
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
import { FILE_WRITING_TOOLS } from '../measures/measure-records.js';
import type { Change, GatherContext, Gatherer } from './types.js';

/** One day, in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The most failures one beat reports. */
const AUDIT_LIMIT = 20;

/**
 * The most audit rows one beat reads to find them: more than it reports, so a
 * burst of harmless tool failures cannot push a refusal out of the window.
 */
const AUDIT_READ_LIMIT = 100;

/** How often the same tool call failing since the last beat counts as trouble. */
export const REPEATED_TOOL_FAILURES = 3;

/** Errors that mean the computer itself is in trouble, whatever tool met them. */
const MACHINE_TROUBLE =
  /ENOSPC|no space left|EDQUOT|disk quota|EROFS|read-only file system|ENOMEM|out of memory/i;

/** Errors that mean the agent could not write where it works. */
const ACCESS_TROUBLE = /EACCES|EPERM|permission denied|operation not permitted/i;

/**
 * Whether a failed runtime tool call is trouble rather than everyday work. Its
 * error says the disk is full, read-only or out of memory; or a file-writing
 * tool was denied access (a shell `find` meets "permission denied" all day,
 * an `Edit` should not); or the same call failed {@link REPEATED_TOOL_FAILURES}
 * times since the last beat. The error is often absent (a main turn's stream
 * carries none), so repetition is the rule that always applies.
 *
 * @param failure - The failure.
 * @param failure.tool - The tool's name.
 * @param failure.error - Its recorded error, when there is one.
 * @param failure.repeats - How many times the same call failed since the last beat.
 */
export function isTroubleToolFailure(failure: {
  tool: string;
  error: string | null;
  repeats: number;
}): boolean {
  if (failure.repeats >= REPEATED_TOOL_FAILURES) return true;
  if (!failure.error) return false;
  if (MACHINE_TROUBLE.test(failure.error)) return true;
  return FILE_WRITING_TOOLS.has(failure.tool.toLowerCase()) && ACCESS_TROUBLE.test(failure.error);
}

/**
 * The tool and the call a `runtime.tool_used` summary names ("Tried Bash (in a
 * helper): grep foo"): the call is the tool and its target, helper or not.
 *
 * @param summary - The row's summary.
 */
function toolCallOf(summary: string): { tool: string; call: string } {
  const match = /^Tried (\S+?)(?: \(in a helper\))?(?::\s*(.*))?$/s.exec(summary);
  if (!match) return { tool: '', call: summary };
  return { tool: match[1]!, call: `${match[1]}\u0000${match[2] ?? ''}` };
}

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
  const rows = db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      action: auditEvents.action,
      outcome: auditEvents.outcome,
      sessionId: auditEvents.sessionId,
      summary: auditEvents.summary,
      error: auditEvents.error,
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
    .limit(AUDIT_READ_LIMIT)
    .all()
    .filter((row) => !row.sessionId || !ctx.ownBeatSessions.has(row.sessionId));
  const isToolFailure = (row: (typeof rows)[number]): boolean =>
    row.action === 'runtime.tool_used' && row.outcome === 'failed';
  const repeats = new Map<string, number>();
  for (const row of rows.filter(isToolFailure)) {
    const { call } = toolCallOf(row.summary);
    repeats.set(call, (repeats.get(call) ?? 0) + 1);
  }
  const signalOf = (row: (typeof rows)[number]): Change['signal'] => {
    if (!isToolFailure(row)) return 'self-refused';
    const { tool, call } = toolCallOf(row.summary);
    return isTroubleToolFailure({ tool, error: row.error, repeats: repeats.get(call) ?? 0 })
      ? 'self-refused'
      : 'info';
  };
  const changes = rows.map((row) => ({
    gatherer: 'health' as const,
    key: `audit:${row.id}`,
    summary: `${row.action} was ${row.outcome === 'refused' ? 'refused' : 'a failure'}.`,
    at: row.at,
    ref: { kind: 'audit', id: row.id },
    signal: signalOf(row),
  }));
  // Trouble first, newest first within each, so the cap drops information only.
  return [
    ...changes.filter((change) => change.signal !== 'info'),
    ...changes.filter((change) => change.signal === 'info'),
  ].slice(0, AUDIT_LIMIT);
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
