/**
 * When a scheduled task's own agent may vouch for it in place of a person
 * (DOR-3703, Security ruling of Nov 3, 02:00, accepted by PM).
 *
 * Above Don't ask, a task runs only on content a person approved, OR when
 * every one of these holds for the write:
 *
 * 1. The writer is the task's own agent (an agent-proposed task counts only
 *    when the task's agent proposed it), from a chat whose folder vouches for
 *    it (`home`: not a worktree, a dispatch, a token or nothing), in a turn
 *    that read no outside words, on a task whose content no outsider wrote.
 * 2. The mode is no looser than the agent's person-set level: the decision's
 *    ceiling at the write, and `parkIfAgentApprovalStale` again at dispatch.
 * 3. A scheduled run of a task may change timing or lower a mode; its raise
 *    parks (a prompt edit parks for every agent, DOR-3651).
 *
 * The vouch is recorded as its own attestation (`agent-mode-record-field.ts`),
 * never as a person's approval.
 *
 * @module services/tasks/agent-mode/agent-mode-attest
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  clampModeToCeiling,
  levelOfMode,
  READ_ONLY_LEVEL,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import type { AgentModeCaller } from './agent-mode-decision.js';

/** A folder's real path, or its resolved spelling when it cannot be read. */
function realOr(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Whether two agent homes are the same folder.
 *
 * @param a - One home.
 * @param b - The other.
 */
export function sameHome(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && realOr(a) === realOr(b);
}

/**
 * Whether `mode` is looser than `from`, by the rule a chat's ceiling uses: a
 * raise. A new task (no `from`) raises nothing.
 *
 * @param declared - The runtime's modes.
 * @param mode - The mode after.
 * @param from - The mode before.
 */
export function isRaise(declared: DeclaredModes, mode: string, from: string | null): boolean {
  if (!from || from === mode) return false;
  const level = levelOfMode(declared, from) ?? READ_ONLY_LEVEL;
  return clampModeToCeiling(declared, mode, level) !== mode;
}

/** The facts the vouch is decided on. */
export interface OwnWriteFacts {
  /** Who is writing. */
  caller: AgentModeCaller;
  /** The home of the agent the task runs as. */
  owner: string | undefined;
  /** Who proposed the task, `null` when a person made it. */
  proposer: string | null | undefined;
  /** Whether the task's content came from words DorkOS cannot vouch for. */
  outsiderContent: boolean;
  /** Whether this write raises the mode. */
  raise: boolean;
}

/**
 * Whether the task's own agent vouches for this write in place of a person:
 * conditions 1 and 3 of the module TSDoc (2 is the ceiling's).
 *
 * @param facts - See {@link OwnWriteFacts}.
 */
export function ownAgentVouches(facts: OwnWriteFacts): boolean {
  const { caller } = facts;
  if (!caller.structural || caller.marked || caller.resolved !== 'home') return false;
  if (!sameHome(facts.owner, caller.agentPath)) return false;
  if (facts.proposer && !sameHome(facts.proposer, facts.owner)) return false;
  if (facts.outsiderContent) return false;
  return !(caller.scheduledRun === true && facts.raise);
}
