import { expect, it, vi } from 'vitest';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { createControllerProxyAuthentication } from '../controller-proxy-authentication.js';

const message = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function fixture(emptyCatalog = false, diagnosticWrite: (value: string) => unknown = vi.fn()) {
  const sent: Array<Record<string, unknown>> = [];
  const returned = deferred();
  let closing: Promise<void> | undefined;
  const original: ConnectOverCDPTransport = {
    open: vi.fn(),
    send: vi.fn((value) => {
      if (!message(value)) throw new Error('CONTROL_MESSAGE_INVALID');
      sent.push(value);
    }),
    close: vi.fn(
      () =>
        (closing ??= Promise.resolve().then(async () => {
          await returned.promise;
          original.onclose?.();
        }))
    ),
  };
  const fault = vi.fn<(value: unknown) => void>();
  let current = true;
  const currentRead = vi.fn(() => current);
  const owner = createControllerProxyAuthentication(
    original,
    {
      url: 'http://127.0.0.1:32199',
      credentials: { username: 'dorkos', password: 'a'.repeat(43) },
    },
    currentRead,
    fault,
    Object.freeze({
      context: 'original-default-context',
      targets: Object.freeze(
        emptyCatalog
          ? []
          : [
              Object.freeze({
                id: 'actual-target',
                type: 'page',
                context: 'original-default-context',
              }),
            ]
      ),
    }),
    diagnosticWrite
  );
  const sdk = vi.fn();
  owner.transport.onmessage = sdk;
  const attach = (session = 'actual-page') =>
    original.onmessage?.({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: session,
        targetInfo: {
          targetId: 'actual-target',
          type: 'page',
          browserContextId: 'original-default-context',
        },
      },
    });
  const challenge = (
    session = 'actual-page',
    requestId = 'original-request',
    source = 'Proxy',
    origin = 'http://127.0.0.1:32199'
  ) =>
    original.onmessage?.({
      method: 'Fetch.authRequired',
      sessionId: session,
      params: { requestId, authChallenge: { source, origin } },
    });
  const ack = (message = sent.at(-1)!, error?: Readonly<{ value: unknown }>) =>
    original.onmessage?.({
      id: message.id,
      sessionId: message.sessionId,
      ...(error ? { error: error.value } : { result: {} }),
    });
  const finish = async () => {
    returned.resolve();
    try {
      await owner.close();
    } catch {
      /* Each refusing test asserts its exact original cause. */
    }
  };
  return {
    original,
    owner,
    sent,
    sdk,
    fault,
    currentRead,
    attach,
    challenge,
    ack,
    finish,
    returned,
    revoke: () => {
      current = false;
    },
  };
}

it('leaves original SDK routing commands, pauses and positive replies untouched', async () => {
  const f = fixture();
  try {
    f.attach();
    f.sdk.mockClear();
    const enable = {
      id: 4,
      method: 'Fetch.enable',
      sessionId: 'actual-page',
      params: { handleAuthRequests: true },
    };
    f.owner.transport.send(enable);
    expect(f.sent[0]).toBe(enable);
    const paused = {
      method: 'Fetch.requestPaused',
      sessionId: 'actual-page',
      params: { requestId: 'original-request' },
    };
    const reply = { id: 4, sessionId: 'actual-page', result: {} };
    f.original.onmessage?.(paused);
    f.original.onmessage?.(reply);
    expect(f.sdk.mock.calls.map(([value]) => value)).toEqual([paused, reply]);
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.finish();
  }
});

it('consumes exact original proxy challenge before SDK default, and cancels repeat/upstream/origin mismatch', async () => {
  const f = fixture();
  try {
    f.attach();
    f.sdk.mockClear();
    f.challenge();
    expect(f.sent[0]).toMatchObject({
      id: -1,
      sessionId: 'actual-page',
      method: 'Fetch.continueWithAuth',
      params: {
        requestId: 'original-request',
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: 'dorkos',
          password: 'a'.repeat(43),
        },
      },
    });
    f.ack();
    for (const action of [
      () => f.challenge(),
      () => f.challenge('actual-page', 'server', 'Server'),
      () => f.challenge('actual-page', 'wrong-origin', 'Proxy', 'http://127.0.0.1:32200'),
    ]) {
      action();
      expect(f.sent.at(-1)).toMatchObject({
        params: { authChallengeResponse: { response: 'CancelAuth' } },
      });
      expect(JSON.stringify(f.sent.at(-1))).not.toContain('a'.repeat(43));
      f.ack();
    }
    expect(f.sdk).not.toHaveBeenCalled();
    expect(f.fault).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});

it('refuses unowned, detached, foreign-context and nested-unowned sessions without credentials', async () => {
  const f = fixture();
  try {
    f.attach();
    f.original.onmessage?.({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'actual-page' },
    });
    f.original.onmessage?.({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'foreign',
        targetInfo: { targetId: 'foreign-target', type: 'page', browserContextId: 'other-context' },
      },
    });
    f.original.onmessage?.({
      method: 'Target.attachedToTarget',
      sessionId: 'not-owned',
      params: {
        sessionId: 'nested',
        targetInfo: {
          targetId: 'worker-target',
          type: 'worker',
          browserContextId: 'original-default-context',
        },
      },
    });
    for (const session of ['unattached', 'actual-page', 'foreign', 'nested']) {
      f.challenge(session, session);
      expect(f.sent.at(-1)).toMatchObject({
        params: { authChallengeResponse: { response: 'CancelAuth' } },
      });
      f.ack();
    }
    expect(JSON.stringify(f.sent)).not.toContain('a'.repeat(43));
  } finally {
    await f.finish();
  }
});

it('enrolls explicit attach ACK only from retained original target and supports matching attach event', async () => {
  const f = fixture();
  try {
    f.original.onmessage?.({
      method: 'Target.targetCreated',
      params: {
        targetInfo: {
          targetId: 'actual-target',
          type: 'page',
          browserContextId: 'original-default-context',
        },
      },
    });
    f.owner.transport.send({
      id: 9,
      method: 'Target.attachToTarget',
      params: { targetId: 'actual-target', flatten: true },
    });
    f.original.onmessage?.({ id: 9, result: { sessionId: 'actual-page' } });
    f.attach();
    f.challenge();
    expect(f.sent.at(-1)).toMatchObject({
      params: { authChallengeResponse: { response: 'ProvideCredentials' } },
    });
    f.ack();
    expect(f.fault).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});

it('SDK cannot use private IDs, and wrong-session private ACK cannot settle preparation', async () => {
  const f = fixture();
  try {
    expect(() => f.owner.transport.send({ id: -1, method: 'Fetch.continueRequest' })).toThrow(
      'CONTROLLER_AUTH_SDK_ID_REFUSED'
    );
    expect(f.sent).toHaveLength(0);
    f.attach();
    f.challenge();
    const original = f.sent[0]!;
    f.original.onmessage?.({ id: original.id, sessionId: 'foreign', result: {} });
    const outcome = await f.owner.prepareClose().then(
      () => ({ value: undefined }),
      (value) => ({ value })
    );
    expect(outcome.value).toBe(f.fault.mock.calls[0]![0]);
    expect(f.fault).toHaveBeenCalledTimes(1);
    expect(f.owner.isKnown()).toBe(false);
  } finally {
    await f.finish();
  }
});

for (const value of [false, undefined])
  it(`retains original ACK rejection ${String(value)} across reentrant preparation and socket return`, async () => {
    const f = fixture();
    let prepared: Promise<void> | undefined;
    f.fault.mockImplementation(() => {
      prepared = f.owner.prepareClose();
    });
    try {
      f.attach();
      f.challenge();
      f.ack(undefined, { value });
      expect(prepared).toBe(f.owner.prepareClose());
      const rejected = await prepared!.then(
        () => ({ rejected: false }),
        (reason) => ({ rejected: true, reason })
      );
      expect(rejected).toEqual({ rejected: true, reason: value });
      let returned = false;
      const close = f.owner.close();
      void close.then(
        () => {
          returned = true;
        },
        () => {
          returned = true;
        }
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(returned).toBe(false);
      f.returned.resolve();
      expect(
        await close.then(
          () => ({ rejected: false }),
          (reason) => ({ rejected: true, reason })
        )
      ).toEqual({ rejected: true, reason: value });
      expect(f.original.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.finish();
    }
  });

it('retains held original auth ACK before close entry, fences new challenges and joins original wire return', async () => {
  const f = fixture();
  try {
    f.attach();
    f.challenge();
    const original = f.sent[0]!;
    const preparation = f.owner.prepareClose();
    const closing = f.owner.close();
    expect(f.owner.close()).toBe(closing);
    f.challenge('actual-page', 'later');
    await Promise.resolve();
    await Promise.resolve();
    expect(f.sent).toHaveLength(1);
    expect(f.original.close).not.toHaveBeenCalled();
    f.ack(original);
    await preparation;
    let returned = false;
    void closing.then(() => {
      returned = true;
    });
    expect(returned).toBe(false);
    f.returned.resolve();
    await closing;
    expect(f.original.close).toHaveBeenCalledTimes(1);
  } finally {
    await f.finish();
  }
});

for (const reply of [{}, { result: false }])
  it('cannot settle an original auth ACK without its original object result', async () => {
    const f = fixture();
    try {
      f.attach();
      f.challenge();
      const message = f.sent[0]!;
      f.original.onmessage?.({ id: message.id, sessionId: message.sessionId, ...reply });
      const failure = await f.owner.prepareClose().then(
        () => undefined,
        (value) => value
      );
      expect(failure).toBe(f.fault.mock.calls[0]![0]);
      expect(failure).toEqual(new Error('CONTROLLER_AUTH_ACK_INVALID'));
    } finally {
      await f.finish();
    }
  });

it('original target/context substitution revokes enrolled credentials before dispatch', async () => {
  const f = fixture();
  try {
    f.attach();
    f.original.onmessage?.({
      method: 'Target.targetInfoChanged',
      params: {
        targetInfo: {
          targetId: 'actual-target',
          type: 'page',
          browserContextId: 'substituted',
        },
      },
    });
    f.challenge();
    expect(f.sent).toHaveLength(0);
    expect(f.fault.mock.calls[0]![0]).toEqual(new Error('CONTROLLER_AUTH_TARGET_CHANGED'));
    expect(f.owner.isKnown()).toBe(false);
  } finally {
    await f.finish();
  }
});

it('current original authority revocation cancels rather than supplying credentials', async () => {
  const f = fixture();
  try {
    f.attach();
    f.revoke();
    f.challenge();
    expect(f.sent.at(-1)).toMatchObject({
      params: { authChallengeResponse: { response: 'CancelAuth' } },
    });
    expect(JSON.stringify(f.sent)).not.toContain('a'.repeat(43));
    f.ack();
  } finally {
    await f.finish();
  }
});

for (const thrown of [false, undefined])
  it(`failure callback ${String(thrown)} cannot replace original ACK rejection`, async () => {
    const f = fixture();
    const original = new Error('ORIGINAL_AUTH_REFUSAL');
    f.fault.mockImplementation(() => {
      throw thrown;
    });
    try {
      f.attach();
      f.challenge();
      f.ack(undefined, { value: original });
      expect(
        await f.owner.prepareClose().then(
          () => undefined,
          (value) => value
        )
      ).toBe(original);
    } finally {
      await f.finish();
    }
  });

it('admits only the later genuine default-context attachment from an empty original census', async () => {
  const f = fixture(true);
  try {
    f.challenge('actual-page', 'before-attachment');
    expect((f.sent.at(-1)?.params as Record<string, unknown>).authChallengeResponse).toEqual({
      response: 'CancelAuth',
    });
    f.ack();
    f.attach();
    f.challenge('actual-page', 'after-attachment');
    expect((f.sent.at(-1)?.params as Record<string, unknown>).authChallengeResponse).toEqual({
      response: 'ProvideCredentials',
      username: 'dorkos',
      password: 'a'.repeat(43),
    });
    f.ack();
    await f.owner.prepareClose();
    expect(f.fault).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});

it('observes exact original challenge decisions and ACKs without retaining credentials or target data', async () => {
  const sink = vi.fn<(value: string) => unknown>();
  const f = fixture(false, sink);
  try {
    f.challenge('unowned', 'unowned-request');
    f.ack();
    f.attach();
    f.challenge();
    f.ack();
    f.challenge();
    f.ack();
    f.challenge('actual-page', 'server-request', 'Server');
    f.ack();
    f.challenge('actual-page', 'foreign-proxy', 'Proxy', 'http://127.0.0.1:32200');
    f.ack();
    f.challenge('actual-page', 'malformed-origin', 'Proxy', 'not a URL');
    f.ack();
    f.revoke();
    f.challenge('actual-page', 'revoked-request');
    f.ack();
    await f.owner.prepareClose();
    const text = sink.mock.calls.map(([line]) => line).join('');
    for (const decision of [
      'session',
      'provide',
      'repeat',
      'source',
      'origin-mismatch',
      'origin-invalid',
      'authority',
      'ack-observed',
    ])
      expect(text).toContain('"decision":"' + decision + '"');
    for (const privateValue of [
      'a'.repeat(43),
      '127.0.0.1',
      'actual-page',
      'original-request',
      'original-default-context',
    ])
      expect(text).not.toContain(privateValue);
    expect(f.fault).not.toHaveBeenCalled();
    expect(f.currentRead).toHaveBeenCalledTimes(7);
  } finally {
    await f.finish();
  }
});

it.each([false, undefined])(
  'isolates a throwing diagnostic sink while preserving original ACK failure %s',
  async (original) => {
    let entries = 0;
    const f = fixture(false, () => {
      entries++;
      throw original;
    });
    try {
      f.attach();
      f.challenge();
      expect((f.sent.at(-1)?.params as Record<string, unknown>).authChallengeResponse).toEqual({
        response: 'ProvideCredentials',
        username: 'dorkos',
        password: 'a'.repeat(43),
      });
      f.ack(undefined, { value: original });
      await expect(f.owner.prepareClose()).rejects.toBe(original);
      expect(f.fault).toHaveBeenCalledExactlyOnceWith(original);
      expect(entries).toBe(2);
    } finally {
      await f.finish();
    }
  }
);

it('reserves the diagnostic code before a reentrant challenge without replaying credentials', async () => {
  const sink = vi.fn<(value: string) => unknown>(() => {
    if (sink.mock.calls.length === 1) f.challenge();
  });
  const f: ReturnType<typeof fixture> = fixture(false, sink);
  try {
    f.attach();
    f.challenge();
    expect(f.sent).toHaveLength(2);
    expect((f.sent[0]!.params as Record<string, unknown>).authChallengeResponse).toMatchObject({
      response: 'ProvideCredentials',
    });
    expect((f.sent[1]!.params as Record<string, unknown>).authChallengeResponse).toEqual({
      response: 'CancelAuth',
    });
    f.ack(f.sent[0]!);
    f.ack(f.sent[1]!);
    await f.owner.prepareClose();
    expect(sink.mock.calls.filter(([line]) => line.includes('"decision":"provide"'))).toHaveLength(
      1
    );
    expect(f.fault).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});

it.each([false, undefined])(
  'does not reread a faulting original challenge getter %s',
  async (reason) => {
    const sink = vi.fn<(value: string) => unknown>(() => {
      throw new Error('DIAGNOSTIC_ONLY');
    });
    const f = fixture(false, sink);
    const getter = vi.fn(() => {
      throw reason;
    });
    try {
      f.attach();
      f.original.onmessage?.({
        method: 'Fetch.authRequired',
        sessionId: 'actual-page',
        params: {
          requestId: 'original-request',
          authChallenge: {
            get source() {
              return getter();
            },
            origin: 'http://127.0.0.1:32199',
          },
        },
      });
      // The original challenge classifier catches URL/source failures and sends CancelAuth.
      expect(getter).toHaveBeenCalledTimes(1);
      expect(f.currentRead).toHaveBeenCalledTimes(1);
      expect((f.sent.at(-1)?.params as Record<string, unknown>).authChallengeResponse).toEqual({
        response: 'CancelAuth',
      });
      f.ack();
      await f.owner.prepareClose();
      expect(f.fault).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  }
);

it.each([false, undefined])(
  'preserves original forwarding when diagnostic-only session getter throws %s',
  async (cause) => {
    const f = fixture();
    try {
      const event = { method: 'Runtime.consoleAPICalled', params: {} };
      const read = vi.fn(() => {
        throw cause;
      });
      Object.defineProperty(event, 'sessionId', { get: read });
      f.original.onmessage?.(event);
      expect(read).toHaveBeenCalledTimes(1);
      expect(f.sdk.mock.calls[0]?.[0]).toBe(event);
      expect(f.sdk).toHaveBeenCalledTimes(1);
      expect(f.fault).not.toHaveBeenCalled();
      expect(f.sent).toEqual([]);
      expect(f.owner.isKnown()).toBe(true);
    } finally {
      await f.finish();
    }
  }
);

const originalTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function attachOriginalWorker(f: ReturnType<typeof fixture>, context: string | undefined) {
  f.original.onmessage?.({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'original-worker-session',
      targetInfo: {
        targetId: 'original-worker-target',
        type: 'service_worker',
        browserContextId: context,
      },
    },
  });
  return {
    id: 91,
    method: 'Runtime.runIfWaitingForDebugger',
    sessionId: 'original-worker-session',
  };
}
it('holds the original worker resume until its exact same-session Fetch ACK and authenticates its original proxy challenge', async () => {
  const f = fixture();
  try {
    const resume = attachOriginalWorker(f, 'original-default-context');
    f.owner.transport.send(resume);
    await originalTurn();
    expect(f.sent).toHaveLength(1);
    const enable = f.sent[0]!;
    expect(enable).toMatchObject({
      method: 'Fetch.enable',
      sessionId: resume.sessionId,
      params: { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] },
    });
    expect(Number(enable.id)).toBeLessThan(0);
    expect(f.sent).not.toContain(resume);
    f.ack(enable);
    await originalTurn();
    expect(f.sent.filter((value) => value === resume)).toHaveLength(1);
    f.sdk.mockClear();
    const pause = {
      method: 'Fetch.requestPaused',
      sessionId: resume.sessionId,
      params: { requestId: 'original-worker-request' },
    };
    f.original.onmessage?.(pause);
    await originalTurn();
    expect(f.sdk).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({
      method: 'Fetch.continueRequest',
      sessionId: resume.sessionId,
      params: { requestId: 'original-worker-request' },
    });
    f.ack();
    f.challenge(resume.sessionId);
    const auth = f.sent.at(-1)!;
    expect(auth).toMatchObject({
      method: 'Fetch.continueWithAuth',
      sessionId: resume.sessionId,
      params: {
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: 'dorkos',
          password: 'a'.repeat(43),
        },
      },
    });
    f.ack(auth);
    await originalTurn();
    expect(f.fault).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});
it.each([false, undefined])(
  'worker Fetch ACK rejection %s preserves the exact first cause and never forwards resume',
  async (value) => {
    const f = fixture();
    try {
      const resume = attachOriginalWorker(f, 'original-default-context');
      f.owner.transport.send(resume);
      await originalTurn();
      f.ack(f.sent[0]!, { value });
      await originalTurn();
      expect(f.sent).not.toContain(resume);
      expect(f.fault).toHaveBeenCalledWith(value);
      await expect(f.owner.prepareClose()).rejects.toBe(value);
    } finally {
      await f.finish();
    }
  }
);
it.each(['close', 'revoke', 'detach'] as const)(
  'held original worker ACK cannot resume after %s and remains joined',
  async (action) => {
    const f = fixture();
    try {
      const resume = attachOriginalWorker(f, 'original-default-context');
      f.owner.transport.send(resume);
      await originalTurn();
      let preparation: Promise<void> | undefined;
      let settled = false;
      if (action === 'close') {
        preparation = f.owner.prepareClose();
        void preparation.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
      } else if (action === 'revoke') f.revoke();
      else
        f.original.onmessage?.({
          method: 'Target.detachedFromTarget',
          params: { sessionId: resume.sessionId },
        });
      await originalTurn();
      if (preparation) expect(settled).toBe(false);
      expect(f.sent).not.toContain(resume);
      f.ack(f.sent[0]!);
      await originalTurn();
      expect(f.sent).not.toContain(resume);
      expect(f.fault).toHaveBeenCalledTimes(1);
      await expect(preparation ?? f.owner.prepareClose()).rejects.toThrow(
        'CONTROLLER_AUTH_WORKER_RESUME_REFUSED'
      );
      if (preparation) expect(settled).toBe(true);
    } finally {
      await f.finish();
    }
  }
);

it.each([{ context: 'foreign-context' }, { context: undefined }])(
  'does not grant worker authentication to context $context',
  async ({ context }) => {
    const f = fixture();
    try {
      const resume = attachOriginalWorker(f, context);
      f.owner.transport.send(resume);
      expect(f.sent).toEqual([resume]);
      f.challenge(resume.sessionId);
      const auth = f.sent.at(-1)!;
      expect(auth).toMatchObject({
        method: 'Fetch.continueWithAuth',
        params: { authChallengeResponse: { response: 'CancelAuth' } },
      });
      expect(JSON.stringify(auth)).not.toContain('password');
      f.ack(auth);
    } finally {
      await f.finish();
    }
  }
);

it('bounds queued worker continuations plus their private ACK to the same 128 original tasks', async () => {
  const f = fixture();
  try {
    const first = attachOriginalWorker(f, 'original-default-context');
    const originals = Array.from({ length: 127 }, (_, index) => ({ ...first, id: 200 + index }));
    for (const original of originals) f.owner.transport.send(original);
    await originalTurn();
    expect(f.sent).toHaveLength(1);
    const enable = f.sent[0]!;
    expect(enable.method).toBe('Fetch.enable');
    expect(() => f.owner.transport.send({ ...first, id: 400 })).toThrow(
      'CONTROLLER_AUTH_WORKER_RESUME_CAPACITY'
    );
    expect(f.sent).not.toContain(originals[0]);
    f.ack(enable);
    await originalTurn();
    for (const original of originals)
      expect(f.sent.filter((value) => value === original)).toHaveLength(1);
    expect(f.fault).not.toHaveBeenCalled();
    await f.owner.prepareClose();
  } finally {
    await f.finish();
  }
});

it('refuses a private worker ACK producer when all 128 original task slots are already retained', async () => {
  const f = fixture();
  try {
    const first = attachOriginalWorker(f, 'original-default-context');
    for (let index = 0; index < 128; index++) f.owner.transport.send({ ...first, id: 200 + index });
    await originalTurn();
    expect(f.sent).toEqual([]);
    await expect(f.owner.prepareClose()).rejects.toThrow('CONTROLLER_AUTH_ADMISSION_CLOSED');
    expect(f.fault).toHaveBeenCalledTimes(1);
  } finally {
    await f.finish();
  }
});

async function readyOriginalWorker(f: ReturnType<typeof fixture>) {
  const resume = attachOriginalWorker(f, 'original-default-context');
  f.owner.transport.send(resume);
  await originalTurn();
  f.ack(f.sent.at(-1)!);
  await originalTurn();
  f.sdk.mockClear();
  return resume;
}
const workerPause = (sessionId: string, requestId = 'owned-paused-worker-request') => ({
  method: 'Fetch.requestPaused',
  sessionId,
  params: { requestId },
});

it('joins the exact owned worker continuation ACK before preparation returns', async () => {
  const f = fixture();
  let original: Record<string, unknown> | undefined;
  try {
    const resume = await readyOriginalWorker(f);
    f.original.onmessage?.(workerPause(resume.sessionId));
    await originalTurn();
    original = f.sent.at(-1)!;
    expect(original).toMatchObject({
      method: 'Fetch.continueRequest',
      sessionId: resume.sessionId,
      params: { requestId: 'owned-paused-worker-request' },
    });
    expect(Number(original.id)).toBeLessThan(0);
    expect(f.sdk).not.toHaveBeenCalled();
    let settled = false;
    const preparing = f.owner.prepareClose().then(() => {
      settled = true;
    });
    try {
      await originalTurn();
      expect(settled).toBe(false);
    } finally {
      f.ack(original);
      await preparing;
    }
  } finally {
    await f.finish();
  }
});

it.each([false, undefined])(
  'retains exact continuation ACK rejection %s as first cause',
  async (cause) => {
    const f = fixture();
    try {
      const resume = await readyOriginalWorker(f);
      f.original.onmessage?.(workerPause(resume.sessionId));
      await originalTurn();
      f.ack(f.sent.at(-1)!, { value: cause });
      const result = await f.owner.prepareClose().then(
        () => ({ ok: true as const }),
        (value: unknown) => ({ ok: false as const, value })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.value).toBe(cause);
      expect(f.sdk).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  }
);

it.each(['enable', 'disable'] as const)(
  'forwards worker pauses after later SDK Fetch.%s without private continuation',
  async (method) => {
    const f = fixture();
    try {
      const resume = await readyOriginalWorker(f);
      const command = {
        id: 600,
        sessionId: resume.sessionId,
        method: 'Fetch.' + method,
        params:
          method === 'enable'
            ? { handleAuthRequests: true, patterns: [{ urlPattern: '*', requestStage: 'Request' }] }
            : {},
      };
      f.owner.transport.send(command);
      const pause = workerPause(resume.sessionId);
      f.original.onmessage?.(pause);
      expect(f.sent.at(-1)).toBe(command);
      expect(f.sdk).toHaveBeenCalledWith(pause);
    } finally {
      await f.finish();
    }
  }
);

it.each(['enable', 'disable'] as const)(
  'orders prior SDK Fetch.%s before the original private worker setup',
  async (method) => {
    const f = fixture();
    try {
      const resume = attachOriginalWorker(f, 'original-default-context');
      const params = {
        handleAuthRequests: true,
        patterns: [{ urlPattern: 'https://original.test/*', requestStage: 'Request' }],
      };
      const command = {
        id: 600,
        sessionId: resume.sessionId,
        method: 'Fetch.' + method,
        params: method === 'enable' ? params : {},
      };
      f.owner.transport.send(command);
      f.owner.transport.send(resume);
      await originalTurn();
      const enabled = f.sent.at(-1)!;
      expect(enabled.params).toEqual(
        method === 'enable' ? params : { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }
      );
      if (method === 'enable') expect(enabled.params).not.toBe(params);
      f.ack(enabled);
      await originalTurn();
      const pause = workerPause(resume.sessionId);
      f.original.onmessage?.(pause);
      await originalTurn();
      if (method === 'enable') {
        expect(f.sdk).toHaveBeenCalledWith(pause);
        expect(f.sent.at(-1)).toBe(resume);
      } else {
        expect(f.sdk.mock.calls.some(([value]) => value === pause)).toBe(false);
        expect(f.sent.at(-1)?.method).toBe('Fetch.continueRequest');
        f.ack();
      }
    } finally {
      await f.finish();
    }
  }
);

it('refuses a revoked original worker pause before entering continuation', async () => {
  const f = fixture();
  try {
    const resume = await readyOriginalWorker(f);
    const before = f.sent.length;
    f.revoke();
    f.original.onmessage?.(workerPause(resume.sessionId));
    expect(f.sent).toHaveLength(before);
    expect(f.sdk).not.toHaveBeenCalled();
    await expect(f.owner.prepareClose()).rejects.toThrow('CONTROLLER_AUTH_WORKER_REQUEST_REVOKED');
  } finally {
    await f.finish();
  }
});

it.each(['actual-page', 'foreign-worker'])(
  'leaves non-managed session %s pause with its original SDK consumer',
  async (sessionId) => {
    const f = fixture();
    try {
      f.attach();
      const pause = workerPause(sessionId);
      f.original.onmessage?.(pause);
      expect(f.sdk).toHaveBeenCalledWith(pause);
      expect(f.sent).toEqual([]);
      expect(f.fault).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  }
);

it('retains a worker pause received before Fetch ACK and continues only after that exact ACK', async () => {
  const f = fixture();
  let enable: Record<string, unknown> | undefined;
  let enableReturned = false;
  try {
    const resume = attachOriginalWorker(f, 'original-default-context');
    f.owner.transport.send(resume);
    await originalTurn();
    enable = f.sent.at(-1)!;
    f.sdk.mockClear();
    f.original.onmessage?.(workerPause(resume.sessionId));
    await originalTurn();
    expect(f.sent).toEqual([enable]);
    expect(f.sdk).not.toHaveBeenCalled();
    f.ack(enable);
    enableReturned = true;
    await originalTurn();
    const continued = f.sent.find((value) => value.method === 'Fetch.continueRequest')!;
    expect(continued).toMatchObject({
      sessionId: resume.sessionId,
      params: { requestId: 'owned-paused-worker-request' },
    });
    f.ack(continued);
    await f.owner.prepareClose();
    expect(f.fault).not.toHaveBeenCalled();
  } finally {
    if (enable && !enableReturned) f.ack(enable);
    await f.finish();
  }
});

it('SDK disable during held private Fetch ACK prevents forwarding the original worker resume', async () => {
  const f = fixture();
  try {
    const resume = attachOriginalWorker(f, 'original-default-context');
    f.owner.transport.send(resume);
    await originalTurn();
    const enable = f.sent.at(-1)!;
    const disable = { id: 650, method: 'Fetch.disable', sessionId: resume.sessionId, params: {} };
    f.owner.transport.send(disable);
    expect(f.sent.at(-1)).toBe(disable);
    f.ack(enable);
    await originalTurn();
    expect(f.sent).not.toContain(resume);
    await expect(f.owner.prepareClose()).rejects.toThrow('CONTROLLER_AUTH_WORKER_RESUME_REFUSED');
  } finally {
    await f.finish();
  }
});

it.each(['close', 'revoke', 'detach', 'sdk-disable'] as const)(
  'a pre-ACK worker pause cannot enter continuation after %s',
  async (action) => {
    const f = fixture();
    let preparing: Promise<unknown> | undefined;
    try {
      const resume = attachOriginalWorker(f, 'original-default-context');
      f.owner.transport.send(resume);
      await originalTurn();
      const enable = f.sent.at(-1)!;
      f.original.onmessage?.(workerPause(resume.sessionId));
      await originalTurn();
      if (action === 'close') preparing = f.owner.prepareClose().catch((value: unknown) => value);
      else if (action === 'revoke') f.revoke();
      else if (action === 'detach')
        f.original.onmessage?.({
          method: 'Target.detachedFromTarget',
          params: { sessionId: resume.sessionId },
        });
      else
        f.owner.transport.send({
          id: 651,
          method: 'Fetch.disable',
          sessionId: resume.sessionId,
          params: {},
        });
      f.ack(enable);
      await originalTurn();
      expect(f.sent.some((value) => value.method === 'Fetch.continueRequest')).toBe(false);
      expect(f.sent).not.toContain(resume);
      expect(f.fault).toHaveBeenCalledTimes(1);
      await (preparing ?? f.owner.prepareClose().catch((value: unknown) => value));
    } finally {
      await f.finish();
    }
  }
);

it('releases settled worker request keys without imposing a permanent browsing history cap', async () => {
  const f = fixture();
  try {
    const resume = await readyOriginalWorker(f);
    for (let index = 0; index < 2; index++) {
      f.original.onmessage?.(workerPause(resume.sessionId));
      await originalTurn();
      const continued = f.sent.at(-1)!;
      expect(continued.method).toBe('Fetch.continueRequest');
      f.ack(continued);
      await originalTurn();
    }
    expect(f.fault).not.toHaveBeenCalled();
    await f.owner.prepareClose();
  } finally {
    await f.finish();
  }
});

it('refuses duplicate worker pauses while their original continuation ACK remains pending', async () => {
  const f = fixture();
  try {
    const resume = await readyOriginalWorker(f);
    const pause = workerPause(resume.sessionId);
    f.original.onmessage?.(pause);
    await originalTurn();
    f.original.onmessage?.(pause);
    await expect(f.owner.prepareClose()).rejects.toThrow('CONTROLLER_AUTH_WORKER_REQUEST_REPEATED');
    expect(f.sent.filter((value) => value.method === 'Fetch.continueRequest')).toHaveLength(1);
  } finally {
    await f.finish();
  }
});

it('captures original SDK routing patterns before caller mutation and preserves original command forwarding', async () => {
  const f = fixture();
  try {
    const resume = attachOriginalWorker(f, 'original-default-context');
    const params = {
      handleAuthRequests: true,
      patterns: [{ urlPattern: 'https://original.test/*', requestStage: 'Response' }],
    };
    const command = { id: 652, method: 'Fetch.enable', sessionId: resume.sessionId, params };
    f.owner.transport.send(command);
    expect(f.sent.at(-1)).toBe(command);
    params.patterns[0]!.urlPattern = '*';
    f.owner.transport.send(resume);
    await originalTurn();
    const enable = f.sent.at(-1)!;
    expect(enable.params).toEqual({
      handleAuthRequests: true,
      patterns: [{ urlPattern: 'https://original.test/*', requestStage: 'Response' }],
    });
    f.ack(enable);
    await originalTurn();
    f.sdk.mockClear();
    const pause = workerPause(resume.sessionId);
    f.original.onmessage?.(pause);
    expect(f.sdk).toHaveBeenCalledWith(pause);
    expect(f.sent.at(-1)).toBe(resume);
  } finally {
    await f.finish();
  }
});

it('leaves an admitted dedicated worker pause with its SDK routing consumer', async () => {
  const f = fixture();
  try {
    const resume = attachOriginalWorker(f, 'original-default-context');
    f.original.onmessage?.({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'dedicated-worker',
        targetInfo: {
          targetId: 'dedicated-target',
          type: 'worker',
          browserContextId: 'original-default-context',
        },
      },
    });
    f.owner.transport.send(resume);
    await originalTurn();
    f.ack();
    await originalTurn();
    f.sdk.mockClear();
    const pause = workerPause('dedicated-worker');
    f.original.onmessage?.(pause);
    expect(f.sdk).toHaveBeenCalledWith(pause);
    expect(f.sent.filter((value) => value.method === 'Fetch.continueRequest')).toEqual([]);
  } finally {
    await f.finish();
  }
});

it('does not admit a new SDK worker resume after original preparation has returned', async () => {
  const f = fixture();
  try {
    const resume = attachOriginalWorker(f, 'original-default-context');
    const preparation = f.owner.prepareClose();
    await preparation;
    f.owner.transport.send(resume);
    await originalTurn();
    expect(f.sent).toEqual([]);
    expect(f.fault).not.toHaveBeenCalled();
    expect(f.owner.prepareClose()).toBe(preparation);
    await f.owner.prepareClose();
  } finally {
    await f.finish();
  }
});

it('an SDK close callback cannot admit a late worker resume or replace original wire retirement', async () => {
  const f = fixture();
  try {
    const resume = attachOriginalWorker(f, 'original-default-context');
    const sdkClose = vi.fn(() => f.owner.transport.send(resume));
    f.owner.transport.onclose = sdkClose;
    const closing = f.owner.close();
    f.returned.resolve();
    await closing;
    await originalTurn();
    expect(sdkClose).toHaveBeenCalledTimes(1);
    expect(f.sent).toEqual([]);
    expect(f.fault).not.toHaveBeenCalled();
    expect(f.original.close).toHaveBeenCalledTimes(1);
    expect(f.owner.close()).toBe(closing);
  } finally {
    await f.finish();
  }
});

it('preserves the original SDK cache command and held ACK while retaining owned page HTTP cache', async () => {
  const f = fixture();
  try {
    f.attach();
    f.sdk.mockClear();
    const original = {
      id: 701,
      method: 'Network.setCacheDisabled',
      sessionId: 'actual-page',
      params: { cacheDisabled: true },
    };
    f.owner.transport.send(original);
    expect(f.sent.at(-1)).toEqual({ ...original, params: { cacheDisabled: false } });
    expect(original.params.cacheDisabled).toBe(true);
    expect(f.sdk).not.toHaveBeenCalled();
    const ack = { id: original.id, sessionId: original.sessionId, result: {} };
    f.original.onmessage?.(ack);
    expect(f.sdk).toHaveBeenCalledExactlyOnceWith(ack);
    expect(f.fault).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});

it.each(['foreign-page', undefined])(
  'does not normalize a foreign or root cache command %s',
  async (sessionId) => {
    const f = fixture();
    try {
      f.attach();
      f.sdk.mockClear();
      const original = {
        id: 702,
        method: 'Network.setCacheDisabled',
        ...(sessionId ? { sessionId } : {}),
        params: { cacheDisabled: true },
      };
      f.owner.transport.send(original);
      expect(f.sent.at(-1)).toBe(original);
    } finally {
      await f.finish();
    }
  }
);

it.each([{ cacheDisabled: false }, { cacheDisabled: true, unexpected: true }])(
  'preserves other original cache parameter shapes %s',
  async (params) => {
    const f = fixture();
    try {
      f.attach();
      f.sdk.mockClear();
      const original = {
        id: 703,
        method: 'Network.setCacheDisabled',
        sessionId: 'actual-page',
        params,
      };
      f.owner.transport.send(original);
      expect(f.sent.at(-1)).toBe(original);
    } finally {
      await f.finish();
    }
  }
);

it.each([false, undefined])(
  'retains exact original cache command producer failure %s',
  async (reason) => {
    const f = fixture();
    try {
      f.attach();
      f.sdk.mockClear();
      vi.mocked(f.original.send).mockImplementationOnce(() => {
        throw reason;
      });
      let failure: { value: unknown } | undefined;
      try {
        f.owner.transport.send({
          id: 704,
          method: 'Network.setCacheDisabled',
          sessionId: 'actual-page',
          params: { cacheDisabled: true },
        });
      } catch (value) {
        failure = { value };
      }
      expect(failure).toEqual({ value: reason });
      expect(f.fault).toHaveBeenCalledExactlyOnceWith(reason);
      expect(f.sdk).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  }
);

it.each(['stale', 'retiring', 'closed'] as const)(
  'forwards the exact original late cache preference unchanged when %s',
  async (state) => {
    const f = fixture();
    try {
      f.attach();
      f.sdk.mockClear();
      if (state === 'stale') f.revoke();
      else {
        await f.owner.prepareClose();
        if (state === 'closed') f.original.onclose?.();
      }
      const original = {
        id: 705,
        method: 'Network.setCacheDisabled',
        sessionId: 'actual-page',
        params: { cacheDisabled: true },
      };
      f.owner.transport.send(original);
      expect(f.sent.at(-1)).toBe(original);
      expect(f.original.send).toHaveBeenCalledExactlyOnceWith(original);
      expect(f.sdk).not.toHaveBeenCalled();
      const ack = { id: original.id, sessionId: original.sessionId, result: {} };
      f.original.onmessage?.(ack);
      expect(f.sdk).toHaveBeenCalledExactlyOnceWith(ack);
      expect(f.fault).not.toHaveBeenCalled();
    } finally {
      await f.finish();
    }
  }
);

it.each([false, undefined])(
  'preserves an actually throwing currentness callback cause %s',
  async (reason) => {
    const f = fixture();
    try {
      f.attach();
      f.sdk.mockClear();
      f.currentRead.mockImplementationOnce(() => {
        throw reason;
      });
      let failure: { value: unknown } | undefined;
      try {
        f.owner.transport.send({
          id: 706,
          method: 'Network.setCacheDisabled',
          sessionId: 'actual-page',
          params: { cacheDisabled: true },
        });
      } catch (value) {
        failure = { value };
      }
      expect(failure).toEqual({ value: reason });
      expect(f.sent).toHaveLength(0);
      expect(f.fault).toHaveBeenCalledExactlyOnceWith(reason);
    } finally {
      await f.finish();
    }
  }
);
