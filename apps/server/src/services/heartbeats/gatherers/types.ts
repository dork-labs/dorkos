/**
 * What a gatherer is (spec `heartbeats` §5): plain code that reads what changed
 * for one agent since its last beat, with no model.
 *
 * @module services/heartbeats/gatherers/types
 */
import type { HeartbeatGatherer } from '@dorkos/shared/heartbeat-schemas';
import type { TurnMarks } from '../../core/turn-power/turn-marks.js';

/** What a change touches that triage must be confident about (canon §5.2 step 3). */
export type ChangeTouch = 'money' | 'customers' | 'security';

/** One thing that changed for an agent. */
export interface Change {
  /** Which gatherer found it. */
  gatherer: HeartbeatGatherer;
  /**
   * Stable for the same underlying fact (`room-entry:<id>`, `run:<id>`,
   * `commitment:<id>`): it drives raise-once and de-duplication (§9.2).
   */
  key: string;
  /** One plain line. Never a message body. */
  summary: string;
  /** When it happened (ISO 8601). */
  at: string;
  /** What it touches, when that is known. */
  touches?: ChangeTouch[];
  /** What it points at. */
  ref?: { kind: string; id: string };
  /**
   * What kind of fact this is, for the rules rung (§6.1): an unanswered local
   * message, an overdue commitment, a failed or parked run, a lost connection, a
   * failing check on the agent's own branch, a failure of its own beats, or
   * something informational.
   */
  signal:
    | 'unanswered'
    | 'commitment-due'
    | 'commitment-overdue'
    | 'run-failed'
    | 'connection-lost'
    | 'check-failed'
    | 'beat-failed'
    | 'self-refused'
    | 'usage-high'
    | 'commits'
    | 'info';
  /**
   * The turn marks the fact was written under, when it was (DOR-3036): another agent's post
   * that a teammate's chain or a stranger's words wrote. A beat that reads it carries them.
   */
  marks?: TurnMarks;
}

/** The agent a beat is for, as gatherers read it. */
export interface GatherAgent {
  /** Mesh id. */
  id: string;
  /** Display name. */
  name: string;
  /** Its home directory. */
  projectPath: string;
  /** Where it works, when it has a working directory of its own. */
  cwd: string | null;
}

/** What every gatherer is handed. */
export interface GatherContext {
  /** The agent. */
  agent: GatherAgent;
  /** The last beat's start (ISO 8601), or null before its first. */
  since: string | null;
  /** Now. */
  now: Date;
  /** Abort when the gatherer's time is up. */
  signal: AbortSignal;
  /**
   * The chats the agent's own beat turns ran in: what its beats did is not news
   * to its next beat.
   */
  ownBeatSessions: ReadonlySet<string>;
}

/** One gatherer. Must resolve; a throw becomes a `health` change. */
export type Gatherer = (ctx: GatherContext) => Promise<Change[]>;
