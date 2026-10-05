/**
 * The turn chokepoint: every way a turn can end releases its hold, and nothing
 * about counting can change what a turn produces.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { holdAwakeDuringTurns } from '../hold-during-turn.js';
import { KeepAwakeService, keepAwakeService } from '../keep-awake-service.js';
import { RuntimeRegistry } from '../../runtime-registry.js';

const EVENT: StreamEvent = { type: 'text_delta', data: { text: 'hi' } } as StreamEvent;

/** A runtime whose turns run `impl`. Only what the wrapper touches is real. */
function runtimeWith(
  impl: (sessionId: string, opts?: MessageOpts) => AsyncGenerator<StreamEvent>,
  type = 'fake-keep-awake'
): AgentRuntime {
  return {
    type,
    sendMessage: (sessionId: string, _content: string, opts?: MessageOpts) => impl(sessionId, opts),
    isHelperWorking: () => false,
  } as unknown as AgentRuntime;
}

async function* events(n: number): AsyncGenerator<StreamEvent> {
  for (let i = 0; i < n; i++) yield EVENT;
}

const working = (service: KeepAwakeService) => service.status().working;

describe('holdAwakeDuringTurns', () => {
  it('opens the hold on the first next(), not when the turn is created', async () => {
    // Purpose: a stream nobody consumes holds nothing and leaks nothing.
    const service = new KeepAwakeService();
    const runtime = holdAwakeDuringTurns(
      runtimeWith(() => events(1)),
      service
    );

    const stream = runtime.sendMessage('s1', 'hello');
    expect(working(service).chats).toBe(0);

    await stream.next();
    expect(working(service).chats).toBe(1);
    await stream.next();
    expect(working(service).chats).toBe(0);
  });

  it('releases when the turn completes', async () => {
    const service = new KeepAwakeService();
    const runtime = holdAwakeDuringTurns(
      runtimeWith(() => events(3)),
      service
    );
    const seen: StreamEvent[] = [];
    for await (const event of runtime.sendMessage('s1', 'hello')) {
      expect(working(service).chats).toBe(1);
      seen.push(event);
    }
    expect(seen).toHaveLength(3);
    expect(working(service).chats).toBe(0);
  });

  it('releases when the runtime throws, and the error still reaches the caller', async () => {
    const service = new KeepAwakeService();
    const runtime = holdAwakeDuringTurns(
      runtimeWith(async function* () {
        yield EVENT;
        throw new Error('runtime boom');
      }),
      service
    );
    await expect(async () => {
      for await (const _event of runtime.sendMessage('s1', 'hello')) {
        // drain
      }
    }).rejects.toThrow('runtime boom');
    expect(working(service).chats).toBe(0);
  });

  it('releases when the consumer breaks out (return()), and ends the runtime stream too', async () => {
    const service = new KeepAwakeService();
    const finished = vi.fn();
    const runtime = holdAwakeDuringTurns(
      runtimeWith(async function* () {
        try {
          yield EVENT;
          yield EVENT;
        } finally {
          finished();
        }
      }),
      service
    );
    for await (const _event of runtime.sendMessage('s1', 'hello')) {
      break;
    }
    expect(finished).toHaveBeenCalledOnce();
    expect(working(service).chats).toBe(0);
  });

  it('releases when an interrupt ends the runtime stream early', async () => {
    const service = new KeepAwakeService();
    const controller = new AbortController();
    const runtime = holdAwakeDuringTurns(
      runtimeWith(async function* () {
        yield EVENT;
        // What an interrupt does to a runtime's generator: it returns early.
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener('abort', () => resolve());
        });
      }),
      service
    );
    const drained = (async () => {
      for await (const _event of runtime.sendMessage('s1', 'hello')) {
        // drain
      }
    })();
    await vi.waitFor(() => expect(working(service).chats).toBe(1));
    controller.abort();
    await drained;
    expect(working(service).chats).toBe(0);
  });

  it('counts a turn sent with roomTurn as a room, not a chat', async () => {
    const service = new KeepAwakeService();
    const runtime = holdAwakeDuringTurns(
      runtimeWith(() => events(1)),
      service
    );
    const stream = runtime.sendMessage('s1', 'hello', {
      roomTurn: { roomId: 'r1' },
    } as unknown as MessageOpts);
    await stream.next();
    expect(working(service)).toMatchObject({ chats: 0, rooms: 1 });
    await stream.return(undefined);
    expect(working(service)).toMatchObject({ chats: 0, rooms: 0 });
  });

  it('never lets a throwing service break the turn: every event still flows', async () => {
    const broken = {
      holdTurn: () => {
        throw new Error('service boom');
      },
    } as unknown as KeepAwakeService;
    const runtime = holdAwakeDuringTurns(
      runtimeWith(() => events(2)),
      broken
    );
    const seen: StreamEvent[] = [];
    for await (const event of runtime.sendMessage('s1', 'hello')) seen.push(event);
    expect(seen).toHaveLength(2);
  });

  it('passes every other member through to the real runtime', () => {
    const service = new KeepAwakeService();
    const real = runtimeWith(() => events(0));
    const wrapped = holdAwakeDuringTurns(real, service);
    expect(wrapped.type).toBe('fake-keep-awake');
    expect(wrapped.isHelperWorking?.('s1')).toBe(false);
  });
});

describe('the registry seam', () => {
  it('holds a turn on any runtime resolved from runtimeRegistry, exactly once', async () => {
    // Purpose: register() is the one seam every caller (composer, room reply,
    // scheduled run, relay delivery) resolves through, so a runtime fetched
    // from it must count its turn — once, not once per wrapper layer.
    const registry = new RuntimeRegistry();
    registry.register(runtimeWith(() => events(2), 'fake-registry-keep-awake'));
    const before = working(keepAwakeService).chats;

    const stream = registry.get('fake-registry-keep-awake').sendMessage('s-reg', 'hello');
    await stream.next();
    expect(working(keepAwakeService).chats).toBe(before + 1);

    for await (const _event of stream) {
      // drain
    }
    expect(working(keepAwakeService).chats).toBe(before);
  });
});
