import { expect, it, vi } from 'vitest';
import { observeOriginalSDKWorkerSessions } from './original-worker-session-observer.fixture.js';
import type { createControllerProxyAuthentication } from '../../../../../../../../packages/browser/src/runtime/identity/controller-proxy-authentication.js';
type Transport = Parameters<typeof createControllerProxyAuthentication>[0];
function fixture(parent?: string) {
  const wire: Transport = { send: vi.fn(), close: vi.fn() };
  const owner = observeOriginalSDKWorkerSessions(wire, 'default', () => {});
  const forwarded = vi.fn();
  owner.transport.onmessage = forwarded;
  const emit = (packet: object) => wire.onmessage!(packet);
  const attach = (context = 'default') =>
    emit({
      method: 'Target.attachedToTarget',
      ...(parent === undefined ? {} : { sessionId: parent }),
      params: {
        sessionId: 'sdk-worker',
        targetInfo: {
          targetId: 'worker-target',
          type: 'service_worker',
          browserContextId: context,
          url: 'https://owned.test/background-worker/test.js',
        },
      },
    });
  const command = () => {
    const packet = vi.mocked(wire.send).mock.calls.at(-1)![0];
    if (
      !packet ||
      typeof packet !== 'object' ||
      Array.isArray(packet) ||
      !('id' in packet) ||
      typeof packet.id !== 'number'
    )
      throw new Error('ORIGINAL_COMMAND_REQUIRED');
    return packet;
  };
  return { wire, owner, emit, attach, forwarded, command, parent };
}
it.each([undefined, 'original-parent'])(
  'requires original same-parent detach ACK and matching event %s',
  async (parent) => {
    const f = fixture(parent);
    f.attach();
    const work = f.owner.detach(f.owner.sessions()[0]!);
    void work.catch(() => {});
    let returned = false;
    void work.then(
      () => {
        returned = true;
      },
      () => {}
    );
    try {
      await vi.waitFor(() => expect(f.wire.send).toHaveBeenCalledOnce());
      const packet = f.command();
      expect(packet).toEqual({
        id: -2_147_482_624,
        method: 'Target.detachFromTarget',
        params: { sessionId: 'sdk-worker' },
        ...(parent === undefined ? {} : { sessionId: parent }),
      });
      expect(Object.hasOwn(packet, 'sessionId')).toBe(parent !== undefined);
      f.emit({
        method: 'Target.detachedFromTarget',
        params: { sessionId: 'foreign' },
        ...(parent === undefined ? {} : { sessionId: parent }),
      });
      expect(returned).toBe(false);
      f.emit({
        method: 'Target.detachedFromTarget',
        params: { sessionId: 'sdk-worker' },
        ...(parent === undefined ? {} : { sessionId: parent }),
      });
      expect(returned).toBe(false);
      const ack = {
        id: packet.id,
        result: {},
        ...(parent === undefined ? {} : { sessionId: parent }),
      };
      f.emit(ack);
      await work;
      expect(returned).toBe(true);
      expect(f.forwarded).not.toHaveBeenCalledWith(ack);
    } finally {
      await f.owner.close();
      await work.catch(() => {});
    }
  }
);
it('foreign context and forged session cannot initiate a detach producer', async () => {
  const f = fixture();
  f.attach('foreign');
  expect(f.owner.sessions()).toEqual([]);
  try {
    await expect(
      f.owner.detach({
        context: 'default',
        target: 'worker-target',
        session: 'sdk-worker',
        url: 'https://owned.test/background-worker/test.js',
        parent: undefined,
      })
    ).rejects.toThrow('ORIGINAL_SDK_WORKER_SESSION_REQUIRED');
    expect(f.wire.send).not.toHaveBeenCalled();
  } finally {
    await f.owner.close();
  }
});
it('close fences the entered ACK and detach event while joining the retained command task', async () => {
  const f = fixture();
  f.attach();
  const work = f.owner.detach(f.owner.sessions()[0]!);
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.wire.send).toHaveBeenCalledOnce());
    await f.owner.close();
    await expect(work).rejects.toThrow('ORIGINAL_WORKER_OBSERVER_CLOSED');
  } finally {
    await f.owner.close();
    await work.catch(() => {});
  }
});
it.each([false, undefined])(
  'retains exact original command producer refusal %s',
  async (reason) => {
    const f = fixture();
    f.attach();
    vi.mocked(f.wire.send).mockImplementationOnce(() => {
      throw reason;
    });
    try {
      await expect(f.owner.detach(f.owner.sessions()[0]!)).rejects.toBe(reason);
    } finally {
      await f.owner.close();
    }
  }
);
it('refuses an ACK from a different parent and joins both retained duties', async () => {
  const f = fixture('original-parent');
  f.attach();
  const work = f.owner.detach(f.owner.sessions()[0]!);
  void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(f.wire.send).toHaveBeenCalledOnce());
    f.emit({ id: f.command().id, sessionId: 'foreign-parent', result: {} });
    await expect(work).rejects.toThrow('ORIGINAL_WORKER_ACK_PARENT_REQUIRED');
  } finally {
    await f.owner.close();
    await work.catch(() => {});
  }
});
it.each([false, undefined])(
  'projection cannot replace original forwarding when a diagnostic getter throws %s',
  async (cause) => {
    const f = fixture();
    const getter = vi.fn(() => {
      throw cause;
    });
    const packet = Object.defineProperty({}, 'params', { get: getter });
    try {
      expect(() => f.emit(packet)).not.toThrow();
      expect(f.forwarded).toHaveBeenCalledOnce();
      // Compare original identity without asking the assertion formatter to read hostile fields.
      expect(f.forwarded.mock.calls[0]?.[0]).toBe(packet);
      expect(getter).toHaveBeenCalledOnce();
      let observed: { value: unknown } | undefined;
      try {
        f.owner.sessions();
      } catch (value) {
        observed = { value };
      }
      expect(observed).toEqual({ value: cause });
    } finally {
      await f.owner.close();
    }
  }
);

it.each([false, undefined])(
  'retains a genuine own error ACK %s without treating it as success',
  async (reason) => {
    const f = fixture();
    f.attach();
    const work = f.owner.detach(f.owner.sessions()[0]!);
    void work.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.wire.send).toHaveBeenCalledOnce());
      f.emit({ id: f.command().id, error: reason });
      await expect(work).rejects.toBe(reason);
    } finally {
      await f.owner.close();
      await work.catch(() => {});
    }
  }
);
it.each([null, undefined])(
  'an explicit invalid root ACK session %s cannot substitute absence',
  async (sessionId) => {
    const f = fixture();
    f.attach();
    const work = f.owner.detach(f.owner.sessions()[0]!);
    void work.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.wire.send).toHaveBeenCalledOnce());
      f.emit({ id: f.command().id, sessionId, result: {} });
      await expect(work).rejects.toThrow('ORIGINAL_WORKER_ACK_PARENT_REQUIRED');
    } finally {
      await f.owner.close();
      await work.catch(() => {});
    }
  }
);

it('reserves only the bounded int32 private range before any detach admission', async () => {
  const f = fixture();
  try {
    for (const id of [-2_147_482_624, -2_147_482_593]) {
      expect(() => f.owner.transport.send({ id, method: 'Runtime.enable' })).toThrow(
        'ORIGINAL_WORKER_COMMAND_ID_COLLISION'
      );
    }
    for (const id of [1, -1, -128, -2_147_482_625, -2_147_482_592])
      f.owner.transport.send({ id, method: 'Runtime.enable' });
    expect(f.wire.send).toHaveBeenCalledTimes(5);
    expect(f.wire.send).toHaveBeenNthCalledWith(2, { id: -1, method: 'Runtime.enable' });
  } finally {
    await f.owner.close();
  }
});
