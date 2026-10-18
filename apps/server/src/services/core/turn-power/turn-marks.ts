/**
 * Turn marks (DOR-3036, `specs/turn-marks/design-note.md`): what a turn read or who reached it,
 * carried to everything the turn causes, and applied at the one seam every turn passes.
 *
 * ## One set, riding the level
 *
 * A mark is a flat field on `TurnPermissionLevel`, so it travels wherever a level or a ceiling
 * already does: a room post keeps its author's level, a chat message stores its sender's, a
 * spin-off starts under its starter's bound, and `stricterLevel` keeps every mark of the two
 * levels it merges. {@link TurnMarks} is exactly those fields. Today there is one kind,
 * `outsider`: the turn read words from outside the owner's circle (spec `trusted-by-default-flip`
 * §4.7). The teammate and tool-read kinds join it here, as more fields of the same set.
 *
 * Marks only add up: no reader here ever takes one away, and only a person clears the durable
 * copies (a parked schedule, a held edit).
 *
 * ## Two readings of the outsider mark
 *
 * **Carried** (the turn read an outsider's words) is the `outsider` field, read through
 * `marksOf` in `turn-levels.ts`, which owns the record. **Direct** (a stranger started this
 * turn) is decided by the origin bookkeeping in `session/origin/outsider-turns.ts` and read
 * through {@link startedByOutsider}. Only the direct reading drives the per-turn post and note
 * cap, `commitments_list` and the failure wake: the carried mark also lands on our own agents'
 * turns, and counting those would bring back caps ADR `261006-225605` retired.
 *
 * ## The seam
 *
 * {@link applyTurnMarks} wraps the level record (`recordTurnLevels` returns the two together), so
 * every runtime the registry wraps applies marks after the level is recorded. Its one effect
 * today: a turn carrying a mark is counted against its agent while it runs, so a caller that
 * cannot name its session (Codex and OpenCode over the external `/mcp` server) is still read as
 * marked (`live-outsider-turns.ts`). A runtime that reaches a turn without it is a gap the seam
 * census refuses (`runtime-seam/__tests__/turn-marks-seam.census.test.ts`).
 *
 * @module services/core/turn-power/turn-marks
 */
import type {
  AgentRuntime,
  MessageOpts,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { ceilingCarriesOutsider, isNoLooserThan } from '@dorkos/shared/permission-semantics';
import { turnAgentOf } from '../agent-identity/agent-home.js';
import { turnStartedByOutsider } from '../../session/origin/outsider-turns.js';
import { countWhileRunning } from './live-outsider-turns.js';

/** Every kind of mark, each a field of `TurnPermissionLevel`. */
export const TURN_MARK_KINDS = [
  'outsider',
] as const satisfies readonly (keyof TurnPermissionLevel)[];

/** One kind of mark. */
export type TurnMarkKind = (typeof TURN_MARK_KINDS)[number];

/** The marks a turn carries: the mark fields of its level, and nothing else. */
export type TurnMarks = Pick<TurnPermissionLevel, TurnMarkKind>;

/** No marks at all. */
export const NO_MARKS: TurnMarks = Object.freeze({});

/** How many turns' places are remembered, oldest dropped first (as `turn-levels.ts`). */
const PLACE_MEMORY = 10_000;

/**
 * The marks a level carries, or none for an unknown level. Unknown is read by each caller, since
 * what it means differs: an unrecorded caller is read through its agent, an unkept post marks
 * nothing in view, an unknown sender's ceiling is the runtime default.
 *
 * @param level - A recorded level, or `undefined`.
 */
export function marksOfLevel(level: TurnPermissionLevel | undefined): TurnMarks {
  return level?.outsider === true ? { outsider: true } : NO_MARKS;
}

/**
 * The marks a ceiling carries: the runtime-default bound (a stranger, or a sender DorkOS cannot
 * vouch for), a level that was marked, or an empty list, which vouches for no one.
 *
 * @param ceiling - The ceiling a turn is sent with.
 */
export function marksOfCeiling(ceiling: TurnPermissionCeiling): TurnMarks {
  return ceilingCarriesOutsider(ceiling) ? { outsider: true } : NO_MARKS;
}

/**
 * The marks one turn carries from what it is sent with: its ceiling, and a stranger's line a room
 * shows it without asking it to answer (`roomTurn.outsiderInView`, fenced rather than ceilinged).
 *
 * @param opts - The send's options.
 */
export function marksForTurn(opts: MessageOpts | undefined): TurnMarks {
  const fromCeiling =
    opts?.permissionCeiling !== undefined ? marksOfCeiling(opts.permissionCeiling) : NO_MARKS;
  return mergeMarks(
    fromCeiling,
    opts?.roomTurn?.outsiderInView === true ? { outsider: true } : NO_MARKS
  );
}

/**
 * Both sets together: every kind either carries.
 *
 * @param a - One set.
 * @param b - The other.
 */
export function mergeMarks(a: TurnMarks, b: TurnMarks): TurnMarks {
  return a.outsider === true || b.outsider === true ? { outsider: true } : NO_MARKS;
}

/**
 * Whether a set carries any mark.
 *
 * @param marks - The set.
 */
export function hasMarks(marks: TurnMarks): boolean {
  return TURN_MARK_KINDS.some((kind) => marks[kind] === true);
}

/**
 * Whether `receiver` already carries every mark `sender` does, so words from the sender can join
 * the receiver's running turn: a running turn cannot be marked after it started.
 *
 * @param receiver - The marks of the turn being joined.
 * @param sender - The marks of the turn whose words would join it.
 */
export function carriesAllMarks(receiver: TurnMarks, sender: TurnMarks): boolean {
  return TURN_MARK_KINDS.every((kind) => sender[kind] !== true || receiver[kind] === true);
}

/**
 * Whether words from a turn at `sender` may join a running turn at `receiver` (a steer from one
 * chat into another): only when the running turn is no looser than the sender, since a running
 * turn cannot be lowered to a ceiling, and already carries every mark the sender does, since it
 * cannot be marked either (spec `trusted-by-default-flip` §4.7). Auto joins only Auto or a level
 * that never asks.
 *
 * @param sender - The level of the turn whose words would join.
 * @param receiver - The level of the running turn.
 */
export function mayJoinRunningTurn(
  sender: TurnPermissionLevel,
  receiver: TurnPermissionLevel
): boolean {
  if (!carriesAllMarks(receiver, sender)) return false;
  if (!isNoLooserThan(sender, receiver)) return false;
  return !receiver.auto || sender.auto === true || sender.asks === 'never';
}

/**
 * A level carrying these marks as well as its own.
 *
 * @param level - The level the turn runs at.
 * @param marks - The marks it carries.
 */
export function withMarks(level: TurnPermissionLevel, marks: TurnMarks): TurnPermissionLevel {
  return marks.outsider === true && level.outsider !== true ? { ...level, outsider: true } : level;
}

/**
 * The direct reading of the outsider mark: whether a stranger started the turn running in this
 * chat (a bridged chat, an external room author, an outside agent, a connector event). Decided
 * where the turn is bound to its origin (`session/origin/outsider-turns.ts`).
 *
 * @param sessionId - The chat, by either id it is known by.
 */
export function startedByOutsider(sessionId: string): boolean {
  return turnStartedByOutsider(sessionId);
}

/** Where a turn stands and whom it is for, so its agent can be found while it runs. */
function placeOf(runtime: AgentRuntime, sessionId: string, opts: MessageOpts | undefined) {
  let cwd = opts?.cwd ?? opts?.roomTurn?.cwd;
  try {
    cwd ??= runtime.getSessionCwd?.(sessionId);
  } catch {
    // An unknown folder is counted under no agent, which marks more, not less.
  }
  return { cwd, forAgent: turnAgentOf(opts) };
}

/**
 * Wrap a runtime so the marks each turn carries take effect. Applied by `recordTurnLevels`
 * around the level record, so it is on every runtime the registry wraps.
 *
 * Synchronous, like the other decorators at the seam: an unmarked turn gets the runtime's own
 * generator back untouched, and a marked one is counted against its agent while it runs.
 *
 * @param runtime - The runtime to wrap, already recording levels.
 * @param marksOfSession - The marks of a session's latest recorded turn, for a turn the runtime
 *   starts on its own (a Codex wake after background work), which runs under it.
 */
export function applyTurnMarks(
  runtime: AgentRuntime,
  marksOfSession: (sessionId: string) => TurnMarks
): AgentRuntime {
  /** Where each marked turn stood, so a turn its agent starts later counts against the same one. */
  const places = new Map<string, { cwd?: string; forAgent?: string }>();
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (
          sessionId: string,
          content: string,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> => {
          const events = target.sendMessage(sessionId, content, opts);
          const marks = marksForTurn(opts);
          if (!hasMarks(marks)) return events;
          // A caller that cannot name this session can still name its agent.
          const place = placeOf(target, sessionId, opts);
          places.delete(sessionId);
          places.set(sessionId, place);
          if (places.size > PLACE_MEMORY) places.delete(places.keys().next().value!);
          return countWhileRunning(place, marks, events);
        };
      }
      if (prop === 'onRuntimeTurn' && typeof target.onRuntimeTurn === 'function') {
        const subscribe = target.onRuntimeTurn.bind(target);
        return (listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void) =>
          subscribe((sessionId, events) => {
            const marks = marksOfSession(sessionId);
            listener(
              sessionId,
              hasMarks(marks)
                ? countWhileRunning(
                    places.get(sessionId) ?? placeOf(target, sessionId, undefined),
                    marks,
                    events
                  )
                : events
            );
          });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
