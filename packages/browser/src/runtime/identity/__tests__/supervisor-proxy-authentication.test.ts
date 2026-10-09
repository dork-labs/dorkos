import { expect, it, onTestFinished, vi } from 'vitest';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { createSupervisorChromeBarrier } from '../supervisor-chrome-barrier.js';
import { ownSupervisorProxyAuthentication } from '../supervisor-proxy-authentication.js';
type Message = Record<string, unknown>;
const payload = {
  userAgent: 'Mozilla/5.0 Chrome/153.0.0.0',
  platform: 'MacIntel',
  userAgentMetadata: {
    brands: [{ brand: 'Chromium', version: '153' }],
    mobile: false,
    platform: 'macOS',
    fullVersionList: [{ brand: 'Chromium', version: '153.0.8010.12' }],
    fullVersion: '153.0.8010.12',
    architecture: 'arm',
    bitness: '64',
    model: '',
    platformVersion: '15.0.0',
    wow64: false,
    formFactors: ['Desktop'],
  },
};
const peer = {
  url: 'http://127.0.0.1:49111',
  credentials: Object.freeze({ username: 'dorkos', password: 'private-semantic-peer' }),
};
/** Production bridge/credential consumer; raw protocol channels are semantic doubles. */
function fixture(attachHandler = true) {
  const accepted = new Set<unknown>(),
    work = new Set<Promise<unknown>>();
  let owner: ReturnType<typeof ownSupervisorProxyAuthentication> | undefined;
  onTestFinished(async () => {
    const results = await Promise.allSettled([owner?.close(), barrier?.close(), ...work]);
    const unexpected = results.find(
      (result) => result.status === 'rejected' && !accepted.has(result.reason)
    );
    if (unexpected?.status === 'rejected') throw unexpected.reason;
  });
  const raw = () => {
    const messages: Message[] = [];
    const transport: ConnectOverCDPTransport = {
      send: vi.fn((value) => {
        messages.push(value as Message);
      }),
      close: vi.fn(() => {
        transport.onclose?.();
      }),
    };
    return { transport, messages };
  };
  const auth = raw(),
    sdk = raw();
  const barrier = createSupervisorChromeBarrier({
    authentication: auth.transport,
    sdk: sdk.transport,
    root: { id: 'original-page', context: 'original-context' },
    payload,
    assertOriginalOwner: () => {},
    authenticationRequired: true,
  });
  const diagnostic = vi.fn();
  if (attachHandler)
    owner = ownSupervisorProxyAuthentication(barrier.authentication, peer, diagnostic);
  const original = barrier;
  const attach = (channel: typeof auth, sessionId: string) =>
    channel.transport.onmessage?.({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        waitingForDebugger: false,
        targetInfo: {
          targetId: 'original-page',
          type: 'page',
          url: 'about:blank',
          browserContextId: 'original-context',
        },
      },
    });
  const ack = (channel: typeof auth, message: Message) =>
    channel.transport.onmessage?.({
      id: message.id,
      sessionId: message.sessionId,
      result: {},
    });
  const initialize = () => {
    attach(auth, 'auth-original');
    attach(sdk, 'sdk-original');
    original.sdk.send({
      id: 700,
      sessionId: 'sdk-original',
      method: 'Runtime.runIfWaitingForDebugger',
      params: {},
    });
    for (const channel of [auth, sdk])
      for (const message of [...channel.messages])
        if (
          ['Emulation.setUserAgentOverride', 'Fetch.enable', 'Target.setAutoAttach'].includes(
            String(message.method)
          )
        )
          ack(channel, message);
    for (const channel of [auth, sdk])
      for (const message of [...channel.messages])
        if (message.method === 'Runtime.runIfWaitingForDebugger') ack(channel, message);
  };
  const challenge = (source: string, origin: string, requestId = 'original-request') =>
    auth.transport.onmessage?.({
      method: 'Fetch.authRequired',
      sessionId: 'auth-original',
      params: { requestId, authChallenge: { source, origin } },
    });
  const own = <T>(value: Promise<T>) => {
    work.add(value);
    return value;
  };
  return {
    auth,
    sdk,
    barrier: original,
    owner,
    initialize,
    ack,
    challenge,
    accepted,
    diagnostic,
    own,
  };
}

it('refuses first autoattach without the original credential listener before any native command', async () => {
  const f = fixture(false);
  expect(() => f.barrier.startAuthentication()).toThrow('SUPERVISOR_AUTH_HANDLER_UNAVAILABLE');
  expect(f.auth.messages).toEqual([]);
  expect(f.sdk.messages).toEqual([]);
  await f.barrier.close();
});

it('answers a genuine paired proxy challenge exactly once through the same original authentication channel', async () => {
  const f = fixture();
  f.initialize();
  f.challenge('Proxy', peer.url);
  const replies = f.auth.messages.filter((message) => message.method === 'Fetch.continueWithAuth');
  expect(replies).toHaveLength(1);
  expect(replies[0]!.params).toEqual({
    requestId: 'original-request',
    authChallengeResponse: { response: 'ProvideCredentials', ...peer.credentials },
  });
  f.ack(f.auth, replies[0]!);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.owner!.isCustodyKnown()).toBe(true);
  f.owner!.enterOriginalPeerClose();
  f.barrier.enterOriginalPeerClose();
  await f.owner!.close();
  expect(f.auth.transport.close).toHaveBeenCalledTimes(1);
  expect(f.sdk.transport.close).toHaveBeenCalledTimes(1);
  expect(f.diagnostic).not.toHaveBeenCalled();
});

it.each([
  ['Server', peer.url],
  ['Proxy', 'http://127.0.0.1:49112'],
])(
  'cancels %s challenge from %s without lending the original proxy credential',
  async (source, origin) => {
    const f = fixture();
    f.initialize();
    f.challenge(source!, origin!);
    const reply = f.auth.messages.find((message) => message.method === 'Fetch.continueWithAuth')!;
    expect(reply.params).toEqual({
      requestId: 'original-request',
      authChallengeResponse: { response: 'CancelAuth' },
    });
    f.ack(f.auth, reply);
    await Promise.resolve();
    await Promise.resolve();
    await f.owner!.close();
  }
);

it('retains original send undefined through real bridge cleanup even with a no-op diagnostic', async () => {
  const f = fixture();
  f.initialize();
  f.accepted.add(undefined);
  const send = f.auth.transport.send;
  // The bridge captured its original sender: mutate the consumed mock implementation,
  // rather than a replacement property the production bridge deliberately ignores.
  vi.mocked(send).mockImplementation((value) => {
    if ((value as Message).method === 'Fetch.continueWithAuth') throw undefined;
    f.auth.messages.push(value as Message);
  });
  f.challenge('Proxy', peer.url);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.owner!.isCustodyKnown()).toBe(false);
  expect(f.diagnostic).toHaveBeenCalledExactlyOnceWith(undefined);
  await expect(f.owner!.close()).rejects.toBeUndefined();
  await expect(f.barrier.close()).rejects.toBeUndefined();
});

it('rejects and joins the exact held original authentication start when close enters before its ACK', async () => {
  const f = fixture();
  const opening = f.own(f.barrier.startAuthentication());
  const refusal = opening.catch((value) => {
    f.accepted.add(value);
    return value;
  });
  const authClosing = f.own(f.owner!.close());
  const closing = f.own(f.barrier.close());
  const cause = await refusal;
  expect(cause).toBeInstanceOf(Error);
  await expect(closing).rejects.toBe(cause);
  await expect(authClosing).rejects.toBe(cause);
  expect(f.auth.transport.close).toHaveBeenCalledTimes(1);
  expect(f.sdk.transport.close).toHaveBeenCalledTimes(1);
});

it('reserves the original start promise before a synchronous autoattach send reenters admission', async () => {
  const f = fixture();
  let nested: Promise<void> | undefined;
  vi.mocked(f.auth.transport.send).mockImplementation((value) => {
    f.auth.messages.push(value as Message);
    nested = f.barrier.startAuthentication();
  });
  const original = f.own(f.barrier.startAuthentication());
  expect(nested).toBe(original);
  expect(f.auth.messages.filter((value) => value.method === 'Target.setAutoAttach')).toHaveLength(
    1
  );
  f.ack(f.auth, f.auth.messages[0]!);
  await original;
  await f.own(f.owner!.close());
  await f.own(f.barrier.close());
});

it('retains an original undefined error ACK and joins both channel closures without a secondary exception', async () => {
  const f = fixture();
  f.accepted.add(undefined);
  const opening = f.own(f.barrier.startAuthentication());
  const failure = expect(opening).rejects.toBeUndefined();
  f.auth.transport.onmessage?.({ id: f.auth.messages[0]!.id, error: undefined });
  await failure;
  const authClosing = f.own(f.owner!.close());
  await expect(f.own(f.barrier.close())).rejects.toBeUndefined();
  await expect(authClosing).rejects.toBeUndefined();
  expect(f.barrier.status().firstCause).toBeUndefined();
  expect(f.auth.transport.close).toHaveBeenCalledTimes(1);
  expect(f.sdk.transport.close).toHaveBeenCalledTimes(1);
});

it('joins the captured async stop even when its original terminal callback returns first', async () => {
  const f = fixture();
  f.initialize();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  vi.mocked(f.auth.transport.close).mockImplementation(() => {
    f.auth.transport.onclose?.();
    return held;
  });
  const closing = f.own(f.owner!.close());
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.auth.transport.close).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  release();
  await closing;
  await f.own(f.barrier.close());
});
