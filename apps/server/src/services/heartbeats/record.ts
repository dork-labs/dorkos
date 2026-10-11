/**
 * The record line (spec `heartbeats` §11): one `heartbeat.beat` audit row per
 * beat, quiet ones included, beside its `heartbeat_beats` row.
 *
 * Actor and target are the agent; the source is `system`, with the beat chat
 * when a turn ran; `links.causedBy` is the waking event's id when there is one;
 * the summary is one line and never holds a message body. Everyone in the space
 * reads it (`visibility: 'space'`).
 *
 * @module services/heartbeats/record
 */
import type { AuditOutcome } from '@dorkos/shared/audit-schemas';
import type { BeatOutcome } from '@dorkos/shared/heartbeat-schemas';
import { recordAudit } from '../audit/audit-trail.js';
import type { HeartbeatStore } from './heartbeat-store.js';

/** How long a beat row is kept. Its audit row stays forever. */
export const BEAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The longest record line, matching `end_beat`'s summary cap. */
const SUMMARY_MAX = 200;

/** The audit outcome a beat outcome records as. */
const AUDIT_OUTCOME: Record<BeatOutcome, AuditOutcome> = {
  quiet: 'ok',
  queued: 'ok',
  worked: 'ok',
  'no-end-beat': 'ok',
  skipped: 'ok',
  failed: 'failed',
  refused: 'refused',
};

/** What one beat's record line says. */
export interface BeatRecord {
  /** The agent. */
  agent: { id: string; name: string };
  /** How the beat ended. */
  outcome: BeatOutcome;
  /** The one line. Never a message body. */
  summary: string;
  /** The beat chat, when a turn ran. */
  sessionId?: string;
  /** The waking event's id, when one woke it. */
  causedBy?: string;
  /** Why it was refused or failed, when it was. */
  reason?: string;
}

/**
 * The account id an agent acts as in the record: its mesh id, named the way
 * the audit trail names agents.
 *
 * @param agent - The agent.
 * @param agent.id - Its mesh id.
 * @param agent.name - Its display name.
 */
function agentActor(agent: { id: string; name: string }) {
  return { kind: 'agent' as const, accountId: agent.id, name: agent.name };
}

/**
 * Write a beat's record line.
 *
 * @param record - What the beat did.
 * @returns The audit row's seq and id, or undefined when the trail is not running.
 */
export function recordBeat(record: BeatRecord): { seq: number; id: string } | undefined {
  const summary =
    record.summary.length > SUMMARY_MAX
      ? `${record.summary.slice(0, SUMMARY_MAX - 1)}…`
      : record.summary;
  const event = recordAudit({
    actor: agentActor(record.agent),
    source: { surface: 'system', ...(record.sessionId ? { sessionId: record.sessionId } : {}) },
    action: 'heartbeat.beat',
    operation: 'execute',
    target: { type: 'agent', id: record.agent.id, name: record.agent.name },
    outcome: AUDIT_OUTCOME[record.outcome],
    ...(record.reason ? { reason: record.reason } : {}),
    summary,
    ...(record.causedBy ? { links: { causedBy: record.causedBy } } : {}),
    visibility: 'space',
  });
  return event ? { seq: event.seq, id: event.id } : undefined;
}

/**
 * Write a heartbeat record row that is not a beat (`heartbeat.skipped`,
 * `heartbeat.config_invalid`, `heartbeat.held`, `heartbeat.delivered` …), linked
 * back to the beat's row when there is one.
 *
 * @param input - The row.
 * @param input.action - `heartbeat.<verb>`.
 * @param input.agent - The agent it is about.
 * @param input.summary - One line.
 * @param input.outcome - Defaults to `ok`.
 * @param input.reason - Why, when it matters.
 * @param input.causedBy - The audit id of the beat row it follows from.
 * @param input.actAsAgent - Record the agent as the actor rather than DorkOS.
 */
export function recordHeartbeatEvent(input: {
  action: string;
  agent: { id: string; name: string };
  summary: string;
  outcome?: AuditOutcome;
  reason?: string;
  causedBy?: string;
  actAsAgent?: boolean;
}): void {
  recordAudit({
    ...(input.actAsAgent ? { actor: agentActor(input.agent) } : {}),
    source: { surface: 'system' },
    action: input.action,
    operation: 'execute',
    target: { type: 'agent', id: input.agent.id, name: input.agent.name },
    outcome: input.outcome ?? 'ok',
    ...(input.reason ? { reason: input.reason } : {}),
    summary: input.summary,
    ...(input.causedBy ? { links: { causedBy: input.causedBy } } : {}),
    visibility: 'space',
  });
}

/**
 * Delete beat rows past the retention window.
 *
 * @param store - The heartbeat tables.
 * @param now - Epoch ms.
 */
export function pruneOldBeats(store: HeartbeatStore, now: number): number {
  return store.pruneBeats(new Date(now - BEAT_RETENTION_MS).toISOString());
}
