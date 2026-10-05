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
 * ## Why newer work takes over
 *
 * A later turn carries no label saying which request it answers. While one
 * caller follows a session nothing else can dispatch into it without the
 * follower noticing, so the honest rule is the simple one: the most recent
 * follower of a session, per kind of caller, is the one a later turn belongs
 * to. A sticky task's next run, or the next relay message to the same agent,
 * replaces the earlier follower rather than splitting the agent's words between
 * two callers.
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
}

const settledListeners = new Set<(turn: SettledRuntimeTurn) => void>();

/** The live follower per `owner` + resolved session, so newer work replaces it. */
const followers = new Map<string, () => void>();

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
 * agent ends holding nothing, when `windowMs` passes, or when a newer follower
 * of the same `owner` takes the session.
 *
 * @param opts - What to follow, for how long, and who to tell
 * @returns Stops following; safe to call more than once
 */
export function followLateTurns(opts: FollowLateTurnsOptions): () => void {
  const { runtime, sessionId, owner } = opts;
  const followerKey = `${owner}\u0000${runtime.type}\u0000${resolvedKey(runtime, sessionId)}`;
  followers.get(followerKey)?.();

  let stopped = false;
  const listener = (turn: SettledRuntimeTurn): void => {
    if (turn.runtime !== runtime) return;
    // Both sides resolved at match time, not at follow time: a first turn's
    // request id becomes the runtime's own id once the session is renamed.
    const mine =
      turn.sessionId === sessionId ||
      resolvedKey(runtime, turn.sessionId) === resolvedKey(runtime, sessionId);
    if (!mine) return;
    const continuing = runtime.holdsBackgroundWork?.(sessionId) === true;
    if (!continuing) stop();
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
  };
  const timer = setTimeout(() => stop(), opts.windowMs);
  timer.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    settledListeners.delete(listener);
    if (followers.get(followerKey) === stop) followers.delete(followerKey);
  }

  settledListeners.add(listener);
  followers.set(followerKey, stop);
  return stop;
}

/** Drop every follower. Tests only. */
export function resetLateTurnFollowers(): void {
  for (const stop of [...followers.values()]) stop();
  settledListeners.clear();
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
  follow: (args: {
    runtimeType: string;
    sessionKey: string;
    onTurn: (turn: LateTurn) => void;
  }) => () => void;
} {
  return {
    follow: ({ runtimeType, sessionKey, onTurn }) => {
      const runtime = opts.runtimeFor(runtimeType);
      if (runtime === undefined) return () => {};
      return followLateTurns({
        owner: opts.owner,
        runtime,
        sessionId: sessionKey,
        windowMs: opts.windowMs,
        onTurn,
      });
    },
  };
}
