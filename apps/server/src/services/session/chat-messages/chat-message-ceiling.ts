/**
 * The sender's bound a chat message carries, read back from its row, and what
 * it means for the chat the message opens.
 *
 * @module services/session/chat-messages/chat-message-ceiling
 */
import type {
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import { ceilingCarrying, marksOfLevel } from '../../core/turn-power/turn-marks.js';
import type { TurnOrigin } from '../origin/turn-origin.js';

/** Reads the level a person set an agent to (`posterLevel`, rooms' own-circle rule). */
export type OwnLevelReader = (
  agentPath: string,
  sessionIds: readonly string[]
) => Promise<TurnPermissionBound>;

/**
 * The bound a message from a chat carries (DOR-3107, marks not levels). A
 * sending turn KNOWN to carry no mark passes on only the level a person set its
 * agent and its chat to, which is no cap at all for an agent at Full autonomy:
 * its level was never the risk, only what its turn read. A marked turn, or one
 * whose level is unknown, is held to the receiving runtime's default, beside
 * its own level so the marks ride on (`ceilingCarrying`): a turn at Full that
 * a stranger's words reached hands on the cap, not its Full level.
 *
 * @param level - The sending chat's level as it hands it on (`passedOnLevelOf`).
 * @param caller - The sending chat and its agent.
 * @param ownLevelOf - Reads the person-set level; without one, the old rule.
 */
export async function senderBound(
  level: TurnPermissionLevel | undefined,
  caller: { sessionId: string; agentPath: string },
  ownLevelOf: OwnLevelReader | undefined
): Promise<TurnPermissionCeiling> {
  if (level === undefined) return 'runtime-default';
  const carried = ceilingCarrying(marksOfLevel(level));
  if (carried !== undefined) return [level, ...boundsOf(carried)];
  if (!ownLevelOf) return level;
  return ownLevelOf(caller.agentPath, [caller.sessionId]);
}

/** A ceiling as the list of bounds that all hold. */
export function boundsOf(ceiling: TurnPermissionCeiling): readonly TurnPermissionBound[] {
  return Array.isArray(ceiling)
    ? (ceiling as readonly TurnPermissionBound[])
    : [ceiling as TurnPermissionBound];
}

/**
 * Read a stored ceiling; anything unreadable is the runtime's default.
 *
 * @param json - The row's `ceilingJson`.
 */
export function parseCeiling(json: string): TurnPermissionCeiling {
  try {
    const value = JSON.parse(json) as unknown;
    // Several bounds that all hold (a marked sender's level and its cap).
    if (Array.isArray(value)) {
      const bounds = value.map((one): TurnPermissionBound =>
        Array.isArray(one)
          ? 'runtime-default'
          : (parseCeiling(JSON.stringify(one)) as TurnPermissionBound)
      );
      return bounds.length === 0 ? 'runtime-default' : bounds.length === 1 ? bounds[0]! : bounds;
    }
    if (value === 'runtime-default') return value;
    if (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { asks?: unknown }).asks === 'string' &&
      typeof (value as { reach?: unknown }).reach === 'string'
    ) {
      return value as TurnPermissionLevel;
    }
  } catch {
    // fall through
  }
  return 'runtime-default';
}

/**
 * Whether the sending turn was marked: it read words DorkOS cannot vouch for,
 * or its level is not known (which is bounded the same way).
 *
 * @param bound - The sender's bound.
 */
export function isMarkedBound(bound: TurnPermissionCeiling): boolean {
  return boundsOf(bound).some((one) => one === 'runtime-default' || one.outsider === true);
}

/**
 * The origin of the turn a chat message starts. A message from a marked turn
 * opens a chat that does NOT inherit its agent's own level (DOR-3107,
 * Security): an agent set to Full autonomy that a stranger's words reached
 * must not hand that level to a chat it opens.
 *
 * @param ceilingJson - The message row's stored sender bound.
 */
export function chatMessageOrigin(ceilingJson: string): TurnOrigin {
  return isMarkedBound(parseCeiling(ceilingJson))
    ? { kind: 'chat-message', marked: true }
    : { kind: 'chat-message' };
}
