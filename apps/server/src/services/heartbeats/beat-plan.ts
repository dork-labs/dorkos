/**
 * What one beat reads before it starts (spec `heartbeats` §2, §3.2): the
 * agent's `HEARTBEAT.md`, read fresh every beat, and the facts the cadence
 * table reads.
 *
 * - **Edits apply at the next beat.** The file is read on every beat, so a
 *   change takes effect without a restart (OpenClaw #51542 is the bug this
 *   avoids).
 * - **An invalid header keeps the last valid one in force** (its hash and value
 *   are kept in `heartbeat_state`) and is recorded once per distinct broken
 *   header (`heartbeat.config_invalid`), never silently ignored.
 *
 * @module services/heartbeats/beat-plan
 */
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import {
  HeartbeatFrontmatterSchema,
  resolveHeartbeatSettings,
  type HeartbeatFrontmatter,
  type HeartbeatSettings,
} from '@dorkos/shared/heartbeat-schemas';
import {
  isWithinWorkingHours,
  zonedDay,
  type ResolvedWorkingHours,
} from '@dorkos/shared/working-hours';
import { HEARTBEAT_MAX_CHARS } from '@dorkos/shared/convention-files';
import type { CadenceFacts } from './beat-scheduler.js';
import { readHeartbeatFile, type HeartbeatFileRead } from './heartbeat-file.js';
import type { HeartbeatStore } from './heartbeat-store.js';
import { recordHeartbeatEvent } from './record.js';

/** An agent, as a plan reads it. */
export interface PlanAgent {
  /** Mesh id. */
  id: string;
  /** Display name. */
  name: string;
  /** Its home directory. */
  projectPath: string;
}

/** The facts one beat reads, resolved once. */
export interface BeatPlan<A extends PlanAgent = PlanAgent> {
  /** The agent. */
  agent: A;
  /** How it wakes and what it watches. */
  settings: HeartbeatSettings;
  /** Its `HEARTBEAT.md` body, or null with no file. */
  checklist: string | null;
  /** When the file last changed (epoch ms), or 0 with no file. */
  mtimeMs: number;
}

/** What a plan reads. */
export interface PlanDeps {
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** Reads `HEARTBEAT.md`; tests pass a fake. */
  readHeartbeat?(agentPath: string): Promise<HeartbeatFileRead>;
}

/**
 * The last valid frontmatter kept in state, or null.
 *
 * @param raw - The stored JSON.
 */
function lastValidFrontmatter(raw: string | null | undefined): HeartbeatFrontmatter | null {
  if (!raw) return null;
  try {
    const parsed = HeartbeatFrontmatterSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The frontmatter in force for one read of `HEARTBEAT.md`: the file's own when
 * it is valid, the last valid one kept in state when it is not, none when there
 * is no file. The runner and the Heartbeat page both read it, so they agree.
 *
 * @param read - The file as read.
 * @param stored - The agent's stored last valid frontmatter (JSON), if any.
 */
export function frontmatterInForce(
  read: HeartbeatFileRead,
  stored: string | null | undefined
): HeartbeatFrontmatter | null {
  if (read.kind === 'absent') return null;
  if (read.kind === 'valid') return read.frontmatter;
  return lastValidFrontmatter(stored);
}

/** Bodies already recorded as cut to the cap, by agent and length, this process. */
const truncatedRecorded = new Set<string>();

/**
 * The checklist a beat prompt carries: the file's body, cut to
 * {@link HEARTBEAT_MAX_CHARS} so a file grown on disk cannot swell every turn.
 * A cut is recorded once.
 *
 * @param agent - The agent.
 * @param body - The body as read.
 */
function checklistOf(agent: PlanAgent, body: string): string {
  if (body.length <= HEARTBEAT_MAX_CHARS) return body;
  const key = `${agent.id}:${body.length}`;
  if (!truncatedRecorded.has(key)) {
    truncatedRecorded.add(key);
    recordHeartbeatEvent({
      action: 'heartbeat.config_invalid',
      agent,
      outcome: 'refused',
      reason: `HEARTBEAT.md is ${body.length} characters; beats read the first ${HEARTBEAT_MAX_CHARS}.`,
      summary: 'Its HEARTBEAT.md is longer than beats read; the rest is left out.',
    });
  }
  return body.slice(0, HEARTBEAT_MAX_CHARS);
}

/**
 * Read an agent's `HEARTBEAT.md` and resolve what its beat runs with.
 *
 * @param deps - The store and the file reader.
 * @param agent - The agent.
 */
export async function planBeat<A extends PlanAgent>(
  deps: PlanDeps,
  agent: A
): Promise<BeatPlan<A>> {
  const read = await (deps.readHeartbeat ?? readHeartbeatFile)(agent.projectPath);
  const state = deps.store.getState(agent.id);
  if (read.kind === 'absent') {
    return { agent, settings: resolveHeartbeatSettings(null), checklist: null, mtimeMs: 0 };
  }
  if (state?.frontmatterHash !== read.hash) {
    if (read.kind === 'valid') {
      deps.store.patchState(agent.id, {
        frontmatterHash: read.hash,
        lastValidFrontmatter: JSON.stringify(read.frontmatter),
      });
    } else {
      deps.store.patchState(agent.id, { frontmatterHash: read.hash });
      recordHeartbeatEvent({
        action: 'heartbeat.config_invalid',
        agent,
        outcome: 'refused',
        reason: read.error,
        summary: 'Its HEARTBEAT.md header is not valid; the last good one stays in force.',
      });
    }
  }
  return {
    agent,
    settings: resolveHeartbeatSettings(frontmatterInForce(read, state?.lastValidFrontmatter)),
    checklist: checklistOf(agent, read.body),
    mtimeMs: read.mtimeMs,
  };
}

/** What the cadence facts read. */
export interface CadenceDeps {
  /** The heartbeat tables. */
  store: HeartbeatStore;
  /** The agent's chain person's hours. */
  hoursFor(agentId: string): ResolvedWorkingHours;
  /** Open commitments. */
  commitments: { list(filter: { agentId: string; state: 'open' }, limit?: number): Commitment[] };
  /** Whether a turn of the agent's own is running now, in any of its chats. */
  ownTurnRunning?(agentId: string): boolean;
}

/**
 * The facts the cadence table reads for an agent at a moment (§3.2). "In
 * flight" is an open commitment due today in its chain person's zone, or a turn
 * of its own still running.
 *
 * @param deps - The store, hours and commitments.
 * @param agentId - The agent.
 * @param now - Epoch ms.
 */
export function cadenceFacts(deps: CadenceDeps, agentId: string, now: number): CadenceFacts {
  const state = deps.store.getState(agentId);
  const hours = deps.hoursFor(agentId);
  const today = zonedDay(new Date(now), hours.timezone);
  const inFlight =
    deps.ownTurnRunning?.(agentId) === true ||
    deps.commitments
      .list({ agentId, state: 'open' }, 200)
      .some((c) => c.dueAt !== null && zonedDay(new Date(c.dueAt), hours.timezone) === today);
  let pace: CadenceFacts['pace'];
  try {
    pace = state?.pace ? (JSON.parse(state.pace) as CadenceFacts['pace']) : null;
  } catch {
    pace = null;
  }
  return {
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    pace,
    inFlight,
    lastChangeAt: state?.lastChangeAt ?? null,
    withinHours: isWithinWorkingHours(new Date(now), hours),
  };
}
