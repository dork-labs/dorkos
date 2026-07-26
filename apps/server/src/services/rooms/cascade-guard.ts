/**
 * Bounds agent-to-agent loops on the room path (spec `rooms` §6,
 * ADR 260726-170127).
 *
 * The relay's budget envelope does not reach here. `enforceBudget` has exactly
 * two call sites, both inside `packages/relay`, and nothing in
 * `services/session` constructs an envelope — the budget is a property of the
 * relay transport, not of the session spine, so a room built on the durable log
 * inherits none of it. Routing room triggers through the relay to borrow the
 * guard would re-add the per-endpoint file writes and per-endpoint watchers the
 * multi-user research already rejected, to buy thirty lines of arithmetic.
 *
 * Two rules, and the second is the load-bearing one. A pure depth counter
 * permits N-1 wasted model calls before it fires; the ancestry rule kills
 * A→B→A at the first repeat.
 *
 * Pure — the caller supplies the provenance it read. Nothing calls this yet:
 * R1 ships the rule and its tests, R3 wires triggering.
 *
 * @module server/services/rooms/cascade-guard
 */
import type { RoomEntryBody } from '@dorkos/shared/room-schemas';

/** Why a trigger was refused. */
export type CascadeRefusalReason = 'depth' | 'ancestry';

/**
 * The provenance a trigger carries, read off the entry that would trigger it
 * plus one indexed query over the cascade.
 */
export interface CascadeProvenance {
  /** Entry id that began this cascade — `cascadeRoot` of the triggering entry. */
  root: string;
  /** `cascadeDepth` of the triggering entry. The triggered turn inherits this + 1. */
  depth: number;
  /**
   * Distinct author ids already in this cascade
   * (`SELECT DISTINCT author_id FROM room_entries WHERE room_id = ? AND cascade_root = ?`).
   */
  authorsInCascade: readonly string[];
}

/** The verdict on one prospective trigger. */
export interface CascadeDecision {
  allowed: boolean;
  /** The depth the triggered turn would carry (`provenance.depth + 1`). */
  depth: number;
  /** Set only when `allowed` is false. */
  reason?: CascadeRefusalReason;
}

/**
 * How many automatic replies deep a cascade may run.
 *
 * A server constant rather than user config for now: nothing triggers until R3,
 * and a config field a user can turn with no observable effect is worse than no
 * field at all. R3 promotes it to `UserConfigSchema` with its migration, where
 * it first means something.
 */
export const DEFAULT_MAX_AGENT_DEPTH = 3;

/**
 * Decide whether `targetAuthorId` may be triggered from an entry with this
 * provenance.
 *
 * @param targetAuthorId - The agent author the trigger would run.
 * @param provenance - The triggering entry's cascade root, depth, and prior authors.
 * @param opts.maxAgentDepth - The ceiling; defaults to {@link DEFAULT_MAX_AGENT_DEPTH}.
 * @returns Whether to trigger, the depth it would carry, and the refusal reason.
 */
export function evaluateCascade(
  targetAuthorId: string,
  provenance: CascadeProvenance,
  opts: { maxAgentDepth?: number } = {}
): CascadeDecision {
  const maxAgentDepth = opts.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
  const depth = provenance.depth + 1;

  if (depth > maxAgentDepth) return { allowed: false, depth, reason: 'depth' };
  if (provenance.authorsInCascade.includes(targetAuthorId)) {
    return { allowed: false, depth, reason: 'ancestry' };
  }
  return { allowed: true, depth };
}

/**
 * Where a post's own cascade begins.
 *
 * A human's post always starts fresh — its own id at depth 0 — which is exactly
 * what lets a person re-engage a room the guard has stopped. An agent's post
 * inherits the provenance of the trigger that produced it; without a trigger
 * (an agent posting of its own accord) it starts fresh too.
 *
 * @param entryId - The id of the entry being written.
 * @param trigger - The cascade the writing turn was triggered under, if any.
 * @returns The `cascadeRoot` / `cascadeDepth` to persist on the entry.
 */
export function deriveCascade(
  entryId: string,
  trigger?: { root: string; depth: number }
): { cascadeRoot: string; cascadeDepth: number } {
  if (!trigger) return { cascadeRoot: entryId, cascadeDepth: 0 };
  return { cascadeRoot: trigger.root, cascadeDepth: trigger.depth };
}

/**
 * The durable `notice` a refused trigger writes into the room.
 *
 * A silently dropped trigger is indistinguishable from a broken agent, and in a
 * shared room the person who notices is not the person who configured it. So
 * the room says what happened in its own voice — no stack trace, no reason code
 * in the prose — and says what to do about it.
 *
 * @param agentName - Display name of the agent that did not reply.
 * @param subjectAuthorId - Author id of that agent, for rendering.
 */
export function buildCascadeNotice(agentName: string, subjectAuthorId: string): RoomEntryBody {
  return {
    text: `${agentName} stopped replying here — this back-and-forth hit its automatic-reply limit. Send a message to pick it back up.`,
    notice: 'cascade_stopped',
    subjectAuthorId,
  };
}
