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
function fixture(emptyCatalog = false) {
  const sent: Array<Record<string, unknown>> = [];
  const returned = deferred();
  let closing: Promise<void> | undefined;
  const original: ConnectOverCDPTransport = {
    open: vi.fn(),
    send: (value) => {
      if (!message(value)) throw new Error('CONTROL_MESSAGE_INVALID');
      sent.push(value);
    },
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
  const owner = createControllerProxyAuthentication(
    original,
    {
      url: 'http://127.0.0.1:32199',
      credentials: { username: 'dorkos', password: 'a'.repeat(43) },
    },
    () => current,
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
    })
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
