/**
 * Keep-awake and the pause hold, wired together the way every registered
 * runtime is: a paused agent's self-started turn and leftover background work
 * keep nothing awake. Fails if `decorateRuntime` stops handing keep-awake the
 * pause probe.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { decorateRuntime } from '../decorate-runtime.js';
import { RuntimeRegistry } from '../../runtime-registry.js';
import { keepAwakeService } from '../../keep-awake/keep-awake-service.js';
import {
  initAgentPause,
  resetAgentPause,
  type AgentPauseService,
} from '../../../mesh/pause/agent-pause.js';
import { isSessionPaused } from '../../../mesh/pause/hold-paused-turns.js';

const EVENT = { type: 'text_delta', data: { text: 'hi' } } as StreamEvent;

async function* events(n: number): AsyncGenerator<StreamEvent> {
  for (let i = 0; i < n; i++) yield EVENT;
}

/** A pause service stub whose one agent is paused while `state.paused` is true. */
function stubPauses(state: { paused: boolean }): AgentPauseService {
  return {
    pausedAgentOfSession: () => (state.paused ? { id: 'agent-1', name: 'Agent' } : undefined),
    recordHeld: () => {},
    stopSession: async () => {},
    trackTurn: () => () => {},
  } as unknown as AgentPauseService;
}

/** A runtime with controllable background work and self-started turns. */
function fakeRuntime(type: string) {
  const state = { background: false };
  let listener: ((sessionId: string, events: AsyncIterable<StreamEvent>) => void) | null = null;
  const runtime = {
    type,
    sendMessage: () => events(1),
    isHelperWorking: () => false,
    acquireLock: () => false,
    releaseLock: () => {},
    holdsBackgroundWork: () => state.background,
    getSessionCwd: () => undefined,
    onRuntimeTurn: (l: (sessionId: string, events: AsyncIterable<StreamEvent>) => void) => {
      listener = l;
      return () => {};
    },
  } as unknown as AgentRuntime;
  return {
    runtime,
    state,
    startTurn: (sessionId: string, turn: AsyncIterable<StreamEvent>) => listener?.(sessionId, turn),
  };
}

const chats = () => keepAwakeService.status().working.chats;

afterEach(() => {
  resetAgentPause();
});

describe('decorateRuntime: keep-awake and a paused agent', () => {
  it('holds nothing for a turn a paused agent starts on its own', async () => {
    const pause = { paused: true };
    initAgentPause(stubPauses(pause));
    const { runtime, startTurn } = fakeRuntime('fake-seam-paused-late');
    const decorated = decorateRuntime(runtime, () => undefined);
    const before = chats();
    const seen: number[] = [];
    let done!: Promise<void>;
    decorated.onRuntimeTurn!((_sessionId, turn) => {
      done = (async () => {
        for await (const _event of turn) seen.push(chats());
      })();
    });

    startTurn('s-paused', events(2));
    await done;
    expect(seen).toEqual([before, before]);
  });

  it('lets go of background work once its agent is paused', async () => {
    const pause = { paused: false };
    initAgentPause(stubPauses(pause));
    const { runtime, state } = fakeRuntime('fake-seam-paused-background');
    const decorated = decorateRuntime(runtime, () => undefined);
    const before = chats();
    state.background = true;

    for await (const _event of decorated.sendMessage('s-bg', 'hello')) {
      // drain
    }
    expect(chats()).toBe(before + 1);

    pause.paused = true;
    keepAwakeService.sweepIdleTurns();
    expect(chats()).toBe(before);
  });
});

describe('isSessionPaused', () => {
  it('reads the pause service, and is false when there is none', () => {
    const { runtime } = fakeRuntime('fake-is-paused');
    expect(isSessionPaused(runtime, 's1')).toBe(false);

    const pause = { paused: false };
    initAgentPause(stubPauses(pause));
    expect(isSessionPaused(runtime, 's1')).toBe(false);
    pause.paused = true;
    expect(isSessionPaused(runtime, 's1')).toBe(true);
  });
});

describe('RuntimeRegistry: the actual registration seam', () => {
  it('releases registered runtime background work when its agent is paused', async () => {
    const pause = { paused: false };
    initAgentPause(stubPauses(pause));
    const { runtime, state } = fakeRuntime('fake-registry-paused-background');
    const registry = new RuntimeRegistry();
    registry.register(runtime);
    const registered = registry.get(runtime.type);
    const before = chats();
    state.background = true;
    try {
      for await (const _event of registered.sendMessage('s-registry-bg', 'hello')) {
        // drain the genuine registered decorator chain
      }
      expect(chats()).toBe(before + 1);
      pause.paused = true;
      keepAwakeService.sweepIdleTurns();
      expect(chats()).toBe(before);
    } finally {
      state.background = false;
      keepAwakeService.sweepIdleTurns();
    }
  });

  it('does not hold a paused agent self-started turn through the registered chain', async () => {
    const pause = { paused: true };
    initAgentPause(stubPauses(pause));
    const { runtime, startTurn } = fakeRuntime('fake-registry-paused-late');
    const registry = new RuntimeRegistry();
    registry.register(runtime);
    const before = chats();
    const seen: number[] = [];
    let done!: Promise<void>;
    registry.get(runtime.type).onRuntimeTurn!((_sessionId, turn) => {
      done = (async () => {
        for await (const _event of turn) seen.push(chats());
      })();
    });
    startTurn('s-registry-paused', events(2));
    await done;
    expect(seen).toEqual([before, before]);
  });
});
