/**
 * Turn marks (DOR-3036, `specs/turn-marks/design-note.md`): what a turn read or who reached it,
 * carried to everything the turn causes, and applied at the one seam every turn passes.
 *
 * ## One set, riding the level
 *
 * A mark is a flat field on `TurnPermissionLevel`, so it travels wherever a level or a ceiling
 * already does: a room post keeps its author's level, a chat message stores its sender's, a
 * spin-off starts under its starter's bound, and `stricterLevel` keeps every mark of the two
 * levels it merges. {@link TurnMarks} is exactly those fields: `outsider`, the turn read words from
 * outside the owner's circle (spec `trusted-by-default-flip` §4.7), and `teammate`, the teammates
 * in shared spaces whose words started the chain (`teammate-mark.ts`). Tool-read joins them later,
 * as one more field of the same set with its own entry in the rules below.
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
 * every runtime the registry wraps applies marks after the level is recorded, to a turn and to a
 * command intent alike. A turn carrying a mark is counted against its agent while it runs, so a
 * caller that cannot name its session (Codex and OpenCode over the external `/mcp` server) is
 * still read as marked (`live-outsider-turns.ts`), and a teammate-marked turn is refused or held
 * to the teammate tier before the runtime sees it (`teammate-mark.ts`). A runtime that reaches a
 * turn without the seam is a gap the census refuses (`turn-marks-seam.census.test.ts`).
 *
 * @module services/core/turn-power/turn-marks
 */
import type {
  AgentRuntime,
  MessageOpts,
  TeammateOrigin,
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  CARRIED_OUTSIDER_LEVEL,
  ceilingHoldsForOutsider,
  isNoLooserThan,
  mergeTeammateOrigins,
  READ_ONLY_LEVEL,
} from '@dorkos/shared/permission-semantics';
import { turnAgentOf } from '../agent-identity/agent-home.js';
import {
  noteChatHeardOutsider,
  turnStartedByOutsider,
} from '../../session/origin/outsider-turns.js';
import { countWhileRunning, runningMarksOf } from './live-outsider-turns.js';
import { teammateTurnOpts, teammateTurnRefusal } from './teammate-mark.js';

/** Every kind of mark, each a field of `TurnPermissionLevel`. */
export const TURN_MARK_KINDS = [
  'outsider',
  'teammate',
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
 * What words from a source DorkOS cannot vouch for carry: the outsider mark. Unknown counts as
 * marked (a stranger, a sender with no kept level, an empty ceiling that vouches for no one).
 */
const UNKNOWN_SOURCE: TurnMarks = Object.freeze({ outsider: true });

/** How each kind combines and compares: the outsider mark is a flag, a teammate mark a list. */
interface KindRules<K extends TurnMarkKind> {
  /** Both values together. */
  merge(a: TurnMarks[K], b: TurnMarks[K]): TurnMarks[K];
  /** Whether `outer` already holds everything `inner` does. */
  covers(outer: TurnMarks[K], inner: TurnMarks[K]): boolean;
}

const sameOrigin = (a: TeammateOrigin, b: TeammateOrigin) =>
  a.roomId === b.roomId && a.authorId === b.authorId;

/** One entry per kind, so a kind added to {@link TURN_MARK_KINDS} cannot go without rules. */
const RULES: { [K in TurnMarkKind]: KindRules<K> } = {
  outsider: {
    merge: (a, b) => (a === true || b === true ? true : undefined),
    covers: (outer, inner) => inner !== true || outer === true,
  },
  teammate: {
    merge: (a, b) => mergeTeammateOrigins(a, b),
    covers: (outer, inner) =>
      inner === undefined ||
      (outer !== undefined && inner.every((origin) => outer.some((o) => sameOrigin(o, origin)))),
  },
};

/** The kinds present in a set or a level: a flag set, or a list (even empty). */
function presentKinds(marks: TurnMarks): TurnMarkKind[] {
  return TURN_MARK_KINDS.filter((kind) => marks[kind] !== undefined);
}

/** The marks among these fields, or {@link NO_MARKS} when there are none. */
function marksFrom(fields: TurnMarks): TurnMarks {
  const kinds = presentKinds(fields);
  if (kinds.length === 0) return NO_MARKS;
  return Object.fromEntries(kinds.map((kind) => [kind, fields[kind]])) as TurnMarks;
}

/**
 * The teammate origins a set carries, or none.
 *
 * @param marks - The set.
 */
export function teammateOrigins(marks: TurnMarks): readonly TeammateOrigin[] {
  return marks.teammate ?? [];
}

/**
 * The marks a level carries, or none for an unknown level. Unknown is read by each caller, since
 * what it means differs: an unrecorded caller is read through its agent, an unkept post marks
 * nothing in view, an unknown sender's ceiling is the runtime default.
 *
 * @param level - A recorded level, or `undefined`.
 */
export function marksOfLevel(level: TurnPermissionLevel | undefined): TurnMarks {
  return level === undefined ? NO_MARKS : marksFrom(level);
}

/**
 * The marks a ceiling carries: the runtime-default bound (a stranger, or a sender DorkOS cannot
 * vouch for), a level that was marked, or an empty list, which vouches for no one.
 *
 * @param ceiling - The ceiling a turn is sent with.
 */
export function marksOfCeiling(ceiling: TurnPermissionCeiling): TurnMarks {
  if (!Array.isArray(ceiling)) {
    return ceiling === 'runtime-default'
      ? UNKNOWN_SOURCE
      : marksOfLevel(ceiling as TurnPermissionLevel);
  }
  const bounds = ceiling as readonly (TurnPermissionLevel | 'runtime-default')[];
  if (bounds.length === 0) return UNKNOWN_SOURCE;
  return bounds.map(marksOfCeiling).reduce(mergeMarks, NO_MARKS);
}

/**
 * The marks one turn carries from what it is sent with: its ceiling, and a stranger's line a room
 * shows it without asking it to answer (`roomTurn.outsiderInView`, fenced rather than ceilinged).
 *
 * A continuation's hold (`MessageOpts.continuationHold`, DOR-3203) is the one `'runtime-default'`
 * bound that marks nothing: the turn reads no new words, it only picks up a chat whose last turn
 * was held. Any other bound beside it still marks, and a chat a stranger reached stays marked on
 * everything it hands on (`chatHeardOutsider`).
 *
 * @param opts - The send's options.
 */
export function marksForTurn(opts: MessageOpts | undefined): TurnMarks {
  const ceiling =
    opts?.continuationHold === true
      ? withoutContinuationBound(opts.permissionCeiling)
      : opts?.permissionCeiling;
  const fromCeiling = ceiling !== undefined ? marksOfCeiling(ceiling) : NO_MARKS;
  return mergeMarks(
    fromCeiling,
    opts?.roomTurn?.outsiderInView === true ? { outsider: true } : NO_MARKS
  );
}

/** A ceiling with the one `'runtime-default'` bound a continuation's hold added taken out. */
function withoutContinuationBound(
  ceiling: TurnPermissionCeiling | undefined
): TurnPermissionCeiling | undefined {
  if (ceiling === undefined || ceiling === 'runtime-default') return undefined;
  if (!Array.isArray(ceiling)) return ceiling;
  const bounds = [...(ceiling as readonly (TurnPermissionLevel | 'runtime-default')[])];
  const at = bounds.indexOf('runtime-default');
  if (at !== -1) bounds.splice(at, 1);
  return bounds.length === 0 ? undefined : bounds;
}

/**
 * Both sets together: every kind either carries.
 *
 * @param a - One set.
 * @param b - The other.
 */
export function mergeMarks(a: TurnMarks, b: TurnMarks): TurnMarks {
  const merged: Record<string, unknown> = {};
  for (const kind of TURN_MARK_KINDS) {
    const rules = RULES[kind] as KindRules<TurnMarkKind>;
    const value = rules.merge(a[kind], b[kind]);
    if (value !== undefined) merged[kind] = value;
  }
  return marksFrom(merged as TurnMarks);
}

/**
 * Whether a set carries any mark.
 *
 * @param marks - The set.
 */
export function hasMarks(marks: TurnMarks): boolean {
  return presentKinds(marks).length > 0;
}

/**
 * Whether `receiver` already carries every mark `sender` does, so words from the sender can join
 * the receiver's running turn: a running turn cannot be marked after it started.
 *
 * @param receiver - The marks of the turn being joined.
 * @param sender - The marks of the turn whose words would join it.
 */
export function carriesAllMarks(receiver: TurnMarks, sender: TurnMarks): boolean {
  return TURN_MARK_KINDS.every((kind) =>
    (RULES[kind] as KindRules<TurnMarkKind>).covers(receiver[kind], sender[kind])
  );
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
  const own = marksOfLevel(level);
  if (carriesAllMarks(own, marks)) return level;
  return { ...level, ...mergeMarks(own, marks) };
}

/**
 * The marks the agent at this home has running: every mark any of its marked turns carries right
 * now, or a turn no agent could be found for does. Read for a caller that cannot name its session.
 *
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function agentMarksRunning(agentPath: string): TurnMarks {
  return runningMarksOf(agentPath).reduce(mergeMarks, NO_MARKS);
}

/**
 * A ceiling that carries these marks to a turn that reads words written under them (a beat that
 * reads a promise made in a marked turn, a turn our own agent's marked post starts). The outsider
 * mark rides as {@link CARRIED_OUTSIDER_LEVEL}, which caps nothing (DOR-3390): the mark gates the
 * actions that matter, not the turn's level. A teammate's chain is still held to the runtime
 * default and a read-only level holding every teammate origin. `undefined` for no marks.
 *
 * @param marks - The marks the words were written under.
 */
export function ceilingCarrying(marks: TurnMarks): TurnPermissionCeiling | undefined {
  if (!hasMarks(marks)) return undefined;
  // A teammate's hold is the runtime default, which carries the outsider mark already.
  if (marks.teammate !== undefined) {
    return ['runtime-default', { ...READ_ONLY_LEVEL, teammate: marks.teammate }];
  }
  return CARRIED_OUTSIDER_LEVEL;
}

/**
 * The marks stored as JSON on a row (a commitment, say), or none when absent or unreadable. Only
 * the shape of each kind is kept; anything else in the stored value is dropped.
 *
 * @param stored - The stored JSON, or null.
 */
export function parseStoredMarks(stored: string | null | undefined): TurnMarks {
  if (!stored) return NO_MARKS;
  try {
    const value = JSON.parse(stored) as { outsider?: unknown; teammate?: unknown };
    const teammate = Array.isArray(value.teammate)
      ? value.teammate
          .filter(
            (o): o is TeammateOrigin =>
              typeof o?.roomId === 'string' && typeof o?.authorId === 'string'
          )
          .map((o) => ({ roomId: o.roomId, authorId: o.authorId }))
      : undefined;
    return marksFrom({
      ...(value.outsider === true ? { outsider: true } : {}),
      ...(teammate !== undefined ? { teammate } : {}),
    });
  } catch {
    // Unreadable is not unmarked: a row whose marks cannot be read carries the outsider mark.
    return UNKNOWN_SOURCE;
  }
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

/**
 * Runtimes whose own gate holds the shell of a turn that carries an outsider's words on
 * (DOR-3390): Claude Code's held-turn hook asks before Bash in such a turn. Any other runtime has
 * no such gate yet, so a carried mark still holds its whole turn to the runtime's default there.
 */
const GATES_CARRIED_SHELL: ReadonlySet<string> = new Set(['claude-code']);

/**
 * The send's options with a carried outsider mark held to the runtime's default on a runtime that
 * cannot gate the shell alone; untouched otherwise, and when the turn is already held.
 */
function withCarriedHold(
  runtimeType: string,
  opts: MessageOpts | undefined,
  setToFull = false
): MessageOpts | undefined {
  // Only a mark the ceiling carries: a stranger's line merely in view is fenced, not held. A chat
  // SET to Full autonomy is never held for a mark (DOR-3394): it asks nobody anything, and on a
  // runtime that asks below Full the hold would put its calls in front of a person.
  const ceiling = opts?.permissionCeiling;
  if (ceiling === undefined || setToFull || GATES_CARRIED_SHELL.has(runtimeType)) return opts;
  if (ceilingHoldsForOutsider(ceiling) || marksOfCeiling(ceiling).outsider !== true) return opts;
  const bounds: TurnPermissionBound[] = Array.isArray(ceiling)
    ? [...(ceiling as readonly TurnPermissionBound[])]
    : [ceiling as TurnPermissionBound];
  bounds.push('runtime-default');
  // A continuation's hold names only its own bound; this one is a real hold, so it is dropped.
  const { continuationHold: _dropped, ...rest } = opts ?? {};
  return { ...rest, permissionCeiling: bounds.length === 1 ? bounds[0]! : bounds };
}

/** A turn start: `sendMessage`'s and `executeCommandIntent`'s shape, with the middle argument. */
type AnyTurnStart = (
  sessionId: string,
  input: unknown,
  opts?: MessageOpts
) => AsyncGenerator<StreamEvent>;

/** A turn that refuses before anything runs, failing the stream its caller reads. */
async function* refused(reason: string): AsyncGenerator<StreamEvent> {
  yield* [];
  throw new Error(reason);
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
 * @param recordRefused - Records the level of a turn refused before it reached the runtime.
 * @param setToFull - Whether the chat a turn runs in is SET to Full autonomy, with no ceiling
 *   applied (DOR-3394); such a chat's carried mark is never turned into a hold.
 */
export function applyTurnMarks(
  runtime: AgentRuntime,
  marksOfSession: (sessionId: string) => TurnMarks,
  recordRefused?: (sessionId: string, opts: MessageOpts) => void,
  setToFull?: (sessionId: string, opts: MessageOpts | undefined) => boolean
): AgentRuntime {
  // Where each marked turn stood, so a turn its agent starts later counts against the same one.
  // Per wrapper is enough: the registry wraps one instance per runtime type, and a wake comes back
  // through the runtime that sent the turn.
  const places = new Map<string, { cwd?: string; forAgent?: string }>();

  /** Start one turn with its marks applied: refused, rewritten for a teammate, and counted. */
  function markedTurn(
    target: AgentRuntime,
    sessionId: string,
    opts: MessageOpts | undefined,
    start: (opts: MessageOpts | undefined) => AsyncGenerator<StreamEvent>
  ): AsyncGenerator<StreamEvent> {
    const marks = marksForTurn(opts);
    if (!hasMarks(marks)) return start(opts);
    if (marks.outsider === true) noteChatHeardOutsider(sessionId);
    let sent = withCarriedHold(target.type, opts, setToFull?.(sessionId, opts) === true);
    if (marks.teammate !== undefined) {
      sent = teammateTurnOpts(opts);
      const refusal = teammateTurnRefusal(target.type, marks.teammate);
      if (refusal !== null) {
        // Recorded all the same, so what reads the chat afterwards (a failure wake, say) knows it
        // was a marked turn and does not treat its failure as the agent's own.
        recordRefused?.(sessionId, sent);
        return refused(refusal);
      }
    }
    // A caller that cannot name this session can still name its agent.
    const place = placeOf(target, sessionId, sent);
    places.delete(sessionId);
    places.set(sessionId, place);
    if (places.size > PLACE_MEMORY) places.delete(places.keys().next().value!);
    return countWhileRunning(place, marks, start(sent));
  }

  return new Proxy(runtime, {
    get(target, prop) {
      // A command intent (a compaction, say) is a turn like any other: it carries the marks it
      // was sent with. A steer or stage (`deliverIntoTurn`) joins a turn already running, which
      // cannot gain marks; its one marked sender, another chat, is held by `mayJoinRunningTurn`.
      if (
        (prop === 'sendMessage' || prop === 'executeCommandIntent') &&
        typeof target[prop] === 'function'
      ) {
        const start = (target[prop] as AnyTurnStart).bind(target);
        return (sessionId: string, input: unknown, opts?: MessageOpts) =>
          markedTurn(target, sessionId, opts, (sent) => start(sessionId, input, sent));
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
