/**
 * Telling whoever started a piece of work about the turns the agent takes on it
 * later, on its own (DOR-2717).
 *
 * ## The gap this closes
 *
 * A caller that dispatches a turn — a relay message, a scheduled run — reads
 * that turn's stream and is done when it ends. Under a warm process the agent
 * is not always done then: it can hand the work to a background helper, end its
 * turn with "I will report back", and give the actual answer in a turn it
 * starts itself when the helper finishes. {@link subscribeRuntimeTurns} projects
 * that later turn into the session, so a person watching the chat sees it; the
 * caller that asked for the work never did. Its answer was the promise, and the
 * thing promised went nowhere it was listening.
 *
 * ## What this offers instead
 *
 * Every turn the agent starts on its own is announced here once it has ended,
 * with the words it said ({@link SettledRuntimeTurn}). A caller that saw its own
 * turn end while the agent still held background work
 * (`AgentRuntime.holdsBackgroundWork`) follows the session with
 * {@link followLateTurns}, and is handed each later turn until the agent holds
 * nothing more, its window closes, or newer work on the same session takes
 * over.
 *
 * ## Why any new work ends every follow
 *
 * A later turn carries no label saying which request it answers. Once anyone
 * dispatches a turn into the session — a person's message, a room turn, a run,
 * another relay message — a turn the agent starts afterwards may be answering
 * THAT, and its words must not reach a caller who never asked for them. So the
 * runtime reports every dispatched turn (`AgentRuntime.onDispatchedTurn`) and
 * every follow of that session ends there ({@link noteDispatchedTurn}). A
 * newer follow by the same kind of caller replaces an older one for the same
 * reason.
 *
 * A follow that ends any way but on a final turn says so ({@link
 * LateFollowEnd}), so a caller that promised more can tell its own caller that
 * nothing more is coming rather than leave it waiting.
 *
 * @module services/session/runtime-turns/late-turns
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { logError, logger } from '../../../lib/logger.js';

/** One turn the agent started on its own, as it ended. */
export interface SettledRuntimeTurn {
  /** The runtime the turn ran on. */
  runtime: AgentRuntime;
  /** The session id the runtime announced the turn under. */
  sessionId: string;
  /** Everything the agent said in the turn, in order. */
  text: string;
  /** Why the turn failed, when it did. `text` is then whatever came before. */
  error?: string;
}

/** One later turn, as handed to a follower. */
export interface LateTurn {
  /** Everything the agent said in the turn. */
  text: string;
  /** Why the turn failed, when it did. */
  error?: string;
  /**
   * Whether the agent still holds background work after this turn, so another
   * late turn may follow it. When false this was the last one the follower
   * will be handed.
   */
  continuing: boolean;
}

/**
 * Why a follow ended. `final` — the agent ended a turn holding no more work;
 * `expired` — its window passed; `superseded` — new work reached the session,
 * or a newer follower of the same kind took it; `stopped` — the caller ended it.
 */
export type LateFollowEnd = 'final' | 'expired' | 'superseded' | 'stopped';

/** Options for {@link followLateTurns}. */
export interface FollowLateTurnsOptions {
  /** Which kind of caller follows — newer work replaces older within a kind. */
  owner: string;
  /** The runtime the session runs on. */
  runtime: AgentRuntime;
  /** The session, in any id the runtime answers to. */
  sessionId: string;
  /** How long to keep following before giving up, in milliseconds. */
  windowMs: number;
  /** Handed each later turn, in order. A throw is logged and swallowed. */
  onTurn: (turn: LateTurn) => void;
  /** Told once, after the last turn, why the follow ended. A throw is logged. */
  onEnd?: (reason: LateFollowEnd) => void;
  /**
   * The session's {@link dispatchedTurnMark}, read the moment the caller's own
   * turn ended. If anyone dispatched into the session since, the follow ends as
   * `superseded` at once: the gap between a turn ending and its caller getting
   * round to following is long enough for a person's message to land in.
   */
  sinceMark?: number;
}

const settledListeners = new Set<(turn: SettledRuntimeTurn) => void>();

/** One live follow, by `owner` + runtime + resolved session. */
interface Follower {
  runtime: AgentRuntime;
  sessionId: string;
  end: (reason: LateFollowEnd) => void;
}

const followers = new Map<string, Follower>();

/**
 * How many dispatched turns each session has taken, by runtime + resolved id —
 * the mark {@link FollowLateTurnsOptions.sinceMark} is compared against.
 * Bounded: the oldest session is forgotten past the cap, which at worst lets a
 * long-idle session's follow start without the race check.
 */
const dispatchCounts = new Map<string, number>();
const DISPATCH_COUNTS_CAP = 5_000;

/**
 * The key a session's dispatch count is kept under.
 *
 * @param runtime - The runtime that owns the session
 * @param sessionId - The session, in any id it answers to
 */
function countKey(runtime: AgentRuntime, sessionId: string): string {
  return `${runtime.type}\u0000${resolvedKey(runtime, sessionId)}`;
}

/**
 * How many dispatched turns this session has taken, as an opaque mark. Read it
 * when a turn ends and hand it to {@link followLateTurns} as `sinceMark`.
 *
 * @param runtime - The runtime that owns the session
 * @param sessionId - The session, in any id it answers to
 * @returns The current mark
 */
export function dispatchedTurnMark(runtime: AgentRuntime, sessionId: string): number {
  return dispatchCounts.get(countKey(runtime, sessionId)) ?? 0;
}

/**
 * Announce that a turn the agent started on its own has ended.
 *
 * Called by the runtime-turn projection once per turn, after the turn is on
 * the durable stream. A listener that throws is logged and never reaches the
 * projection.
 *
 * @param turn - The turn, as it ended
 */
export function noteRuntimeTurnSettled(turn: SettledRuntimeTurn): void {
  for (const listener of [...settledListeners]) {
    try {
      listener(turn);
    } catch (err) {
      logger.warn('[late-turns] a follower of a later turn threw', {
        sessionId: turn.sessionId,
        ...logError(err),
      });
    }
  }
}

/**
 * The id a session's turns are keyed on — the runtime's own name for it.
 *
 * @param runtime - The runtime that owns the session
 * @param sessionId - The session, in any id it answers to
 */
function resolvedKey(runtime: AgentRuntime, sessionId: string): string {
  return runtime.getInternalSessionId(sessionId) ?? sessionId;
}

/**
 * Follow a session's later turns on behalf of the work that just ended on it.
 *
 * Call it only once the dispatched turn has ended and
 * `runtime.holdsBackgroundWork` said more may come — it hands over nothing
 * that ended before the call. Ends by itself after the first later turn the
 * agent ends holding nothing, when `windowMs` passes, when a dispatched turn
 * opens on the session, or when a newer follower of the same `owner` takes it
 * — and tells `onEnd` which.
 *
 * @param opts - What to follow, for how long, and who to tell
 * @returns Stops following; safe to call more than once
 */
export function followLateTurns(opts: FollowLateTurnsOptions): () => void {
  const { runtime, sessionId, owner } = opts;
  const followerKey = `${owner}\u0000${runtime.type}\u0000${resolvedKey(runtime, sessionId)}`;
  followers.get(followerKey)?.end('superseded');

  let ended = false;
  const listener = (turn: SettledRuntimeTurn): void => {
    if (turn.runtime !== runtime || !sameSession(runtime, turn.sessionId, sessionId)) return;
    const continuing = runtime.holdsBackgroundWork?.(sessionId) === true;
    try {
      opts.onTurn({
        text: turn.text,
        ...(turn.error !== undefined ? { error: turn.error } : {}),
        continuing,
      });
    } catch (err) {
      logger.warn('[late-turns] a caller could not take a later turn', {
        sessionId,
        owner,
        ...logError(err),
      });
    }
    if (!continuing) end('final');
  };
  const timer = setTimeout(() => end('expired'), opts.windowMs);
  timer.unref?.();

  function end(reason: LateFollowEnd): void {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    settledListeners.delete(listener);
    if (followers.get(followerKey)?.end === end) followers.delete(followerKey);
    try {
      opts.onEnd?.(reason);
    } catch (err) {
      logger.warn('[late-turns] a caller could not take the end of a follow', {
        sessionId,
        owner,
        reason,
        ...logError(err),
      });
    }
  }

  settledListeners.add(listener);
  followers.set(followerKey, { runtime, sessionId, end });
  // Work reached the session between the caller's turn ending and this call.
  if (opts.sinceMark !== undefined && opts.sinceMark !== dispatchedTurnMark(runtime, sessionId)) {
    end('superseded');
  }
  return () => end('stopped');
}

/**
 * Whether two ids name the same session, resolved at the moment of asking: a
 * first turn's request id becomes the runtime's own id once it is renamed.
 *
 * @param runtime - The runtime that owns the session
 * @param a - One id
 * @param b - The other
 */
function sameSession(runtime: AgentRuntime, a: string, b: string): boolean {
  return a === b || resolvedKey(runtime, a) === resolvedKey(runtime, b);
}

/**
 * End every follow of a session because a dispatched turn just opened on it.
 *
 * Called from the runtime's `onDispatchedTurn` (wired by
 * `subscribeRuntimeTurns`), for every kind of dispatch — so a person's private
 * chat, a room turn or another caller's message can never have its answer
 * handed to a caller still following from earlier work.
 *
 * @param runtime - The runtime the turn opened on
 * @param sessionId - The session, in any id it answers to
 */
export function noteDispatchedTurn(runtime: AgentRuntime, sessionId: string): void {
  const key = countKey(runtime, sessionId);
  const count = (dispatchCounts.get(key) ?? 0) + 1;
  dispatchCounts.delete(key);
  dispatchCounts.set(key, count);
  if (dispatchCounts.size > DISPATCH_COUNTS_CAP) {
    const oldest = dispatchCounts.keys().next().value;
    if (oldest !== undefined) dispatchCounts.delete(oldest);
  }
  for (const follower of [...followers.values()]) {
    if (follower.runtime === runtime && sameSession(runtime, follower.sessionId, sessionId)) {
      follower.end('superseded');
    }
  }
}

/** Drop every follower. Tests only. */
export function resetLateTurnFollowers(): void {
  for (const follower of [...followers.values()]) follower.end('stopped');
  settledListeners.clear();
  dispatchCounts.clear();
}

/** A source of later turns, in the shape a dispatching caller asks for one. */
export interface LateTurnSourceOptions {
  /** Which kind of caller follows — see {@link FollowLateTurnsOptions.owner}. */
  owner: string;
  /** The runtime registered under a type, or undefined when none is. */
  runtimeFor: (runtimeType: string) => AgentRuntime | undefined;
  /** How long each follow lasts, in milliseconds. */
  windowMs: number;
}

/**
 * Wrap {@link followLateTurns} for a caller that knows a session by runtime
 * type and key rather than by runtime object — the relay adapter's view.
 *
 * @param opts - Who follows, how runtimes are found, and for how long
 * @returns A source whose `follow` is a no-op for a runtime nobody registered
 */
export function createLateTurnSource(opts: LateTurnSourceOptions): {
  dispatchMark: (args: { runtimeType: string; sessionKey: string }) => number;
  follow: (args: {
    runtimeType: string;
    sessionKey: string;
    onTurn: (turn: LateTurn) => void;
    onEnd?: (reason: LateFollowEnd) => void;
    sinceMark?: number;
  }) => () => void;
} {
  return {
    dispatchMark: ({ runtimeType, sessionKey }) => {
      const runtime = opts.runtimeFor(runtimeType);
      return runtime === undefined ? 0 : dispatchedTurnMark(runtime, sessionKey);
    },
    follow: ({ runtimeType, sessionKey, onTurn, onEnd, sinceMark }) => {
      const runtime = opts.runtimeFor(runtimeType);
      if (runtime === undefined) {
        // Nothing can be followed, so the follow ends at once — and says so.
        onEnd?.('stopped');
        return () => {};
      }
      return followLateTurns({
        owner: opts.owner,
        runtime,
        sessionId: sessionKey,
        windowMs: opts.windowMs,
        onTurn,
        ...(onEnd !== undefined ? { onEnd } : {}),
        ...(sinceMark !== undefined ? { sinceMark } : {}),
      });
    },
  };
}
