/**
 * What level each conversation's latest turn ran at, and what level each room
 * post was written at, so power flows downstream and never up (spec
 * `trusted-by-default-flip` §4).
 *
 * ## The gap this closes
 *
 * `chat_send` and `post_to_room` run without a card even in a prompting mode,
 * so a turn a Telegram stranger started can post into a room. Before this, the
 * turn that post started on another agent ran at THAT agent's own level, and
 * nothing tied it to the poster's. Under a Full autonomy default that is a path
 * from a stranger to a shell. The rule that closes it is the one `session_start`
 * already keeps: a turn somebody else's message starts runs no looser than that
 * somebody.
 *
 * ## Why it is recorded rather than asked for later
 *
 * A post triggers its turns after the poster's own turn may have moved on, and
 * the poster's NEXT turn can run at a different level (a person talking to it
 * at Full autonomy after a stranger's turn ran at Default). So the level is
 * read at the moment the post is written, from what the poster's current turn
 * ran at, and kept with the post.
 *
 * ## Fails closed
 *
 * Both maps live in memory. After a restart, or for a session this process
 * never ran a turn on, the reader gets nothing and the caller bounds the turn
 * at the receiving runtime's default: a prompt, never a widening. Both maps are
 * bounded, oldest first.
 *
 * @module services/core/turn-power/turn-levels
 */
import type {
  AgentRuntime,
  MessageOpts,
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  agentMarksRunning,
  applyTurnMarks,
  ceilingCarrying,
  marksForTurn,
  marksOfLevel,
  NO_MARKS,
  withMarks,
  type TurnMarks,
} from './turn-marks.js';
import { primaryOf } from '../../session/resolution/session-key-registry.js';
import { chatHeardOutsider } from '../../session/origin/outsider-turns.js';
import { noteTurnHold } from './continuation-hold.js';
import {
  ceilingHoldsForOutsider,
  levelOfMode,
  READ_ONLY_LEVEL,
  resolveCeilingLevel,
  stricterLevel,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';

/** How many conversations and posts each map remembers. */
export const TURN_LEVEL_MEMORY = 10_000;

/** Claude Code's Auto id, read as Default unless a launch confirmed it. */
const AUTO_MODE_ID = 'auto';
const AUTO_FALLBACK_MODE_ID = 'default';

const turnLevels = new Map<string, TurnPermissionLevel>();
/**
 * Each conversation's latest turn's level WITHOUT a stranger's hold, kept only when the hold
 * changed it (DOR-3390): the level its hand-offs carry. A stranger's hold binds the turn it
 * started; our agent's post or message from that turn is its own words, gated by the mark.
 */
const handOffLevels = new Map<string, TurnPermissionLevel>();
/** Conversations whose latest turn a stranger's hold bound (`ceilingHoldsForOutsider`). */
const strangerHeld = new Set<string>();
const entryLevels = new Map<string, TurnPermissionLevel>();
/** Marks kept for posts whose level is unknown (`noteEntryMarks`). */
const entryMarks = new Map<string, TurnMarks>();
/** Posts whose turns are held to the runtime's default (a Wi-Fi sign-in's, DOR-3037); insertion-ordered. */
const heldEntries = new Set<string>();
/** How many turns this process has sent on each conversation, so a per-turn count knows when a turn is new. */
const turnSerials = new Map<string, number>();
let nextTurnSerial = 0;

/** Set a key as the newest, dropping the oldest past the bound. */
function remember<T>(map: Map<string, T>, key: string, level: T) {
  map.delete(key);
  map.set(key, level);
  if (map.size > TURN_LEVEL_MEMORY) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * The level the latest turn on a conversation ran at, or `undefined` when this
 * process ran none.
 *
 * @param sessionId - The id the turn was sent under.
 */
export function lastTurnLevelOf(sessionId: string): TurnPermissionLevel | undefined {
  return turnLevels.get(sessionId);
}

/**
 * The level a conversation hands on to what its turn causes: a room post, a
 * chat message, a spin-off. Its latest turn's level, carrying the outsider mark
 * whenever a stranger's words may be in the chat (`chatHeardOutsider`): one
 * started this turn, an earlier one, or the chat itself (DOR-3107). The one
 * read every hand-off makes, so no path passes on a stranger's words unmarked.
 * `undefined` when this process ran no turn on it.
 *
 * @param sessionId - The id the turn was sent under.
 */
export function passedOnLevelOf(sessionId: string): TurnPermissionLevel | undefined {
  // The turn's own power without a stranger's hold (DOR-3390): what our agent hands on is its
  // own words, so the turn it starts is gated by the mark, not capped by the stranger's hold.
  const level = handOffLevels.get(sessionId) ?? turnLevels.get(sessionId);
  if (level === undefined) return undefined;
  return chatHeardOutsider(sessionId) ? { ...level, outsider: true } : level;
}

/**
 * The marks a sender carries when its level is NOT known (a restart, a turn
 * this process never recorded): the outsider mark if a stranger reached any of
 * these chats (`chatHeardOutsider`, which also reads a chat's stored launch
 * origin). Under trust first (DOR-3107, Dorian 2026-10-19) an unknown sender of
 * the owner's own is trusted, so this is what still tells a stranger's chat apart.
 *
 * A named chat answers for itself only (DOR-3386, Security's marked-lanes
 * design): a sibling chat of the same agent running a marked turn in parallel
 * proves nothing about this one, and counting it held every lane of an agent
 * whenever any one of its room seats read a post. Words that cross between
 * chats through shared state are stamped where they are kept (memory,
 * commitments). Only a caller that names no chat is read through its agent.
 *
 * @param sessionIds - The sending chats.
 * @param agentPath - The sending agent, when known.
 */
export function unknownLevelMarks(
  sessionIds: readonly (string | null | undefined)[],
  agentPath?: string
): TurnMarks {
  const named = sessionIds.filter((id): id is string => typeof id === 'string' && id !== '');
  if (named.length === 0) {
    return agentPath !== undefined ? agentMarksRunning(agentPath) : NO_MARKS;
  }
  return named.some(chatHeardOutsider) ? { outsider: true } : NO_MARKS;
}

/**
 * Which turn a conversation is on: a number that changes each time a turn is
 * sent on it, or `undefined` when this process sent none. Lets a count kept per
 * turn tell one turn from the next without a hook of its own.
 *
 * @param sessionId - The id the turn was sent under.
 */
export function turnSerialOf(sessionId: string): number | undefined {
  return turnSerials.get(sessionId);
}

/**
 * The level a post written from these sessions is kept with: the stricter of
 * every session's latest turn, or `undefined` when any of them is unknown or
 * none is named. Unknown is not a level: a post that cannot be vouched for
 * keeps nothing, and the turn it starts is held to the runtime's default.
 *
 * Callers name the session that MADE the call (the in-session tool's own
 * session) and the author's turn in the room it posts into. They can differ:
 * an agent with turns in several rooms posts from one into another, and the
 * post must not borrow a looser turn's level. Never a session id a request
 * body supplied; that would let anybody name a Full autonomy conversation.
 *
 * A chat a stranger reached (a connector event, a bridged chat, a stranger's
 * DM, now or in an earlier turn) is marked even when no ceiling said so
 * (DOR-3107, {@link passedOnLevelOf}): its post carries the outsider mark, so
 * the turn it wakes is capped, never trusted as unmarked.
 *
 * @param sessionIds - The sessions that vouch for the post.
 */
export function postLevelFor(
  sessionIds: readonly (string | null | undefined)[]
): TurnPermissionLevel | undefined {
  const named = sessionIds.filter((id): id is string => typeof id === 'string' && id !== '');
  if (named.length === 0) return undefined;
  const levels = named.map(passedOnLevelOf);
  if (levels.some((level) => level === undefined)) return undefined;
  return (levels as TurnPermissionLevel[]).reduce(stricterLevel);
}

/**
 * The marks the caller's turn carries (DOR-3036, `turn-marks.ts`): what every
 * enforcement point reads, never the model. Read by `memory_write`, which
 * stamps the note, the permission gate and the destructive hold.
 *
 * The caller's session answers when this process recorded a turn on it. A
 * caller with no session, or one with no record, is read through its agent:
 * the marks of any of that agent's marked turns running right now. Kept wider
 * than a sender's bound ({@link unknownLevelMarks}) on purpose: these marks
 * decide the destructive hold and memory stamps, where a chat known by a
 * second, unrecorded id must not read as unmarked.
 *
 * @param sessionId - The calling session, when the surface verified one.
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function marksOf(
  sessionId: string | null | undefined,
  agentPath: string | undefined
): TurnMarks {
  const level = sessionId ? turnLevels.get(sessionId) : undefined;
  if (level !== undefined) return marksOfLevel(level);
  return agentPath !== undefined ? agentMarksRunning(agentPath) : NO_MARKS;
}

/**
 * The bound work a caller starts must carry because the caller's turn is
 * marked, or `undefined` when it is not. Read by `session_start`, which sends
 * it as the new session's ceiling, so the new chat carries the marks on.
 *
 * A ceiling carrying the marks (`ceilingCarrying`): the runtime default, and a
 * read-only level holding every teammate origin; beside the caller's own level
 * when this process recorded its turn, so the new chat runs no looser than
 * either. The marks ride as bounds of their own, as `chat_send` and a room post
 * carry them (DOR-3141): a bare marked level would hold the new chat's power
 * but not read as a stranger's turn where that decides (the held turn's hook
 * and its cards, DOR-3204). A chat a stranger reached is marked here too
 * ({@link passedOnLevelOf}).
 *
 * @param sessionId - The calling session, when the surface verified one.
 * @param agentPath - The calling agent's home, from its verified identity.
 */
export function markedBoundOf(
  sessionId: string | null | undefined,
  agentPath: string | undefined
): TurnPermissionCeiling | undefined {
  const heard = sessionId ? chatHeardOutsider(sessionId) : false;
  const marks = heard
    ? { ...marksOf(sessionId, agentPath), outsider: true as const }
    : marksOf(sessionId, agentPath);
  const carried = ceilingCarrying(marks);
  if (carried === undefined) return undefined;
  type BoundList = Extract<TurnPermissionCeiling, readonly unknown[]>;
  // A spin-off a stranger's own turn starts is held like that turn (DOR-3204 M1): it is the
  // stranger's act, not our agent's words passed on. Anything else carries the mark at the
  // caller's own level (DOR-3390).
  // A caller that names no chat (Codex or OpenCode over the external server), or one this process
  // recorded no turn for, cannot show whose turn it is: held, the strict answer.
  const level = sessionId ? passedOnLevelOf(sessionId) : undefined;
  if (!sessionId || level === undefined || strangerHeld.has(sessionId)) {
    const held = sessionId ? turnLevels.get(sessionId) : undefined;
    // The hold carries the outsider mark itself; a teammate's chain already holds one.
    const withHold = (Array.isArray(carried) ? carried : ['runtime-default']) as BoundList;
    if (held === undefined) return withHold.length === 1 ? withHold[0]! : withHold;
    return [held, ...withHold] as BoundList;
  }
  const bounds = (Array.isArray(carried) ? carried : [carried]) as BoundList;
  return [level, ...bounds];
}

/**
 * Where a post's marks are kept across a restart (DOR-3036): the `room_entries.turn_marks`
 * column, set at startup by the rooms layer, which owns the table. `read` answers `null` for a
 * post whose author's level was never known (an unverified caller, a row from before the column),
 * so a reader can tell "unmarked" from "nobody knows".
 */
export interface EntryMarksStore {
  /** Keep the marks a post was written under. */
  write(roomId: string, entryId: string, marks: TurnMarks): void;
  /** The marks a post was written under; `null` when unknown, `undefined` when there is no row. */
  read(roomId: string, entryId: string): TurnMarks | null | undefined;
}

let entryMarksStore: EntryMarksStore | null = null;

/**
 * Set where post marks are kept, or `null` to keep them in memory only (tests).
 *
 * @param next - The store over `room_entries.turn_marks`.
 */
export function setEntryMarksStore(next: EntryMarksStore | null): void {
  entryMarksStore = next;
}

/**
 * Keep a level with a room post. Called as the post is written, before
 * anything it triggers is dispatched, so a later turn of the same author
 * cannot change it. Its marks are also kept on the row, so a restart does not
 * read a teammate-marked post as merely an outsider's.
 *
 * @param entryId - The post's id.
 * @param level - The level from {@link postLevelFor}; `undefined` keeps nothing.
 * @param roomId - The post's room, to keep its marks on its row; absent keeps them in memory only.
 */
export function noteEntryLevel(
  entryId: string,
  level: TurnPermissionLevel | undefined,
  roomId?: string
): void {
  if (level === undefined) return;
  remember(entryLevels, entryId, level);
  try {
    if (roomId) entryMarksStore?.write(roomId, entryId, marksOfLevel(level));
  } catch {
    // The level is kept in memory; a failed write leaves the row unknown, which readers treat
    // as marked in a space room and as the runtime default everywhere else.
  }
}

/**
 * Keep marks on a post whose author's level is not known but whose source is
 * (DOR-3107): a post from a caller DorkOS could not verify (an external `/mcp`
 * client naming no session) is kept as an outsider's, so it stays capped even
 * though an unknown post from the owner's own agent no longer is.
 *
 * @param entryId - The post's id.
 * @param marks - The marks to keep.
 * @param roomId - The post's room.
 */
export function noteEntryMarks(entryId: string, marks: TurnMarks, roomId: string): void {
  remember(entryMarks, entryId, marks);
  try {
    entryMarksStore?.write(roomId, entryId, marks);
  } catch {
    // Kept in memory; a failed write leaves the row unknown after a restart.
  }
}

/**
 * The marks a room post was written under: from its kept level, else from its row. `null` when
 * nobody knows (no level was kept and the row records none), `undefined` when the post is not
 * stored here at all.
 *
 * @param entryId - The post's id.
 * @param roomId - The post's room, to read its row; absent reads the kept level only.
 */
export function entryMarksOf(entryId: string, roomId?: string): TurnMarks | null | undefined {
  const level = entryLevels.get(entryId);
  if (level !== undefined) return marksOfLevel(level);
  const marks = entryMarks.get(entryId);
  if (marks !== undefined) return marks;
  try {
    return entryMarksStore && roomId ? entryMarksStore.read(roomId, entryId) : null;
  } catch {
    return null;
  }
}

/**
 * Hold the turns a room post starts to the runtime's default: the post came
 * from somewhere DorkOS cannot vouch for, such as a Wi-Fi sign-in (DOR-3037).
 * Called as the post is written, before anything it triggers is dispatched.
 *
 * Kept in memory like the levels: a room's pending replies do not outlive the
 * process, so neither does the mark.
 *
 * @param entryId - The post's id.
 */
export function noteEntryHeldToDefault(entryId: string): void {
  heldEntries.delete(entryId);
  heldEntries.add(entryId);
  if (heldEntries.size > TURN_LEVEL_MEMORY) {
    const oldest = heldEntries.values().next().value;
    if (oldest !== undefined) heldEntries.delete(oldest);
  }
}

/** Reads a post's stored hold, for a post this process did not write; set by the rooms domain. */
let storedEntryHold: ((roomId: string, entryId: string) => boolean) | undefined;

/**
 * Wire (or clear) how a post's stored hold is read, so the hold outlives a
 * restart (the `held_to_default` column on `room_entries`).
 *
 * @param reader - Reads one post's hold; `undefined` clears it.
 */
export function setStoredEntryHoldReader(
  reader: ((roomId: string, entryId: string) => boolean) | undefined
): void {
  storedEntryHold = reader;
}

/**
 * Whether the turns a room post starts are held to the runtime's default:
 * noted in memory when this process wrote it, else read from the post's row
 * when its room is known.
 *
 * @param entryId - The post's id.
 * @param roomId - The post's room, so a post from before a restart is read from its row.
 */
export function entryHeldToDefault(entryId: string, roomId?: string): boolean {
  if (heldEntries.has(entryId)) return true;
  if (roomId === undefined || !storedEntryHold) return false;
  try {
    return storedEntryHold(roomId, entryId);
  } catch {
    // An unreadable row holds the turn: the strict answer.
    return true;
  }
}

/**
 * Carry a conversation's level to the id a runtime renamed it to mid-turn, so
 * a post made under the new id finds the turn it belongs to.
 *
 * @param from - The id the turn was sent under.
 * @param to - The id the runtime renamed the session to.
 */
export function aliasTurnLevel(from: string, to: string): void {
  const level = turnLevels.get(from);
  if (level !== undefined && from !== to) remember(turnLevels, to, level);
  const handOff = handOffLevels.get(from);
  if (handOff !== undefined && from !== to) remember(handOffLevels, to, handOff);
  if (strangerHeld.has(from) && from !== to) strangerHeld.add(to);
  const serial = turnSerials.get(from);
  if (serial !== undefined && from !== to) turnSerials.set(to, serial);
}

/**
 * Carry a conversation's level onto a DIFFERENT conversation that replaces it
 * (a room seat moved to a fresh session). Unlike {@link aliasTurnLevel}, the
 * target may already have a level of its own, so the two are merged by
 * `stricterLevel`: the lower power and every mark of both. Nothing is lifted.
 *
 * @param from - The conversation being replaced.
 * @param to - The conversation replacing it.
 */
export function carryTurnLevel(from: string, to: string): void {
  const level = turnLevels.get(from);
  if (level === undefined || from === to) return;
  const existing = turnLevels.get(to);
  remember(turnLevels, to, existing === undefined ? level : stricterLevel(existing, level));
  if (handOffLevels.has(from) || handOffLevels.has(to)) {
    const theirs = handOffLevels.get(from) ?? level;
    const ours = handOffLevels.get(to) ?? existing;
    remember(handOffLevels, to, ours === undefined ? theirs : stricterLevel(ours, theirs));
  }
  if (strangerHeld.has(from)) strangerHeld.add(to);
}

/**
 * The level a room post was written at, or `undefined` when nothing was kept.
 *
 * @param entryId - The post's id.
 */
export function entryLevelOf(entryId: string): TurnPermissionLevel | undefined {
  return entryLevels.get(entryId);
}

/**
 * The level one turn runs at, marked when the turn reads an outsider's words
 * (spec `trusted-by-default-flip` §4.7): its ceiling carries them (a
 * stranger's message, a sender DorkOS cannot vouch for, another turn that read
 * them), or a room shows it a stranger's message it does not answer. The mark
 * changes no power; it travels with the level to every turn this one's
 * messages start, and onto every note it saves to memory. A continuation's
 * hold bounds the power and marks nothing (`marksForTurn`, DOR-3203).
 */
function levelForTurn(
  runtime: AgentRuntime,
  stored: string | null | undefined,
  opts: MessageOpts | undefined
): TurnPermissionLevel {
  return withMarks(powerForTurn(runtime, stored, opts), marksForTurn(opts));
}

/**
 * Record the level one turn runs at, and the level its hand-offs carry when a stranger's hold
 * bound it (DOR-3390): the same turn's power with only that hold taken out.
 */
function recordTurn(
  runtime: AgentRuntime,
  sessionId: string,
  stored: string | null | undefined,
  opts: MessageOpts | undefined
): TurnPermissionLevel {
  const level = levelForTurn(runtime, stored, opts);
  remember(turnLevels, sessionId, level);
  const ceiling = opts?.continuationHold === true ? undefined : opts?.permissionCeiling;
  if (ceiling !== undefined && ceilingHoldsForOutsider(ceiling)) {
    strangerHeld.add(sessionId);
    const own = withoutStrangerHold(ceiling);
    const { permissionCeiling: _held, ...rest } = opts ?? {};
    const handOff = withMarks(
      powerForTurn(runtime, stored, own === undefined ? rest : { ...rest, permissionCeiling: own }),
      marksOfLevel(level)
    );
    remember(handOffLevels, sessionId, handOff);
  } else {
    strangerHeld.delete(sessionId);
    handOffLevels.delete(sessionId);
  }
  if (strangerHeld.size > TURN_LEVEL_MEMORY) {
    strangerHeld.delete(strangerHeld.values().next().value!);
  }
  return level;
}

/** A ceiling with every stranger's hold (`'runtime-default'`, an empty list) taken out. */
function withoutStrangerHold(ceiling: TurnPermissionCeiling): TurnPermissionCeiling | undefined {
  if (!Array.isArray(ceiling)) return ceiling === 'runtime-default' ? undefined : ceiling;
  const kept = (ceiling as readonly TurnPermissionBound[]).filter(
    (bound) => bound !== 'runtime-default'
  );
  return kept.length === 0 ? undefined : kept.length === 1 ? kept[0]! : kept;
}

/**
 * The power one turn runs at, as well as this process can tell without asking
 * the runtime: the stricter of the stored mode and a per-send mode, else the
 * runtime's default, then held to the turn's ceiling. Errs strict, because what
 * it feeds is a ceiling for somebody else: a runtime that cannot describe its
 * modes records {@link READ_ONLY_LEVEL}.
 */
function powerForTurn(
  runtime: AgentRuntime,
  stored: string | null | undefined,
  opts: MessageOpts | undefined
): TurnPermissionLevel {
  let declared: DeclaredModes;
  try {
    declared = runtime.getCapabilities().permissionModes;
  } catch {
    return READ_ONLY_LEVEL;
  }
  const read = (id: string | null | undefined) =>
    levelOfMode(declared, id === AUTO_MODE_ID ? AUTO_FALLBACK_MODE_ID : id);
  // A chat that follows its agent up starts from the agent's level in place of
  // the stored mode (DOR-3175), which is then what it runs at.
  const starts =
    opts?.levelPermissionMode !== undefined
      ? [read(opts.levelPermissionMode)]
      : [read(stored), read(opts?.permissionMode)];
  const known = starts.filter((level): level is TurnPermissionLevel => level !== undefined);
  const base =
    known.length > 0
      ? known.reduce(stricterLevel)
      : (levelOfMode(declared, declared.default) ?? READ_ONLY_LEVEL);
  return opts?.permissionCeiling !== undefined
    ? stricterLevel(base, resolveCeilingLevel(declared, opts.permissionCeiling))
    : base;
}

/**
 * Wrap a runtime so every turn sent through it records the level it runs at.
 * Applied once, at the registry's registration seam, which every turn passes
 * through (the composer, a room reply, a scheduled run, a relay delivery).
 *
 * Synchronous on purpose, like the other decorators at that seam: it records
 * at the call and hands back the runtime's own generator untouched, so it adds
 * no step between a dispatch and the turn it starts.
 *
 * Returned wrapped in {@link applyTurnMarks} (DOR-3036), so the marks each turn
 * carries take effect after its level is recorded, on every runtime this
 * record is on: the two cannot be applied in the wrong order or one without
 * the other.
 *
 * @param runtime - The runtime to wrap.
 * @param storedModeOf - Reads a session's stored permission mode; a failure
 *   reads as none.
 */
export function recordTurnLevels(
  runtime: AgentRuntime,
  storedModeOf: (sessionId: string) => string | null | undefined
): AgentRuntime {
  return applyTurnMarks(
    recordLevels(runtime, storedModeOf),
    (sessionId) => marksOfLevel(turnLevels.get(sessionId)),
    (sessionId, opts) => {
      let stored: string | null | undefined;
      try {
        stored = storedModeOf(sessionId);
      } catch {
        stored = undefined;
      }
      recordTurn(runtime, sessionId, stored, opts);
    }
  );
}

/** The level record alone, which {@link recordTurnLevels} wraps in the marks. */
function recordLevels(
  runtime: AgentRuntime,
  storedModeOf: (sessionId: string) => string | null | undefined
): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      // A command intent is a turn too (`CommandIntentOpts` extends `MessageOpts`), recorded alike.
      if (
        (prop === 'sendMessage' || prop === 'executeCommandIntent') &&
        typeof target[prop] === 'function'
      ) {
        const start = (
          target[prop] as (
            id: string,
            input: unknown,
            opts?: MessageOpts
          ) => AsyncGenerator<StreamEvent>
        ).bind(target);
        return (
          sessionId: string,
          content: unknown,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> => {
          let stored: string | null | undefined;
          try {
            stored = storedModeOf(sessionId);
          } catch {
            stored = undefined;
          }
          const level = recordTurn(target, sessionId, stored, opts);
          // Kept on the chat's row, for the turns that later pick it up on their own. A
          // turn a continuation's hold clamped read no new words, so it leaves the answer
          // the last real turn gave (DOR-3203).
          if (opts?.continuationHold !== true) {
            const held = level.outsider === true;
            // Only carried on, held for no stranger (DOR-3390): a later pick-up stays marked, not held.
            const ceiling = opts?.permissionCeiling;
            const carried = held && !(ceiling !== undefined && ceilingHoldsForOutsider(ceiling));
            noteTurnHold(sessionId, held, carried);
          }
          // Under the id the turn was sent with AND the conversation's first
          // id, so a turn sent under a renamed id is the newest by either.
          const serial = ++nextTurnSerial;
          for (const id of new Set([sessionId, primaryOf(sessionId)])) {
            turnSerials.delete(id);
            turnSerials.set(id, serial);
          }
          while (turnSerials.size > TURN_LEVEL_MEMORY) {
            turnSerials.delete(turnSerials.keys().next().value!);
          }
          return start(sessionId, content, opts);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
