/**
 * An agent reply with nothing in it says so, on every runtime (DOR-3606).
 *
 * Claude Code always told the person "The agent did not respond" when a turn
 * ended with nothing to show. Codex, OpenCode and Doe did not: the reply just
 * stopped, and the person was left looking at a finished turn with no words in
 * it and no reason. The decision lives in `runtimes/shared/empty-stream-guard.ts`;
 * this decorator applies it once, at the registration seam, so every runtime
 * that can be registered gets it and a new one cannot be built without it.
 *
 * @module services/core/runtime-seam/report-empty-turns
 */
import type { AgentRuntime, LiveSessionRef, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  emptyTurnFailure,
  watchForEmptyTurn,
  type EmptyTurnWatch,
} from '../../runtimes/shared/empty-stream-guard.js';

/**
 * Whether the room this turn answers in owns what its silence means.
 *
 * A room turn speaks by calling the posting tool, and the room decides what a
 * turn that posted nothing should say: nothing at all when nobody asked
 * (`meta/agent-etiquette.md` E7), one "did not reply" line when somebody did.
 * An error here would replace that line with a failure the agent never had.
 *
 * @param opts - The turn's options.
 */
function roomOwnsSilence(opts: MessageOpts | undefined): boolean {
  if (opts?.roomTurn !== undefined) return true;
  return opts?.additionalContext?.some((entry) => entry.kind === 'room_context') === true;
}

/**
 * Pass a send's hold handshake through, noting when the runtime held the turn
 * back. A held turn ends its stream before it starts, and is tried again later.
 *
 * @param opts - The turn's options.
 * @param onHeld - Called when the runtime held the turn and the caller agreed.
 */
function noteHolds(opts: MessageOpts | undefined, onHeld: () => void): MessageOpts | undefined {
  const handshake = opts?.dispatchHold;
  if (handshake === undefined) return opts;
  return {
    ...opts,
    dispatchHold: {
      proceed: () => handshake.proceed(),
      hold: (waitingOn) => {
        const held = handshake.hold(waitingOn);
        if (held) onHeld();
        return held;
      },
    },
  };
}

/**
 * One send, with the empty-turn error added before its first `done` (or at its
 * end, when it has none) if the turn showed nothing.
 *
 * Only the first window is the send's own: a runtime may keep its stream open
 * for work the agent starts on its own afterwards, and that is not a reply to
 * this message.
 */
async function* guardTurn(
  target: AgentRuntime,
  watches: Map<string, EmptyTurnWatch>,
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined
): AsyncGenerator<StreamEvent> {
  if (roomOwnsSilence(opts)) {
    yield* target.sendMessage(sessionId, content, opts);
    return;
  }
  const watch = watchForEmptyTurn();
  let held = false;
  const turnOpts = noteHolds(opts, () => (held = true));
  watches.set(sessionId, watch);
  let ownWindow = true;
  try {
    for await (const event of target.sendMessage(sessionId, content, turnOpts)) {
      if (ownWindow && event.type === 'done') {
        ownWindow = false;
        if (!held && watch.isEmpty()) yield* emptyTurnFailure(sessionId);
      } else if (ownWindow) {
        watch.observe(event);
      }
      yield event;
    }
    if (ownWindow && !held && watch.isEmpty()) yield* emptyTurnFailure(sessionId);
  } finally {
    if (watches.get(sessionId) === watch) watches.delete(sessionId);
  }
}

/**
 * Wrap a runtime so a turn that ends with nothing to show tells the person so.
 *
 * Not empty: a turn that showed text (not just whitespace), thinking, a tool
 * call or result, a picture or a manual compaction; one waiting on a person; one
 * that already reported its own failure (so Claude Code's own error is never
 * doubled); one stopped through this runtime's `interruptQuery` or
 * `endSessionsWhere`, or that names an interrupted ending itself; one the
 * runtime held back before it started; and any room turn.
 *
 * @param runtime - The runtime being registered.
 */
export function reportEmptyTurns(runtime: AgentRuntime): AgentRuntime {
  /** The open turn's watch, by session: `sendMessage` is single-flight per session. */
  const watches = new Map<string, EmptyTurnWatch>();
  const noteStop = (sessionId: string) => watches.get(sessionId)?.noteStop();
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (sessionId: string, content: string, opts?: MessageOpts) =>
          guardTurn(target, watches, sessionId, content, opts);
      }
      if (prop === 'interruptQuery' && typeof target.interruptQuery === 'function') {
        return (sessionId: string) => {
          // Noted before the runtime answers: a turn can end empty while the
          // stop is still being acknowledged, and its silence is the stop.
          noteStop(sessionId);
          return target.interruptQuery(sessionId);
        };
      }
      if (prop === 'endSessionsWhere' && typeof target.endSessionsWhere === 'function') {
        return (belongs: (session: LiveSessionRef) => boolean) =>
          target.endSessionsWhere((session) => {
            const picked = belongs(session);
            if (picked) noteStop(session.sessionId);
            return picked;
          });
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
