/**
 * The backstop that keeps a paused agent from starting any turn (spec
 * `audit-trail` PR5), at the one seam every turn passes through:
 * `runtimeRegistry.register()`. A person's message, a room reply, a scheduled
 * run, a relay or connector delivery and an extension's work all resolve their
 * runtime there, so a turn for a paused agent is refused here whichever way it
 * came, on every runtime.
 *
 * The entry points refuse earlier with a clearer answer (the app offers Resume,
 * the scheduler records a skipped run, a room says so once). This is what makes
 * "a paused agent starts no turn from any surface" true for the paths that do
 * not, and for any path added later.
 *
 * Same Proxy shape as the keep-awake and audit decorators. Five members are
 * intercepted, each a way a turn can start or grow:
 *
 * - `sendMessage` and `executeCommandIntent` (a summary is a turn too): a
 *   refused turn throws {@link AgentPausedError} on its first `next()`, before
 *   the runtime is asked for anything, and records one `agent.turn_held` row.
 * - `deliverIntoTurn` and `canStageSession`: a steer or a stage for a paused
 *   agent is refused (`stream-closed`, not stageable), so the server queues or
 *   folds it, and the queued message meets the hold above. A stage would
 *   otherwise boot the agent's process.
 * - `onRuntimeTurn`: a turn the AGENT opened on its own (a helper reporting
 *   back, a wake-up timer, work it picked back up) has no dispatch to refuse.
 *   It is stopped as it opens, and its session ended, so it cannot reopen.
 *
 * A turn that runs is remembered until it ends, so a pause that lands mid-turn
 * can stop it. A pause that lands while the turn is still launching, before
 * the runtime holds anything to interrupt, is caught at the turn's next event.
 * Which agent a turn belongs to is read from its options, else from the folder
 * its runtime stored for the session.
 *
 * @module services/mesh/pause/hold-paused-turns
 */
import type {
  AgentRuntime,
  CommandIntentOpts,
  DeliverIntoTurnOpts,
  MessageOpts,
  RuntimeDeliveryResult,
} from '@dorkos/shared/agent-runtime';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  AgentPausedError,
  agentPause,
  type AgentPauseService,
  type LiveTurn,
  type TurnAgentOpts,
} from './agent-pause.js';

/** The session's stored folder, read lazily and never thrown. */
function storedCwdOf(runtime: AgentRuntime, sessionId: string): () => string | undefined {
  return () => runtime.getSessionCwd?.(sessionId);
}

/** The turn's options, with the session's stored folder when it names none. */
function withStoredCwd(
  runtime: AgentRuntime,
  sessionId: string,
  opts: TurnAgentOpts
): TurnAgentOpts {
  if (opts?.cwd || opts?.forAgent || opts?.roomTurn) return opts;
  let cwd: string | undefined;
  try {
    cwd = runtime.getSessionCwd?.(sessionId);
  } catch {
    cwd = undefined;
  }
  return cwd ? { ...opts, cwd } : opts;
}

/**
 * Pass a tracked turn's events on until a pause asks it to stop. A pause that
 * lands while the turn is still launching finds nothing to interrupt (the
 * runtime answers `not-running`), so the turn's first event after it is where
 * it ends: interrupted, its session ended, and refused as paused. Closing the
 * runtime's generator on the throw ends what it was about to run.
 */
async function* untilPaused(
  runtime: AgentRuntime,
  pauses: AgentPauseService,
  turn: LiveTurn,
  events: AsyncIterable<StreamEvent>
): AsyncGenerator<StreamEvent> {
  for await (const event of events) {
    if (turn.stopRequested) {
      const paused = pauses.pausedAgentOfSession(
        turn.sessionId,
        storedCwdOf(runtime, turn.sessionId),
        turn.opts
      );
      if (paused) {
        await pauses.stopSession(runtime, turn.sessionId, paused);
        throw new AgentPausedError(paused);
      }
      // Lifted again before the turn spoke: nothing to stop.
      turn.stopRequested = false;
    }
    yield event;
  }
}

/** A turn that only refuses: thrown when its caller first reads it. */
function refused(error: Error): AsyncGenerator<StreamEvent> {
  // `yield*` of an empty list keeps this a real generator for `require-yield`.
  return (async function* () {
    yield* [];
    throw error;
  })();
}

/** Pass a turn's events on, and forget it when it ends. */
async function* tracked(
  runtime: AgentRuntime,
  pauses: AgentPauseService,
  turn: LiveTurn,
  events: AsyncGenerator<StreamEvent>,
  forget: () => void
): AsyncGenerator<StreamEvent> {
  try {
    yield* untilPaused(runtime, pauses, turn, events);
  } finally {
    forget();
  }
}

/**
 * Run one dispatched turn, or refuse it when its agent is paused. Not itself a
 * generator: the runtime's own `sendMessage` is called right away, as it is
 * without this hold, so whatever it does on the call (claim a receipt, open a
 * session) happens when the caller dispatched, not when it first reads.
 */
function holdOrRun(
  runtime: AgentRuntime,
  sessionId: string,
  opts: MessageOpts | undefined,
  run: () => AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const pauses = agentPause();
  if (!pauses) return run();
  const paused = pauses.pausedAgentOfSession(sessionId, storedCwdOf(runtime, sessionId), opts);
  if (paused) {
    pauses.recordHeld(paused, { via: 'turn', sessionId, runtime: runtime.type });
    return refused(new AgentPausedError(paused));
  }
  const turn: LiveTurn = {
    sessionId,
    opts: withStoredCwd(runtime, sessionId, opts),
    interrupt: () => runtime.interruptQuery(sessionId),
  };
  const forget = pauses.trackTurn(turn);
  return tracked(runtime, pauses, turn, run(), forget);
}

/**
 * One turn the agent opened on its own. Stopped as it opens when its agent is
 * paused; otherwise remembered until it ends, so a pause can stop it. Its
 * events always reach the listener, so the turn is seen to end either way.
 */
async function* holdRuntimeTurn(
  runtime: AgentRuntime,
  sessionId: string,
  events: AsyncIterable<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const pauses = agentPause();
  if (!pauses) {
    yield* events;
    return;
  }
  const paused = pauses.pausedAgentOfSession(sessionId, storedCwdOf(runtime, sessionId));
  if (paused) {
    pauses.recordHeld(paused, { via: 'turn', sessionId, runtime: runtime.type });
    void pauses.stopSession(runtime, sessionId, paused);
    yield* events;
    return;
  }
  const turn: LiveTurn = {
    sessionId,
    opts: withStoredCwd(runtime, sessionId, undefined),
    interrupt: () => runtime.interruptQuery(sessionId),
  };
  const forget = pauses.trackTurn(turn);
  try {
    yield* untilPaused(runtime, pauses, turn, events);
  } finally {
    forget();
  }
}

/**
 * Wrap a runtime so no turn starts for a paused agent, and every running turn
 * can be stopped by a pause.
 *
 * @param runtime - The runtime to wrap.
 * @returns A proxy over the runtime.
 */
export function holdPausedAgents(runtime: AgentRuntime): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (sessionId: string, content: string, opts?: MessageOpts) =>
          holdOrRun(target, sessionId, opts, () => target.sendMessage(sessionId, content, opts));
      }
      if (prop === 'executeCommandIntent') {
        return (sessionId: string, intent: RuntimeCommandIntentId, opts?: CommandIntentOpts) =>
          holdOrRun(target, sessionId, opts, () =>
            target.executeCommandIntent(sessionId, intent, opts)
          );
      }
      if (prop === 'deliverIntoTurn' && typeof target.deliverIntoTurn === 'function') {
        const deliver = target.deliverIntoTurn.bind(target);
        return async (
          sessionId: string,
          content: string,
          opts: DeliverIntoTurnOpts
        ): Promise<RuntimeDeliveryResult> => {
          // A steer would grow a paused agent's turn, and a stage would boot
          // its process: both are refused, so the server queues or folds them,
          // and the queued message meets the hold above.
          const paused = agentPause()?.pausedAgentOfSession(
            sessionId,
            storedCwdOf(target, sessionId)
          );
          if (paused) {
            // A stage answers `unsupported`, so the words are kept and folded
            // into the next message, which the hold then refuses.
            return {
              delivered: false,
              reason: opts.mode === 'stage' ? 'unsupported' : 'stream-closed',
            };
          }
          return deliver(sessionId, content, opts);
        };
      }
      if (prop === 'canStageSession' && typeof target.canStageSession === 'function') {
        const canStage = target.canStageSession.bind(target);
        return (sessionId: string): boolean =>
          !agentPause()?.pausedAgentOfSession(sessionId, storedCwdOf(target, sessionId)) &&
          canStage(sessionId);
      }
      if (prop === 'onRuntimeTurn' && typeof target.onRuntimeTurn === 'function') {
        const subscribe = target.onRuntimeTurn.bind(target);
        return (listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void) =>
          subscribe((sessionId, events) =>
            listener(sessionId, holdRuntimeTurn(target, sessionId, events))
          );
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
