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
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
import { ceilingCarrying, hasMarks, marksOfLevel } from '../../core/turn-power/turn-marks.js';
import { unknownLevelMarks } from '../../core/turn-power/turn-levels.js';
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
 * is held to the receiving runtime's default, beside its own level so the
 * marks ride on (`ceilingCarrying`): a turn at Full that a stranger's words
 * reached hands on the cap, not its Full level. A sender whose level is
 * unknown (a restart) is trusted like an unmarked one (trust first, Dorian
 * 2026-10-19) unless a stranger reached its chat (`unknownLevelMarks`).
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
  if (level === undefined) {
    const marks = unknownLevelMarks([caller.sessionId], caller.agentPath);
    // A marked sender whose turn this process never recorded cannot show our own agent wrote
    // the message, so it holds the receiving turn (DOR-3390): the strict answer.
    if (marks.teammate !== undefined) return ceilingCarrying(marks)!;
    if (hasMarks(marks) || !ownLevelOf) return 'runtime-default';
    return ownLevelOf(caller.agentPath, [caller.sessionId]);
  }
  const marks = marksOfLevel(level);
  const carried = ceilingCarrying(marks);
  // An outsider's words carried on (DOR-3390, Security's Must 1): the mark rides with the level
  // a person set the sender to, never the level the sender's turn was held to, so no hold
  // spreads message to message. A teammate's chain keeps the sender's own level and its hold.
  if (carried !== undefined && marks.teammate === undefined && ownLevelOf) {
    const own = await ownLevelOf(caller.agentPath, [caller.sessionId]);
    return [own, ...boundsOf(carried)];
  }
  if (carried !== undefined) return [level, ...boundsOf(carried)];
  if (!ownLevelOf) return level;
  return ownLevelOf(caller.agentPath, [caller.sessionId]);
}

/**
 * What a chat message row stores as its sender's bound (`ceilingJson`).
 *
 * The same as {@link senderBound}, except for one case: a sender whose level
 * is unknown but which carries the outsider mark (a chat a stranger reached).
 * Its bound is a bare runtime default, which on its own is also what an
 * unknown, unmarked sender stored before this build. So the row keeps the mark
 * visibly, as `{"bound":"runtime-default","marks":{...}}` (DOR-3107, Security
 * 19:03). `parseCeiling` reads that shape as `runtime-default`, so the turn
 * runs exactly as it would with the bare value, and a later reader (the
 * existing-chats raise) can tell marked from unknown.
 *
 * @param deps - Reads the sending chat's level (`passedOnLevelOf`) and the person-set level.
 * @param caller - The sending chat and its agent.
 */
export async function senderCeilingJson(
  deps: {
    turnLevelOf: (sessionId: string) => TurnPermissionLevel | undefined;
    ownLevelOf?: OwnLevelReader;
  },
  caller: { sessionId: string; agentPath: string }
): Promise<string> {
  const level = deps.turnLevelOf(caller.sessionId);
  const bound = await senderBound(level, caller, deps.ownLevelOf);
  if (level === undefined && bound === 'runtime-default') {
    const marks = unknownLevelMarks([caller.sessionId], caller.agentPath);
    if (hasMarks(marks)) return JSON.stringify({ bound: 'runtime-default', marks });
  }
  return JSON.stringify(
    Array.isArray(bound)
      ? (bound as readonly TurnPermissionBound[]).map(storedForm)
      : storedForm(bound as TurnPermissionBound)
  );
}

/** The `bound` a stored carried mark names (`{"bound":"carried","marks":{"outsider":true}}`). */
const CARRIED_BOUND = 'carried';

/**
 * One bound as a row keeps it. The carried outsider mark (DOR-3390) is stored by name, never as
 * the loosest level it is in memory: a reader that does not know the name (an older build after a
 * rollback) reads an object with no `asks` as the runtime's default, so it fails closed.
 */
function storedForm(bound: TurnPermissionBound): unknown {
  return isCarriedOutsiderBound(bound)
    ? { bound: CARRIED_BOUND, marks: { outsider: true } }
    : bound;
}

/**
 * Whether a bound is exactly {@link CARRIED_OUTSIDER_LEVEL}: the mark, and nothing else.
 *
 * @param bound - One bound.
 */
export function isCarriedOutsiderBound(bound: TurnPermissionBound): boolean {
  if (bound === 'runtime-default') return false;
  return (
    bound.outsider === true &&
    bound.asks === CARRIED_OUTSIDER_LEVEL.asks &&
    bound.reach === CARRIED_OUTSIDER_LEVEL.reach &&
    bound.auto === undefined &&
    bound.teammate === undefined
  );
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
    // The carried outsider mark, stored by name (`storedForm`). Only this exact shape: anything
    // else that is not a level falls through to the runtime's default.
    if (
      value !== null &&
      typeof value === 'object' &&
      (value as { bound?: unknown }).bound === CARRIED_BOUND &&
      (value as { marks?: { outsider?: unknown } }).marks?.outsider === true
    ) {
      return CARRIED_OUTSIDER_LEVEL;
    }
    // A carried mark is never stored as a bare level: one that looks like it is unknown.
    if (
      value !== null &&
      typeof value === 'object' &&
      isCarriedOutsiderBound(value as TurnPermissionLevel)
    ) {
      return 'runtime-default';
    }
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
 * Whether the sending turn was marked: any mark (an outsider's words, a
 * teammate's chain), or a stored bound DorkOS cannot read (the runtime default).
 *
 * @param bound - The sender's bound.
 */
export function isMarkedBound(bound: TurnPermissionCeiling): boolean {
  const bounds = boundsOf(bound);
  // A sender that only carried an outsider's words on (DOR-3390) still opens a chat at the
  // operator's stop: the mark rides the message's own bound, which gates the risky actions.
  if (bounds.some(isCarriedOutsiderBound) && !bounds.includes('runtime-default')) {
    return bounds.some((one) => one !== 'runtime-default' && one.teammate !== undefined);
  }
  return bounds.some((one) => one === 'runtime-default' || hasMarks(marksOfLevel(one)));
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
