/**
 * The work an agent finishes in a turn of its own reaches whoever asked for it
 * (DOR-2717).
 *
 * Driven through the real runtime-turn projection: the fake runtime announces a
 * turn nobody dispatched, exactly as a warm Claude Code process does when a
 * background helper reports, and these read what a follower is handed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { resetMessageDispatcher } from '../../message-dispatcher.js';
import { getOrCreateProjector } from '../../session-state-projector.js';
import { subscribeRuntimeTurns } from '../runtime-turn.js';
import {
  createLateTurnSource,
  dispatchedTurnMark,
  followLateTurns,
  resetLateTurnFollowers,
  type LateFollowEnd,
  type LateTurn,
} from '../late-turns.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

async function* turn(sessionId: string, ...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event;
  yield { type: 'done', data: { sessionId } } as StreamEvent;
}

/** Run one dispatched turn to its end, as any caller's message does. */
async function dispatchTurn(runtime: FakeAgentRuntime, sessionId: string): Promise<void> {
  for await (const _event of runtime.sendMessage(sessionId, 'a message somebody sent')) {
    // drained
  }
}

const say = (text: string): StreamEvent => ({ type: 'text_delta', data: { text } }) as StreamEvent;

let counter = 0;

describe('following the turns an agent starts after the work it was given', () => {
  let runtime: FakeAgentRuntime;
  let sessionId: string;
  let unsubscribe: (() => void) | undefined;
  let heard: LateTurn[];

  beforeEach(() => {
    resetMessageDispatcher();
    counter += 1;
    sessionId = `late-turns-${counter}`;
    runtime = new FakeAgentRuntime();
    getOrCreateProjector(sessionId);
    unsubscribe = subscribeRuntimeTurns(runtime);
    heard = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    unsubscribe?.();
    resetLateTurnFollowers();
    resetMessageDispatcher();
  });

  it('hands over what the agent said, and whether more is coming', async () => {
    runtime.holdsBackgroundWork.mockReturnValue(true);
    followLateTurns({
      owner: 'test',
      runtime,
      sessionId,
      windowMs: 60_000,
      onTurn: (t) => heard.push(t),
    });

    runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Half '), say('done.')));
    await flush();
    runtime.holdsBackgroundWork.mockReturnValue(false);
    runtime.emitRuntimeTurn(
      sessionId,
      turn(sessionId, say('Tests failed.'), {
        type: 'error',
        data: { message: 'the build broke' },
      } as StreamEvent)
    );
    await flush();
    // The agent held nothing after that, so the follow is over.
    runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Unrelated.')));
    await flush();

    expect(heard).toEqual([
      { text: 'Half done.', continuing: true },
      { text: 'Tests failed.', error: 'the build broke', continuing: false },
    ]);
  });

  it('recognises the session under the id the runtime renamed it to', async () => {
    runtime.getInternalSessionId.mockImplementation((id) =>
      id === 'request-id' || id === sessionId ? sessionId : undefined
    );
    followLateTurns({
      owner: 'test',
      runtime,
      sessionId: 'request-id',
      windowMs: 60_000,
      onTurn: (t) => heard.push(t),
    });

    runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Report.')));
    await flush();

    expect(heard.map((t) => t.text)).toEqual(['Report.']);
  });

  it('hands a later turn to the newest follower of the session, not to both', async () => {
    runtime.holdsBackgroundWork.mockReturnValue(true);
    const older: LateTurn[] = [];
    followLateTurns({
      owner: 'test',
      runtime,
      sessionId,
      windowMs: 60_000,
      onTurn: (t) => older.push(t),
    });
    followLateTurns({
      owner: 'test',
      runtime,
      sessionId,
      windowMs: 60_000,
      onTurn: (t) => heard.push(t),
    });

    runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Report.')));
    await flush();

    expect(older).toEqual([]);
    expect(heard.map((t) => t.text)).toEqual(['Report.']);
  });

  it('stops listening once its window has passed', async () => {
    vi.useFakeTimers();
    runtime.holdsBackgroundWork.mockReturnValue(true);
    followLateTurns({
      owner: 'test',
      runtime,
      sessionId,
      windowMs: 1_000,
      onTurn: (t) => heard.push(t),
    });

    vi.advanceTimersByTime(1_001);
    runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Too late.')));
    await flush();

    expect(heard).toEqual([]);
  });

  it('follows through a source keyed by runtime type, and nothing for an unknown one', async () => {
    const source = createLateTurnSource({
      owner: 'relay-test',
      runtimeFor: (type) => (type === 'fake' ? runtime : undefined),
      windowMs: 60_000,
    });
    source.follow({ runtimeType: 'fake', sessionKey: sessionId, onTurn: (t) => heard.push(t) });
    const nothing = source.follow({ runtimeType: 'gone', sessionKey: sessionId, onTurn: () => {} });

    runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Report.')));
    await flush();

    expect(heard.map((t) => t.text)).toEqual(['Report.']);
    expect(() => nothing()).not.toThrow();
  });

  describe('how a follow ends', () => {
    let ends: LateFollowEnd[];
    beforeEach(() => {
      ends = [];
    });

    function follow(owner = 'test', windowMs = 60_000): void {
      followLateTurns({
        owner,
        runtime,
        sessionId,
        windowMs,
        onTurn: (t) => heard.push(t),
        onEnd: (reason) => ends.push(reason),
      });
    }

    it('says `final` after the turn the agent ends holding nothing', async () => {
      follow();
      runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Done.')));
      await flush();
      expect(heard.map((t) => t.text)).toEqual(['Done.']);
      expect(ends).toEqual(['final']);
    });

    it('says `expired` when the window passes', () => {
      vi.useFakeTimers();
      follow('test', 1_000);
      vi.advanceTimersByTime(1_001);
      expect(ends).toEqual(['expired']);
    });

    it('says `superseded` when a newer follower of the same kind takes the session', () => {
      follow();
      followLateTurns({ owner: 'test', runtime, sessionId, windowMs: 60_000, onTurn: () => {} });
      expect(ends).toEqual(['superseded']);
    });

    it('says `stopped` when its caller ends it', () => {
      const stop = followLateTurns({
        owner: 'test',
        runtime,
        sessionId,
        windowMs: 60_000,
        onTurn: () => {},
        onEnd: (reason) => ends.push(reason),
      });
      stop();
      stop();
      expect(ends).toEqual(['stopped']);
    });
  });

  describe('new work on the session ends every follow of it', () => {
    it('never hands a relay caller the answer to a person`s own message that came after', async () => {
      runtime.holdsBackgroundWork.mockReturnValue(true);
      const ends: LateFollowEnd[] = [];
      createLateTurnSource({ owner: 'relay', runtimeFor: () => runtime, windowMs: 60_000 }).follow({
        runtimeType: 'fake',
        sessionKey: sessionId,
        onTurn: (t) => heard.push(t),
        onEnd: (reason) => ends.push(reason),
      });

      // A person opens the chat and asks something of their own.
      await dispatchTurn(runtime, sessionId);
      // Whatever the agent says on its own from here may be answering them.
      runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Your private answer.')));
      await flush();

      expect(heard).toEqual([]);
      expect(ends).toEqual(['superseded']);
    });

    it('ends the follows of every kind of caller, under any id the session answers to', async () => {
      runtime.getInternalSessionId.mockImplementation((id) =>
        id === 'request-id' || id === sessionId ? sessionId : undefined
      );
      const ends: string[] = [];
      for (const owner of ['relay', 'task-run']) {
        followLateTurns({
          owner,
          runtime,
          sessionId: 'request-id',
          windowMs: 60_000,
          onTurn: (t) => heard.push(t),
          onEnd: (reason) => ends.push(`${owner}:${reason}`),
        });
      }

      await dispatchTurn(runtime, sessionId);

      expect(ends.sort()).toEqual(['relay:superseded', 'task-run:superseded']);
    });

    it('leaves a follow of a different session alone', async () => {
      const ends: LateFollowEnd[] = [];
      followLateTurns({
        owner: 'relay',
        runtime,
        sessionId,
        windowMs: 60_000,
        onTurn: () => {},
        onEnd: (reason) => ends.push(reason),
      });

      await dispatchTurn(runtime, `${sessionId}-other`);

      expect(ends).toEqual([]);
    });

    it('ends a follow at once when work reached the session after the mark it was given', async () => {
      const ends: LateFollowEnd[] = [];
      const mark = dispatchedTurnMark(runtime, sessionId);
      // A person's message lands between the caller's turn ending and its follow.
      await dispatchTurn(runtime, sessionId);
      followLateTurns({
        owner: 'relay',
        runtime,
        sessionId,
        windowMs: 60_000,
        sinceMark: mark,
        onTurn: (t) => heard.push(t),
        onEnd: (reason) => ends.push(reason),
      });
      runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Their helper report.')));
      await flush();

      expect(ends).toEqual(['superseded']);
      expect(heard).toEqual([]);
    });

    it('keeps a follow whose mark is current, under any id the session answers to', async () => {
      runtime.getInternalSessionId.mockImplementation((id) =>
        id === 'request-id' || id === sessionId ? sessionId : undefined
      );
      await dispatchTurn(runtime, 'request-id');
      const source = createLateTurnSource({
        owner: 'relay',
        runtimeFor: () => runtime,
        windowMs: 60_000,
      });
      const mark = source.dispatchMark({ runtimeType: 'fake', sessionKey: sessionId });
      const ends: LateFollowEnd[] = [];
      source.follow({
        runtimeType: 'fake',
        sessionKey: 'request-id',
        sinceMark: mark,
        onTurn: (t) => heard.push(t),
        onEnd: (reason) => ends.push(reason),
      });
      runtime.emitRuntimeTurn(sessionId, turn(sessionId, say('Report.')));
      await flush();

      expect(heard.map((t) => t.text)).toEqual(['Report.']);
      expect(ends).toEqual(['final']);
    });
  });
});
