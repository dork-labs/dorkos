/**
 * What the live lane is showing, and the pure rule that decides it.
 *
 * One reserved line above the composer answers "what is happening here" for
 * every conversation there is — a channel waiting on three agents, a session
 * mid-turn, a stream that has stopped hearing. Before this there were two
 * unrelated components saying overlapping things in two places: the session's
 * `ChatStatusStrip`, whose priority stack this function absorbs whole, and the
 * room's `RoomPresenceLine` and `RoomStalledNotice` under the composer.
 *
 * **No React here on purpose.** The priority stack is the interesting part and
 * it is cheaper to reason about — and to test — as one function over one input
 * object. It reads no clock: every rung that has a time in it carries the
 * instant it started (`since`) or a string the host already formatted, so the
 * ticking lives in the lane's own leaf and nothing above it re-renders once a
 * second.
 *
 * @module features/conversation/model/lane-state
 */
import type { SessionActivity } from '@dorkos/shared/session-stream';
import { activityClause, activityVerb } from '@/layers/shared/lib';
import {
  PRESENCE_NAME_LIMIT,
  heldCountSentence,
  heldSentence,
  presenceActivitySentence,
  presenceCountSentence,
  presenceElapsed,
  presenceSentence,
  silentFinishSentence,
  type PresenceCopyState,
} from '@/layers/entities/room';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import { agentNameFromCwd, describeInteraction } from '@/layers/entities/attention';
import type { ConversationCapabilities } from './capabilities';

/**
 * A prompt an agent is parked on, exactly as the fleet-wide stream carries it.
 *
 * The wire shape itself, not a view of it: the lane's Ask grows into the same
 * card the header tray and the transcript draw, and a second shape here would be
 * one more thing to keep in step for no reader's benefit. What the lane needs
 * beyond it — what to CALL the agent — comes from the host, because only a host
 * holds a roster (see {@link LaneStateInput.agentNames}).
 */
export type LaneAsk = InteractionPendingEvent;

/**
 * The empty ask list a surface with no prompts passes.
 *
 * Shared rather than a fresh `[]` per render so a quiet conversation never
 * re-derives its lane for a new array identity.
 */
export const NO_ASKS: readonly LaneAsk[] = [];

/**
 * The empty presence list a surface with no presence passes.
 *
 * Shared for the reason {@link NO_ASKS} is: a session re-derives its lane on
 * every turn event, and a fresh `[]` each time is a new identity for a memo to
 * miss on.
 */
export const NO_PRESENCE: readonly LanePresenceAuthor[] = [];

/**
 * The empty hold list a surface with nothing waiting passes.
 *
 * Shared for the reason {@link NO_ASKS} is.
 */
export const NO_HELD: readonly LaneHeldAuthor[] = [];

/**
 * One agent whose turn for this conversation has not started, because it is
 * working somewhere else.
 *
 * Not a {@link LanePresenceAuthor}: nothing is running, so there is no `state`
 * to be late in. The `since` is when the WAIT started.
 */
export interface LaneHeldAuthor {
  /** The agent the message is waiting for. */
  authorId: string;
  /** What to call it. Resolved by the host, which is the only layer holding a roster. */
  name: string;
  /** ISO 8601 — when the wait started. */
  since: string;
  /**
   * The conversation in the way.
   *
   * `title` is `null` when this reader cannot see that room, which is not a gap
   * to fill with a guess: the wire carries an id precisely so the disclosure is
   * per reader, and the copy has a sentence for the case where it resolves to
   * nothing.
   */
  behind: { roomId: string; title: string | null };
  /** True when this agent is holding a message in at least one other conversation. */
  othersWaiting: boolean;
}

/**
 * A turn that just released here with nothing to show, while its line is
 * still worth drawing.
 *
 * **Singular, unlike {@link LanePresenceAuthor} and {@link LaneHeldAuthor}.**
 * Those name a LIST because a room can have several agents working or waiting
 * at once and the sentence counts past a naming limit; this is one fading
 * line about one release; the host that feeds it (`useRoomSilentFinish`)
 * already collapses to at most one per room-scope-half, and a second turn
 * releasing silently while this one is still fading REPLACES it rather than
 * joining it — see that hook for why.
 */
export interface LaneSilentFinish {
  /** The agent whose turn released with nothing to show. */
  authorId: string;
  /** What to call it. Resolved by the host, which is the only layer holding a roster. */
  name: string;
}

/** One agent working in this conversation, as the lane reads it. */
export interface LanePresenceAuthor {
  /** The agent doing the work. */
  authorId: string;
  /** What to call it. Resolved by the host, which is the only layer holding a roster. */
  name: string;
  /** Whether the conversation is still waiting for it, or has stopped. */
  state: PresenceCopyState;
  /** ISO 8601 — when its oldest live claim started. */
  since: string;
  /**
   * What its oldest live claim is doing, or `null` when the conversation has
   * not heard a tool call for it. `null` is not a gap to fill: the lane says its
   * own less specific truth instead.
   */
  activity: SessionActivity | null;
}

/** A long-running operation the runtime is reporting on, such as compaction. */
export interface LaneOperationProgress {
  /** The producer's own label, or `null` when it sent none. */
  message: string | null;
  /** True when a completion fraction is known. */
  determinate: boolean;
  /** How far along, 0–100, or `null` when indeterminate. */
  percent: number | null;
}

/**
 * This conversation's own turn, for the surfaces that have one.
 *
 * Structural rather than imported: `features/chat` owns `OperationProgressState`
 * and `SystemStatusState`, and a feature may not reach into another feature's
 * model. The shapes are small and the session host maps onto them.
 */
export interface LaneTurn {
  /** Where the turn is. */
  status: 'idle' | 'streaming' | 'error';
  /** True while the turn is parked on the person. */
  isWaitingForUser: boolean;
  /** Which kind of wait it is. */
  waitingType: 'approval' | 'question';
  /** A long operation's progress, or `null`. */
  operationProgress: LaneOperationProgress | null;
  /** An informational runtime event, or `null`. */
  systemStatus: { message: string } | null;
  /** How long the turn has been running, already in words. */
  elapsed: string;
  /** What the session is doing, from the fleet-wide reading, or `null` when nothing is known. */
  activity: SessionActivity | null;
  /** The running token estimate, already in words. */
  tokens: string;
  /** True while this session's permission stops are off — a standing warning. */
  isBypass: boolean;
  /** True while the post-turn summary is still on screen. */
  showComplete: boolean;
  /** The finished turn's elapsed time, snapshotted when it ended. */
  lastElapsed: string;
  /** The finished turn's token count, snapshotted when it ended. */
  lastTokens: string;
}

/** Everything the priority stack reads. */
export interface LaneStateInput {
  /** What this conversation can do. Five of the ten rungs are gated by it. */
  capabilities: ConversationCapabilities;
  /**
   * Prompts addressed to this conversation — filtered by the host, by
   * `sessionId` for a session and by `roomId` for a room.
   */
  asks: readonly LaneAsk[];
  /**
   * Session id → what to call its agent, when the host holds a roster.
   *
   * The prompt itself carries no name on purpose (a copied name goes stale on a
   * rename), so a host that knows better says so here and one that does not
   * leaves it out — the lane then names the agent by its directory.
   */
  agentNames?: Readonly<Record<string, string>>;
  /**
   * True when this surface's own event stream has given up.
   *
   * Read only where `capabilities.streamHealth` says the lane is this
   * conversation's home for that fact — a session reports it in the status
   * strip under its box instead.
   */
  stalled: boolean;
  /** Who is working here, oldest claim first. */
  presence: readonly LanePresenceAuthor[];
  /**
   * Whose turn for this conversation has NOT started, oldest wait first.
   *
   * Gated by the same capability as `presence`, because it comes off the same
   * store and the same stream. Defaults to {@link NO_HELD} for every surface
   * that has no such thing.
   */
  held?: readonly LaneHeldAuthor[];
  /**
   * A turn that just released here with nothing to show, while its line is
   * still worth drawing.
   *
   * Gated by the same capability as `presence` and `held`, for the same
   * reason: it rides the same store and the same stream (D7,
   * `RoomSignalEvent.outcome`). Defaults to `null` for every surface that has
   * no such thing — a session's own turn ending is `turn.showComplete`, a
   * different fact answered a different way.
   *
   * **The HOST owns the fade, not this function.** `null` means "nothing
   * currently worth drawing", not "nothing ever happened" — a release still
   * inside {@link SILENT_FINISH_DISPLAY_MS} of its own store, everything past
   * it. This function reads no clock (see the module doc), so it trusts
   * whatever the host hands it for this render exactly as `turn.showComplete`
   * is trusted rather than re-derived from a timestamp.
   */
  silentFinish?: LaneSilentFinish | null;
  /** This conversation's own turn, or `null` on a surface that has none. */
  turn: LaneTurn | null;
}

/** Everything the live lane can be showing. One at a time, always. */
export type LaneState =
  | {
      kind: 'ask';
      /** The prompt itself, so the card the lane grows into needs nothing else. */
      ask: LaneAsk;
      /** How many prompts this conversation is holding, including this one. */
      count: number;
      /** The one line the lane shows: who wants what. */
      headline: string;
    }
  | { kind: 'stalled' }
  | {
      kind: 'presence';
      /**
       * The verb-free sentence. What the live region says and what the crossfade
       * is keyed on — deliberately NOT what is drawn when a glimpse is known. A
       * sentence that changed every two seconds would re-read itself at a screen
       * reader and re-play a fade at everybody else, for a fact nobody asked to
       * be interrupted about.
       *
       * It carries NO elapsed time either: the number lives beside the sentence
       * and outside the announcer.
       */
      sentence: string;
      /**
       * What is DRAWN. Equal to {@link sentence} unless exactly one agent is
       * working, the conversation is still waiting for it, and it has heard what
       * that agent is doing — in which case it is "Kai is reading standup.md".
       */
      line: string;
      /** The agents it speaks for, oldest claim first — the peek's rows and the faces. */
      authorIds: readonly string[];
      /** ISO 8601 — the OLDEST claim's start, which is what the elapsed time measures. */
      since: string;
      /** True once the oldest claim has outrun what the room considers normal. */
      late: boolean;
    }
  | {
      kind: 'held';
      /**
       * The one sentence, said the same way on screen and out loud. It carries
       * NO elapsed time, for the reason the presence rung's does not.
       */
      sentence: string;
      /** The agents it speaks for, oldest wait first — the peek's rows. */
      authorIds: readonly string[];
      /** ISO 8601 — the OLDEST wait's start, which is what the elapsed time measures. */
      since: string;
    }
  | {
      kind: 'silent-finish';
      /**
       * The one sentence, past tense: who finished, and that there was nothing
       * to add. No elapsed time and no live region beyond the sentence itself —
       * unlike `presence` and `held`, nothing here is still happening.
       */
      sentence: string;
      /** The agent it speaks for. */
      authorId: string;
    }
  | { kind: 'turn-waiting'; waitingType: 'approval' | 'question'; elapsed: string }
  | { kind: 'turn-progress'; message: string; determinate: boolean; percent: number | null }
  | { kind: 'turn-system'; message: string }
  | {
      kind: 'turn-streaming';
      /** What the session is doing, phrased by the honesty ladder. */
      verb: string;
      /** Crossfade key — the label itself, so it animates only on a real change. */
      verbKey: string;
      elapsed: string;
      tokens: string;
      /** True while this session's permission stops are off. */
      isBypass: boolean;
    }
  | { kind: 'turn-complete'; elapsed: string; tokens: string }
  | { kind: 'empty' };

/** One shared empty lane, so a quiet conversation never re-renders on identity. */
const EMPTY: LaneState = { kind: 'empty' };

/**
 * How old a claim has to be before the lane puts a number on it.
 *
 * A timer that starts at `0s` draws the eye for nothing, and the eye is the
 * whole budget a line above the composer has. Below this the sentence stands
 * alone; above it the elapsed time appears and ticks locally, exactly as it
 * does today (design record, "Just started (< 10s)").
 */
export const LANE_TIMER_FLOOR_MS = 10_000;

/**
 * How long a claim has been running, in the shortest true form — or `null`
 * while it is too young to be worth a number.
 *
 * Split out of {@link deriveLaneState} rather than folded into it because it is
 * the one part of the presence rung that is a function of NOW: the state carries
 * the immutable `since`, and the lane's own text node — a leaf — reads the clock
 * once a second. That is what keeps the timeline above it still while an agent
 * works.
 *
 * @param since - ISO 8601, the claim's start.
 * @param now - This client's clock, injectable for tests.
 * @returns The elapsed time in words, or `null` under {@link LANE_TIMER_FLOOR_MS}.
 */
export function laneElapsed(since: string, now: number): string | null {
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < LANE_TIMER_FLOOR_MS) return null;
  return presenceElapsed(ms);
}

/**
 * Decide what the lane says, from everything that could want to say something.
 *
 * **Priority, first match wins.** Each rung names the capability that gates it:
 *
 * 1. `ask` — `capabilities.asks`. A prompt somebody can answer.
 * 2. `stalled` — `capabilities.streamHealth`. This client cannot read the stream.
 * 3. `presence` — `capabilities.presence`. Somebody else is working here.
 * 4. `held` — `capabilities.presence`. An answer this conversation is owed has
 *    not started, because the agent is working somewhere else.
 * 5. `silent-finish` — `capabilities.presence`. A turn just released here with
 *    nothing to show (D7).
 * 6. `turn-waiting` — `capabilities.turnStatus`. This turn is parked.
 * 7. `turn-progress` — `capabilities.turnStatus`. A long operation is running.
 * 8. `turn-system` — `capabilities.turnStatus`. An informational runtime event.
 * 9. `turn-streaming` — `capabilities.turnStatus`. A turn in flight.
 * 10. `turn-complete` — `capabilities.turnStatus`. The summary, auto-dismissing.
 * 11. `empty` — nothing to say, and the lane looks like it.
 *
 * **There is no `queued` rung, and that is a decision.** One sat below every
 * `turn-*` rung, and a queue only ever exists BECAUSE a turn is in flight — so
 * rung 9 always won and a person with two messages held saw no mention of them
 * at all. Reordering it above the turn would be worse: it would hide what the
 * agent is doing in order to report a number. The composer's own queue panel is
 * where held drafts live, and it is where they stay.
 *
 * **`held` is not that rung coming back**, and three things separate them. It
 * reports a different fact — `queued` counted the person's own undelivered
 * drafts, and this is about a message already on the room's log that the room
 * owes an answer to. It is reachable: a room's `turnStatus` is off, so rungs
 * 6-10 do not exist there, and in the case this describes the agent is busy
 * ELSEWHERE, so nobody is working here and rung 3 is empty. And it hides
 * nothing: when somebody genuinely is working here, `presence` still wins the
 * headline and the wait shows as a row in the peek that rung already opens.
 *
 * **`silent-finish` sits below `held`, never above it.** A message this
 * conversation is still owed an answer to (`held`) is a live concern; a report
 * that a DIFFERENT turn already released with nothing to show is a past-tense
 * footnote by comparison, and a room can be in both states from two different
 * agents at once. It sits above every `turn-*` rung for the opposite reason:
 * those describe THIS conversation's own turn on a surface that has one (a
 * session), where `silent-finish` never fires at all — `capabilities.presence`
 * is off wherever `turnStatus` is on today, so the two have never had to be
 * ordered against each other in practice, and this is the order that would
 * hold if they ever did.
 *
 * Three of those orderings are decisions rather than arbitrary, and none of them
 * may be collapsed:
 *
 * - **`stalled` beats `presence`.** A client that cannot read the stream must not
 *   claim to know who is working (`specs/room-presence` §5.4). The presence store
 *   is CLEARED on a stall rather than merely hidden, so this rung and that clear
 *   agree; this is the belt to that clear's braces.
 * - **`ask` beats `stalled`.** An Ask already in hand is still true and still
 *   answerable when the wire goes quiet — its countdown runs off `startedAt`, not
 *   off the stream. A stalled line that hid a live Ask would recreate the exact
 *   failure this programme exists to remove.
 * - **`turn-waiting` survives even though rung 1 exists.** They are different
 *   facts. Rung 1 is "there is a prompt OBJECT here you can answer"; rung 6 is
 *   "this session's turn is parked" in a state the projector reported with no
 *   prompt in hand — a capability hold, or a runtime that said `blocked` and sent
 *   nothing else. Collapsing them makes the second silently invisible.
 *
 * @param input - Everything the stack reads.
 */
export function deriveLaneState(input: LaneStateInput): LaneState {
  const { capabilities, turn } = input;

  // 1. An Ask, which outranks even a stream that has stopped.
  if (capabilities.asks && input.asks.length > 0) {
    const ask = input.asks[0]!;
    return {
      kind: 'ask',
      ask,
      count: input.asks.length,
      headline: `${input.agentNames?.[ask.sessionId] ?? agentNameFromCwd(ask.cwd)} ${describeInteraction(ask.interaction)}`,
    };
  }

  // 2. A stream this client cannot read — where the lane is this conversation's
  // home for that fact. A session says it in the status strip under its box
  // instead, and two alarms about one fact teach people to read neither.
  if (capabilities.streamHealth && input.stalled) return { kind: 'stalled' };

  // 3. Somebody else working here.
  if (capabilities.presence && input.presence.length > 0) {
    return presenceRung(input.presence);
  }

  // 4. Somebody's answer to THIS conversation has not started yet.
  const held = input.held ?? NO_HELD;
  if (capabilities.presence && held.length > 0) return heldRung(held);

  // 5. A turn that just released here with nothing to show (D7). `null` covers
  // both "nothing has" and "the host's own fade window ended" — this function
  // reads no clock, so it trusts whichever the host is currently reporting.
  const silentFinish = input.silentFinish ?? null;
  if (capabilities.presence && silentFinish !== null) {
    return {
      kind: 'silent-finish',
      sentence: silentFinishSentence(silentFinish.name),
      authorId: silentFinish.authorId,
    };
  }

  if (capabilities.turnStatus && turn !== null) {
    // 6. Parked on the person.
    if (turn.status === 'streaming' && turn.isWaitingForUser) {
      return { kind: 'turn-waiting', waitingType: turn.waitingType, elapsed: turn.elapsed };
    }

    // 7. A long operation — the structured, runtime-agnostic progress treatment
    // (DOR-110), shown whatever the turn's status. The producer supplies the
    // label, so there is no status string to match.
    if (turn.operationProgress) {
      const { message, determinate, percent } = turn.operationProgress;
      return {
        kind: 'turn-progress',
        message: message ?? 'Working…',
        determinate,
        percent: percent ?? null,
      };
    }

    // 8. An informational runtime event, also whatever the turn's status.
    if (turn.systemStatus) return { kind: 'turn-system', message: turn.systemStatus.message };

    // 9. A turn in flight.
    if (turn.status === 'streaming') {
      // Through the honesty ladder, not around it (BC-37): one entry point, one
      // phrasing, everywhere. `'streaming'` is a fact this branch has already
      // established rather than a guess — the ladder's `blocked` rung belongs to
      // rung 6 above — which also buys the non-null overload, so there is no
      // fallback here to drift into a second way of saying "Working…".
      const verb = activityVerb('streaming', turn.activity);
      return {
        kind: 'turn-streaming',
        verb,
        // The label IS the key: the crossfade plays when what the session is
        // doing changes, and stays still while it does not.
        verbKey: verb,
        elapsed: turn.elapsed,
        tokens: turn.tokens,
        isBypass: turn.isBypass,
      };
    }

    // 10. The finished turn's summary, on its way out.
    if (turn.showComplete) {
      return { kind: 'turn-complete', elapsed: turn.lastElapsed, tokens: turn.lastTokens };
    }
  }

  // 11. Nothing to say.
  return EMPTY;
}

/**
 * The held rung: what is waiting to start, and behind what.
 *
 * Named up to {@link PRESENCE_NAME_LIMIT} and counted above it, exactly as the
 * presence rung is. The room in the way is taken from the OLDEST wait and read
 * only in the single-agent case — see {@link heldSentence} for why naming one of
 * several would be picking a favourite.
 *
 * @param held - Who has not started, oldest wait first.
 */
function heldRung(held: readonly LaneHeldAuthor[]): LaneState {
  const oldest = held[0]!;
  const counted = held.length > PRESENCE_NAME_LIMIT;
  const sentence = counted
    ? heldCountSentence(held.length)
    : heldSentence(
        held.map((agent) => agent.name),
        oldest.behind.title
      );
  return {
    kind: 'held',
    sentence,
    authorIds: held.map((agent) => agent.authorId),
    // The OLDEST wait's start, so the number beside the sentence is the longest
    // anybody here has been waiting rather than the shortest.
    since: oldest.since,
  };
}

/**
 * The presence rung, in the words `specs/room-presence` settled on.
 *
 * Named rather than counted up to {@link PRESENCE_NAME_LIMIT}, counted above it,
 * and the state that speaks for the line is the OLDEST claim's: it is the one
 * the elapsed time measures and the one that crosses the server's late threshold
 * first.
 *
 * @param presence - Who is working, oldest claim first.
 */
function presenceRung(presence: readonly LanePresenceAuthor[]): LaneState {
  const oldest = presence[0]!;
  const counted = presence.length > PRESENCE_NAME_LIMIT;
  const sentence = counted
    ? presenceCountSentence(presence.length, oldest.state)
    : presenceSentence(
        presence.map((agent) => agent.name),
        oldest.state
      );
  // ONE agent only, because the lane is one line that never wraps: "Kai and Ana
  // are working on it" cannot carry two verbs, and picking one to speak for both
  // is a lie about the other. `working` only, because `working_late`'s sentence
  // already truncates on a 375 px screen and its long-wait clause is the one
  // actionable thing in it. The peek answers both cases, where there is room.
  const glimpse =
    presence.length === 1 && oldest.state === 'working' ? activityClause(oldest.activity) : null;
  return {
    kind: 'presence',
    sentence,
    line: glimpse === null ? sentence : presenceActivitySentence(oldest.name, glimpse),
    authorIds: presence.map((agent) => agent.authorId),
    since: oldest.since,
    late: oldest.state === 'working_late',
  };
}
