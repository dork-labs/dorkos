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
  followLateTurns,
  resetLateTurnFollowers,
  type LateTurn,
} from '../late-turns.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

async function* turn(sessionId: string, ...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event;
  yield { type: 'done', data: { sessionId } } as StreamEvent;
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
});
