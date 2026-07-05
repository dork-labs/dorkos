import { describe, it, expect, vi } from 'vitest';
import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type {
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { SessionLockedError } from '@dorkos/shared/types';

import { DirectTransport, type DirectTransportServices } from '../direct-transport';

const STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
  lastError: null,
};

const SNAPSHOT: SessionSnapshot = {
  messages: [],
  inProgressTurn: null,
  status: STATUS,
  pendingInteractions: [],
  cursor: 3,
};

const TURN_START: SessionEvent = { type: 'turn_start', seq: 4 };
const LIST_EVENT: SessionListEvent = { type: 'session_removed', sessionId: 'sess-x' };

/** Build a DirectTransport with only the stream/trigger seams faked. */
function setup() {
  const runtime = {
    getSessionSnapshot: vi.fn(async (_ctx: SessionOpts, _id: string) => SNAPSHOT),
    subscribeSession: vi.fn(async function* (): AsyncGenerator<SessionEvent> {
      yield TURN_START;
    }),
    subscribeSessionList: vi.fn(async function* (): AsyncGenerator<SessionListEvent> {
      yield LIST_EVENT;
    }),
  };
  const turnTrigger = {
    trigger: vi.fn(
      async (): Promise<{ accepted: boolean; canonicalId?: string }> => ({
        accepted: true,
        canonicalId: 'sdk-canonical',
      })
    ),
  };
  const services = {
    runtime,
    turnTrigger,
    vaultRoot: '/vault',
  } as unknown as DirectTransportServices;
  return { transport: new DirectTransport(services), runtime, turnTrigger };
}

describe('DirectTransport stream seam', () => {
  it('delegates getSessionSnapshot to the runtime with a vault-rooted ctx', async () => {
    // Real failure mode: embedded hydration reading the wrong project dir
    // (or throwing, as the pre-wiring stub did) blanks the Obsidian chat.
    const { transport, runtime } = setup();

    const snapshot = await transport.getSessionSnapshot('sess-a');

    expect(snapshot).toEqual(SNAPSHOT);
    expect(runtime.getSessionSnapshot).toHaveBeenCalledWith(
      { cwd: '/vault', permissionMode: 'default' },
      'sess-a'
    );
  });

  it('passes an explicit cwd through to the runtime ctx', async () => {
    const { transport, runtime } = setup();

    await transport.getSessionSnapshot('sess-a', '/elsewhere');

    expect(runtime.getSessionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/elsewhere' }),
      'sess-a'
    );
  });

  it('iterates subscribeSession in-process, forwarding cursor and signal', async () => {
    const { transport, runtime } = setup();
    const controller = new AbortController();

    const events: SessionEvent[] = [];
    for await (const event of transport.subscribeSession('sess-a', 3, '/proj', controller.signal))
      events.push(event);

    expect(events).toEqual([TURN_START]);
    expect(runtime.subscribeSession).toHaveBeenCalledWith(
      { cwd: '/proj', permissionMode: 'default' },
      'sess-a',
      3,
      controller.signal
    );
  });

  it('iterates the global session-list stream in-process', async () => {
    const { transport, runtime } = setup();

    const events: SessionListEvent[] = [];
    for await (const event of transport.subscribeSessionList()) events.push(event);

    expect(events).toEqual([LIST_EVENT]);
    expect(runtime.subscribeSessionList).toHaveBeenCalledWith({
      cwd: '/vault',
      permissionMode: 'default',
    });
  });

  it('returns the runtime iterables DIRECTLY — no delegating generator wrapper', () => {
    // Real failure mode (review finding): an `async *`/`yield*` wrapper
    // serializes iterator.return() behind a parked next(), so tearing down the
    // list stream (which has no abort signal) would hang forever and leak the
    // runtime's directory watcher. Identity is the strongest no-wrapper proof.
    const { transport, runtime } = setup();

    const listIterable = transport.subscribeSessionList();
    expect(runtime.subscribeSessionList).toHaveReturnedWith(listIterable);

    const sessionIterable = transport.subscribeSession('sess-a');
    expect(runtime.subscribeSession).toHaveReturnedWith(sessionIterable);
  });
});

describe('DirectTransport.postMessage', () => {
  it('triggers a detached turn and resolves the canonical session id', async () => {
    // Real failure mode: this method THREW before wiring — every Obsidian
    // send errored. The trigger-only contract must mirror the HTTP 202.
    const { transport, turnTrigger } = setup();

    const result = await transport.postMessage('sess-a', 'hello', '/proj');

    expect(result).toEqual({ sessionId: 'sdk-canonical' });
    expect(turnTrigger.trigger).toHaveBeenCalledWith({
      sessionId: 'sess-a',
      clientId: transport.clientId,
      content: 'hello',
      cwd: '/proj',
      context: undefined,
    });
  });

  it('forwards the neutral context bag and leaves content pristine', async () => {
    const { transport, turnTrigger } = setup();

    await transport.postMessage('sess-a', 'hello', '/proj', { context: { queued: true } });

    // content is forwarded byte-for-byte (never mutated) and the queue signal
    // rides the neutral `context` bag.
    expect(turnTrigger.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hello', context: { queued: true } })
    );
  });

  it('defaults the cwd to the vault root', async () => {
    const { transport, turnTrigger } = setup();

    await transport.postMessage('sess-a', 'hello');

    expect(turnTrigger.trigger).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/vault' }));
  });

  it('falls back to the request id when no canonical id resolves', async () => {
    const { transport, turnTrigger } = setup();
    turnTrigger.trigger.mockResolvedValue({ accepted: true });

    await expect(transport.postMessage('sess-a', 'hello')).resolves.toEqual({
      sessionId: 'sess-a',
    });
  });

  it('throws a typed SESSION_LOCKED error when the lock is held', async () => {
    // Real failure mode: callers branch on `code === 'SESSION_LOCKED'` to
    // restore composer input — a generic error would drop the draft.
    const { transport, turnTrigger } = setup();
    turnTrigger.trigger.mockResolvedValue({ accepted: false });

    const error = await transport.postMessage('sess-a', 'hello').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & SessionLockedError).code).toBe('SESSION_LOCKED');
  });
});
