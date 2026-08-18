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
import { activityVerb } from '@/layers/shared/lib';
import {
  PRESENCE_NAME_LIMIT,
  presenceCountSentence,
  presenceElapsed,
  presenceSentence,
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
  /** True when this surface's own event stream has given up. */
  stalled: boolean;
  /** Who is working here, oldest claim first. */
  presence: readonly LanePresenceAuthor[];
  /** This conversation's own turn, or `null` on a surface that has none. */
  turn: LaneTurn | null;
  /** How many drafts the composer is holding for the current turn. */
  queueDepth: number;
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
       * The one sentence, said the same way on screen and out loud. It carries
       * NO elapsed time: a live region that reworded itself every second would
       * make the room unusable, so the number lives beside the sentence and
       * outside the announcer.
       */
      sentence: string;
      /** The agents it speaks for, oldest claim first — the peek's rows and the faces. */
      authorIds: readonly string[];
      /** ISO 8601 — the OLDEST claim's start, which is what the elapsed time measures. */
      since: string;
      /** True once the oldest claim has outrun what the room considers normal. */
      late: boolean;
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
  | { kind: 'queued'; depth: number }
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
 * 2. `stalled` — always. This client cannot read the stream.
 * 3. `presence` — `capabilities.presence`. Somebody else is working here.
 * 4. `turn-waiting` — `capabilities.turnStatus`. This turn is parked.
 * 5. `turn-progress` — `capabilities.turnStatus`. A long operation is running.
 * 6. `turn-system` — `capabilities.turnStatus`. An informational runtime event.
 * 7. `turn-streaming` — `capabilities.turnStatus`. A turn in flight.
 * 8. `turn-complete` — `capabilities.turnStatus`. The summary, auto-dismissing.
 * 9. `queued` — `queueDepth > 0`. Drafts held for the current turn.
 * 10. `empty` — nothing to say, and the lane looks like it.
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
 *   facts. Rung 1 is "there is a prompt OBJECT here you can answer"; rung 4 is
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

  // 2. A stream this client cannot read.
  if (input.stalled) return { kind: 'stalled' };

  // 3. Somebody else working here.
  if (capabilities.presence && input.presence.length > 0) {
    return presenceRung(input.presence);
  }

  if (capabilities.turnStatus && turn !== null) {
    // 4. Parked on the person.
    if (turn.status === 'streaming' && turn.isWaitingForUser) {
      return { kind: 'turn-waiting', waitingType: turn.waitingType, elapsed: turn.elapsed };
    }

    // 5. A long operation — the structured, runtime-agnostic progress treatment
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

    // 6. An informational runtime event, also whatever the turn's status.
    if (turn.systemStatus) return { kind: 'turn-system', message: turn.systemStatus.message };

    // 7. A turn in flight.
    if (turn.status === 'streaming') {
      // Through the honesty ladder, not around it (BC-37): one entry point, one
      // phrasing, everywhere. `'streaming'` is a fact this branch has already
      // established rather than a guess — the ladder's `blocked` rung belongs to
      // rung 4 above — which also buys the non-null overload, so there is no
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

    // 8. The finished turn's summary, on its way out.
    if (turn.showComplete) {
      return { kind: 'turn-complete', elapsed: turn.lastElapsed, tokens: turn.lastTokens };
    }
  }

  // 9. Drafts the composer is holding.
  if (input.queueDepth > 0) return { kind: 'queued', depth: input.queueDepth };

  // 10. Nothing to say.
  return EMPTY;
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
  return {
    kind: 'presence',
    sentence,
    authorIds: presence.map((agent) => agent.authorId),
    since: oldest.since,
    late: oldest.state === 'working_late',
  };
}
