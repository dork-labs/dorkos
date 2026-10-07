import { expect, it, onTestFinished, vi } from 'vitest';
import {
  ownPrivateProxyAuthentication,
  joinOriginalProxyAuthenticationStop,
} from '../private-proxy-auth.js';

async function fixture(holdAttach = false, holdWorker = false) {
  let entered!: () => void;
  const pendingEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const failed = vi.fn();
  const bank: {
    socket?: OriginalSocket;
    owner?: Awaited<ReturnType<typeof ownPrivateProxyAuthentication>>;
  } = {};
  class OriginalSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    heldId?: number;
    closeFailure?: { value: unknown };
    holdTerminal = false;
    readonly sent: { id: number; method: string; sessionId?: string }[] = [];
    close = vi.fn(() => {
      if (this.closeFailure) throw this.closeFailure.value;
      if (!this.holdTerminal) this.end();
    });
    constructor(_endpoint: string) {
      super();
      bank.socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    emit(value: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
    send(encoded: string) {
      const value = JSON.parse(encoded) as { id: number; method: string; sessionId?: string };
      this.sent.push(value);
      if (
        (holdWorker &&
          value.method === 'Target.setAutoAttach' &&
          value.sessionId === 'original-worker') ||
        (!holdWorker && value.method === (holdAttach ? 'Fetch.enable' : 'Fetch.continueRequest'))
      ) {
        this.heldId = value.id;
        entered();
      } else queueMicrotask(() => this.emit({ id: value.id, result: {} }));
    }
    release(refused = false) {
      if (this.heldId === undefined) return;
      const id = this.heldId;
      this.heldId = undefined;
      this.emit(refused ? { id, error: { code: -1 } } : { id, result: {} });
    }
    end() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('WebSocket', OriginalSocket);
  // Restore/release independently even if an early assertion fails.
  onTestFinished(async () => {
    bank.socket?.release();
    const closing = bank.owner?.close();
    bank.socket?.end();
    await closing?.catch(() => {});
    vi.unstubAllGlobals();
  });
  const owner = await ownPrivateProxyAuthentication(
    'ws://127.0.0.1:9003/devtools/browser/original',
    { url: 'http://127.0.0.1:9002', credentials: { username: 'dorkos', password: 'fixture' } },
    failed
  );
  bank.owner = owner;
  const socket = bank.socket!;
  socket.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'original-session', targetInfo: { type: 'page' } },
  });
  if (!holdAttach) {
    // The actual original attach chain ACKs each fixed command before the paused request.
    await vi.waitFor(() =>
      expect(socket.sent.some((value) => value.method === 'Runtime.runIfWaitingForDebugger')).toBe(
        true
      )
    );
    await Promise.resolve();
    if (holdWorker)
      socket.emit({
        method: 'Target.attachedToTarget',
        sessionId: 'original-session',
        params: { sessionId: 'original-worker', targetInfo: { type: 'worker' } },
      });
    else
      socket.emit({
        method: 'Fetch.requestPaused',
        sessionId: 'original-session',
        params: { requestId: 'original-request' },
      });
    await pendingEntered;
  } else await pendingEntered;
  return { socket, owner, failed };
}

it('fences new producers while consuming the held original ACK before socket close', async () => {
  const f = await fixture();
  const closing = f.owner.close();
  let returned = false;
  void closing.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    }
  );
  await Promise.resolve();
  expect(f.owner.isCustodyKnown()).toBe(false);
  expect(f.socket.close).not.toHaveBeenCalled();
  expect(returned).toBe(false);
  const sent = f.socket.sent.length;
  f.socket.emit({
    method: 'Fetch.requestPaused',
    sessionId: 'original-session',
    params: { requestId: 'unentered-request' },
  });
  expect(f.socket.sent).toHaveLength(sent);
  f.socket.release();
  await closing;
  expect(f.socket.close).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
  expect(f.owner.close()).toBe(closing);
});

it('still closes the original socket after a genuine retained command refusal', async () => {
  const f = await fixture();
  const closing = f.owner.close();
  void closing.catch(() => {});
  f.socket.release(true);
  await expect(closing).rejects.toThrow('PROXY_AUTH_METHOD_REFUSED');
  expect(f.socket.close).toHaveBeenCalledOnce();
  expect(f.failed).toHaveBeenCalledOnce();
});

it.each([false, undefined])(
  'joins independent original terminal after close throws %s',
  async (cause) => {
    const f = await fixture();
    f.socket.closeFailure = { value: cause };
    const closing = f.owner.close();
    void closing.catch(() => {});
    f.socket.release();
    await vi.waitFor(() => expect(f.socket.close).toHaveBeenCalledOnce());
    let returned = false;
    void closing.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      }
    );
    await Promise.resolve();
    expect(returned).toBe(false);
    f.socket.end();
    await expect(closing).rejects.toBe(cause);
  }
);

it('refuses an unexpected peer close while an original command is outstanding', async () => {
  const f = await fixture();
  f.socket.end();
  const closing = f.owner.close();
  await expect(closing).rejects.toThrow('PROXY_AUTH_CHANNEL_CLOSED');
  expect(f.socket.close).toHaveBeenCalledOnce();
  expect(f.failed).toHaveBeenCalledOnce();
});

it('joins held original authentication ACK before independent browser stop enters', async () => {
  const f = await fixture();
  const stop = vi.fn(async () => {
    f.socket.end();
  });
  const authClosed = f.owner.close();
  void authClosed.catch(() => {});
  const closing = joinOriginalProxyAuthenticationStop(f.owner.prepareClose(), stop);
  await Promise.resolve();
  expect(stop).not.toHaveBeenCalled();
  f.socket.release();
  await closing;
  await authClosed;
  expect(stop).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  'enters independent browser stop after auth entry throws %s before terminal returns',
  async (cause) => {
    const f = await fixture();
    f.socket.closeFailure = { value: cause };
    // The browser stop is the sole terminal producer. No external release can hide a cycle.
    const stop = vi.fn(async () => {
      f.socket.end();
    });
    const authClosed = f.owner.close();
    void authClosed.catch(() => {});
    const closing = joinOriginalProxyAuthenticationStop(f.owner.prepareClose(), stop);
    void closing.catch(() => {});
    f.socket.release();
    await expect(closing).rejects.toBe(cause);
    await expect(authClosed).rejects.toBe(cause);
    expect(stop).toHaveBeenCalledOnce();
    expect(f.socket.close).toHaveBeenCalledOnce();
  }
);

it('finishes the exact entered attach continuation after its held Fetch ACK without admitting another target', async () => {
  const f = await fixture(true);
  const closing = f.owner.close();
  await Promise.resolve();
  expect(f.socket.close).not.toHaveBeenCalled();
  f.socket.emit({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'new-unentered-session', targetInfo: { type: 'page' } },
  });
  f.socket.emit({
    method: 'Fetch.authRequired',
    sessionId: 'original-session',
    params: {
      requestId: 'new-unentered-auth',
      authChallenge: { source: 'Proxy', origin: 'http://127.0.0.1:9002' },
    },
  });
  f.socket.release();
  await closing;
  expect(f.socket.sent.map((value) => value.method)).toEqual([
    'Target.setAutoAttach',
    'Fetch.enable',
    'Target.setAutoAttach',
    'Runtime.runIfWaitingForDebugger',
  ]);
  expect(f.socket.close).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});

it('publishes memoized close before the original socket close can reenter', async () => {
  const f = await fixture();
  const originalClose = f.socket.close.getMockImplementation()!;
  const closing = f.owner.close();
  f.socket.close.mockImplementation(() => {
    expect(f.owner.close()).toBe(closing);
    return originalClose();
  });
  f.socket.release();
  await closing;
  expect(f.socket.close).toHaveBeenCalledOnce();
});

it('revokes an entered worker continuation when its original parent detaches during retirement', async () => {
  const f = await fixture(false, true);
  const closing = f.owner.close();
  void closing.catch(() => {});
  await Promise.resolve();
  expect(f.socket.close).not.toHaveBeenCalled();
  f.socket.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'original-session' } });
  f.socket.release();
  await expect(closing).rejects.toThrow('PROXY_AUTH_WORKER_PARENT_UNAVAILABLE');
  expect(
    f.socket.sent.some(
      (value) =>
        value.sessionId === 'original-worker' && value.method === 'Runtime.runIfWaitingForDebugger'
    )
  ).toBe(false);
  expect(f.failed).toHaveBeenCalledOnce();
  expect(f.owner.isCustodyKnown()).toBe(false);
  expect(f.socket.close).toHaveBeenCalledOnce();
});
