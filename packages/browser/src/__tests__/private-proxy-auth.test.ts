import { afterEach, expect, it, vi } from 'vitest';
import { ownPrivateProxyAuthentication } from '../runtime/private-proxy-auth.js';

type Message = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
class Channel extends EventTarget {
  static OPEN = 1;
  static current: Channel;
  readyState = 1;
  readonly commands: Message[] = [];
  withholdClose = false;
  refuseMethod: string | undefined;
  beforeReply: ((message: Message) => void) | undefined;
  constructor() {
    super();
    Channel.current = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  emit(value: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
  send(input: string) {
    const message = JSON.parse(input) as Message;
    this.commands.push(message);
    queueMicrotask(() => {
      this.beforeReply?.(message);
      if (message.method === this.refuseMethod) {
        this.emit({ id: message.id, error: { code: -32602, message: 'private-original-secret' } });
        return;
      }
      if (message.method === 'Target.setAutoAttach' && !message.sessionId)
        this.emit({
          method: 'Target.attachedToTarget',
          params: { sessionId: 'original-page', targetInfo: { type: 'page' } },
        });
      this.emit({ id: message.id, result: {} });
    });
  }
  close() {
    this.readyState = 3;
    if (!this.withholdClose) queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
}
afterEach(() => vi.unstubAllGlobals());
const peer = Object.freeze({
  url: 'http://127.0.0.1:4241',
  credentials: Object.freeze({ username: 'dorkos', password: 'private-original-secret' }),
});
async function fixture() {
  vi.stubGlobal('WebSocket', Channel);
  const failed = vi.fn();
  const owner = await ownPrivateProxyAuthentication(
    'ws://127.0.0.1:9222/devtools/browser/original',
    peer,
    failed
  );
  return { owner, failed, channel: Channel.current };
}
async function settle() {
  for (let n = 0; n < 10; n++) await Promise.resolve();
}
it('authenticates only the exact proxy and never supplies secrets to upstream server challenges', async () => {
  const lines: string[] = [];
  const sink = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    lines.push(String(value));
    return true;
  });
  const owned: { owner?: Awaited<ReturnType<typeof ownPrivateProxyAuthentication>> } = {};
  try {
    const f = await fixture();
    owned.owner = f.owner;
    const challenge = (requestId: string, source: string, origin: string) =>
      f.channel.emit({
        method: 'Fetch.authRequired',
        sessionId: 'original-page',
        params: { requestId, authChallenge: { source, origin } },
      });
    challenge('proxy', 'Proxy', peer.url);
    challenge('server', 'Server', peer.url);
    challenge('other', 'Proxy', 'http://127.0.0.1:4242');
    challenge('proxy', 'Proxy', peer.url);
    challenge('malformed', 'Proxy', 'not-a-url');
    f.channel.emit({
      method: 'Fetch.authRequired',
      sessionId: 'original-page',
      params: { requestId: 'missing', authChallenge: { source: 'Proxy' } },
    });
    await settle();
    const replies = f.channel.commands.filter((m) => m.method === 'Fetch.continueWithAuth');
    expect(replies[0]!.params.authChallengeResponse).toEqual({
      response: 'ProvideCredentials',
      ...peer.credentials,
    });
    for (const reply of replies.slice(1))
      expect(reply.params.authChallengeResponse).toEqual({ response: 'CancelAuth' });
    expect(f.failed).not.toHaveBeenCalled();
    await f.owner.close();
    expect(lines.join('')).toContain('PROXY_AUTH_CHALLENGE_EXACT');
    expect(lines.join('')).toContain('PROXY_AUTH_CHALLENGE_REPEAT');
    expect(lines.join('')).toContain('PROXY_AUTH_CHALLENGE_NOT_PROXY');
    expect(lines.join('')).toContain('PROXY_AUTH_CHALLENGE_ORIGIN_INVALID');
    expect(lines.join('')).toContain('PROXY_AUTH_CHALLENGE_ORIGIN_MISMATCH');
    expect(lines.join('')).toContain('PROXY_AUTH_ACK_OBSERVED');
    expect(lines.join('')).not.toContain(peer.credentials.password);
    expect(lines.join('')).not.toContain(peer.url);
  } finally {
    try {
      await owned.owner?.close().catch(() => {});
    } finally {
      sink.mockRestore();
    }
  }
});
it('initializes recursively attached worker sessions before resuming their original paused target', async () => {
  const f = await fixture();
  f.channel.emit({
    method: 'Target.attachedToTarget',
    sessionId: 'original-page',
    params: { sessionId: 'original-worker', targetInfo: { type: 'service_worker' } },
  });
  await settle();
  const methods = f.channel.commands
    .filter((m) => m.sessionId === 'original-worker')
    .map((m) => m.method);
  expect(methods).toEqual([
    'Fetch.enable',
    'Target.setAutoAttach',
    'Runtime.runIfWaitingForDebugger',
  ]);
  await f.owner.close();
});
it('shares the original close and waits for its actual channel terminal event', async () => {
  const f = await fixture();
  f.channel.withholdClose = true;
  const original = f.owner.close();
  expect(f.owner.close()).toBe(original);
  let returned = false;
  void original.then(() => {
    returned = true;
  });
  await settle();
  expect(returned).toBe(false);
  expect(f.owner.isCustodyKnown()).toBe(false);
  f.channel.dispatchEvent(new Event('close'));
  await original;
  expect(returned).toBe(true);
});
it('fails custody on unknown auth sessions without sending credentials', async () => {
  const f = await fixture();
  f.channel.emit({
    method: 'Fetch.authRequired',
    sessionId: 'unowned',
    params: { requestId: 'x', authChallenge: { source: 'Proxy', origin: peer.url } },
  });
  expect(f.failed).toHaveBeenCalledOnce();
  expect(f.owner.isCustodyKnown()).toBe(false);
  expect(f.channel.commands.some((m) => m.method === 'Fetch.continueWithAuth')).toBe(false);
  await expect(f.owner.close()).rejects.toThrow('PROXY_AUTH_CUSTODY_UNCERTAIN');
});

it('resumes only an exact ancestor-covered dedicated worker without its unsupported Fetch domain', async () => {
  const f = await fixture();
  f.channel.refuseMethod = 'Fetch.enable';
  f.channel.emit({
    method: 'Target.attachedToTarget',
    sessionId: 'original-page',
    params: { sessionId: 'dedicated-one', targetInfo: { type: 'worker' } },
  });
  await settle();
  expect(
    f.channel.commands.filter((m) => m.sessionId === 'dedicated-one').map((m) => m.method)
  ).toEqual(['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  f.channel.emit({
    method: 'Target.attachedToTarget',
    sessionId: 'dedicated-one',
    params: { sessionId: 'nested-worker', targetInfo: { type: 'worker' } },
  });
  await settle();
  expect(
    f.channel.commands.filter((m) => m.sessionId === 'nested-worker').map((m) => m.method)
  ).toEqual(['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  expect(f.failed).not.toHaveBeenCalled();
  expect(f.owner.isCustodyKnown()).toBe(true);
  await f.owner.close();
});
it.each(['missing', 'detached'] as const)(
  'withholds dedicated worker resume when exact ancestor coverage is %s',
  async (mode) => {
    const f = await fixture();
    if (mode === 'detached') {
      f.channel.beforeReply = (message) => {
        if (message.method === 'Target.setAutoAttach' && message.sessionId === 'dedicated-one')
          f.channel.emit({
            method: 'Target.detachedFromTarget',
            params: { sessionId: 'original-page' },
          });
      };
    }
    f.channel.emit({
      method: 'Target.attachedToTarget',
      sessionId: mode === 'missing' ? 'unowned' : 'original-page',
      params: { sessionId: 'dedicated-one', targetInfo: { type: 'worker' } },
    });
    await settle();
    expect(
      f.channel.commands.some(
        (m) => m.sessionId === 'dedicated-one' && m.method === 'Runtime.runIfWaitingForDebugger'
      )
    ).toBe(false);
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.owner.isCustodyKnown()).toBe(false);
    await expect(f.owner.close()).rejects.toThrow('PROXY_AUTH_WORKER_PARENT_UNAVAILABLE');
  }
);

it('records original authentication ACK refusal without changing failed custody', async () => {
  const lines: string[] = [];
  const sink = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    lines.push(String(value));
    return true;
  });
  const owned: { owner?: Awaited<ReturnType<typeof ownPrivateProxyAuthentication>> } = {};
  try {
    const f = await fixture();
    owned.owner = f.owner;
    f.channel.refuseMethod = 'Fetch.continueWithAuth';
    f.channel.emit({
      method: 'Fetch.authRequired',
      sessionId: 'original-page',
      params: { requestId: 'actual-ack', authChallenge: { source: 'Proxy', origin: peer.url } },
    });
    await settle();
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.owner.isCustodyKnown()).toBe(false);
    await expect(f.owner.close()).rejects.toThrow('PROXY_AUTH_METHOD_REFUSED');
    expect(lines.join('')).toContain('PROXY_AUTH_ACK_REFUSED');
    expect(lines.join('')).not.toContain('private-original-secret');
  } finally {
    try {
      await owned.owner?.close().catch(() => {});
    } finally {
      sink.mockRestore();
    }
  }
});

it.each([false, undefined])(
  'retains native auth setup and paused stages despite reentrant falsy sink %s',
  async (cause) => {
    const lines: string[] = [];
    let reentered = false;
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
      lines.push(String(value));
      if (String(value).includes('PROXY_AUTH_REQUEST_PAUSED') && !reentered) {
        reentered = true;
        Channel.current.emit({
          method: 'Fetch.requestPaused',
          sessionId: 'original-page',
          params: { requestId: 'second-original-request' },
        });
      }
      throw cause;
    });
    const owned: { owner?: Awaited<ReturnType<typeof ownPrivateProxyAuthentication>> } = {};
    try {
      const f = await fixture();
      owned.owner = f.owner;
      expect(lines.join('')).toContain('PROXY_AUTH_OWNER_ENTERED');
      expect(lines.join('')).toContain('PROXY_AUTH_TARGET_ATTACHED');
      expect(lines.join('')).toContain('PROXY_AUTH_FETCH_ENABLED');
      expect(lines.join('')).toContain('PROXY_AUTH_READY');
      f.channel.emit({
        method: 'Fetch.requestPaused',
        sessionId: 'original-page',
        params: { requestId: 'first-original-request' },
      });
      await settle();
      expect(
        f.channel.commands
          .filter((value) => value.method === 'Fetch.continueRequest')
          .map((value) => value.params.requestId)
      ).toEqual(['first-original-request', 'second-original-request']);
      expect(lines.filter((value) => value.includes('PROXY_AUTH_REQUEST_PAUSED'))).toHaveLength(1);
      expect(f.failed).not.toHaveBeenCalled();
      await f.owner.close();
      expect(lines.join('')).not.toContain('original-page');
      expect(lines.join('')).not.toContain(peer.credentials.password);
    } finally {
      try {
        await owned.owner?.close().catch(() => {});
      } finally {
        sink.mockRestore();
      }
    }
  }
);
it.each(['malformed-event', 'unowned-session', 'malformed-message'] as const)(
  'retains the original native auth refusal branch %s after original fault entry',
  async (mode) => {
    const lines: string[] = [];
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
      lines.push(String(value));
      return true;
    });
    const owned: { owner?: Awaited<ReturnType<typeof ownPrivateProxyAuthentication>> } = {};
    try {
      const f = await fixture();
      owned.owner = f.owner;
      if (mode === 'malformed-message')
        f.channel.dispatchEvent(new MessageEvent('message', { data: '{invalid-original' }));
      else
        f.channel.emit({
          method: 'Fetch.authRequired',
          sessionId: mode === 'unowned-session' ? 'unowned' : 'original-page',
          params: mode === 'malformed-event' ? {} : { requestId: 'original-request' },
        });
      expect(f.failed).toHaveBeenCalledOnce();
      expect(f.owner.isCustodyKnown()).toBe(false);
      expect(f.channel.commands.some((value) => value.method === 'Fetch.continueWithAuth')).toBe(
        false
      );
      const code =
        mode === 'unowned-session'
          ? 'PROXY_AUTH_EVENT_SESSION_UNKNOWN'
          : mode === 'malformed-message'
            ? 'PROXY_AUTH_MESSAGE_INVALID'
            : 'PROXY_AUTH_EVENT_INVALID';
      expect(lines.join('')).toContain(code);
      expect(lines.join('')).not.toContain('PROXY_AUTH_CHALLENGE_EXACT');
      await expect(f.owner.close()).rejects.toThrow('PROXY_AUTH_CUSTODY_UNCERTAIN');
    } finally {
      try {
        await owned.owner?.close().catch(() => {});
      } finally {
        sink.mockRestore();
      }
    }
  }
);

it('acknowledges original browser-root Fetch before admitting target autoattach', async () => {
  vi.stubGlobal('WebSocket', Channel);
  const send = Channel.prototype.send;
  let enable!: Message;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = vi.spyOn(Channel.prototype, 'send').mockImplementation(function (
    this: Channel,
    input: string
  ) {
    const message = JSON.parse(input) as Message;
    if (message.method === 'Fetch.enable' && !Object.hasOwn(message, 'sessionId')) {
      this.commands.push(message);
      enable = message;
      entered();
    } else Reflect.apply(send, this, [input]);
  });
  const opening = ownPrivateProxyAuthentication(
    'ws://127.0.0.1:9222/devtools/browser/original',
    peer,
    vi.fn()
  );
  void opening.catch(() => {});
  try {
    await Promise.race([
      entry,
      opening.then(() => {
        throw new Error('ROOT_FETCH_NOT_ENTERED');
      }),
    ]);
    expect(enable.params).toEqual({ handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
    Channel.current.emit({ method: 'Fetch.requestPaused', params: { requestId: 'pre-ack-root' } });
    Channel.current.emit({
      method: 'Fetch.authRequired',
      params: { requestId: 'pre-ack-auth', authChallenge: { source: 'Proxy', origin: peer.url } },
    });
    await settle();
    expect(
      Channel.current.commands.some((m) =>
        ['Fetch.continueRequest', 'Fetch.continueWithAuth'].includes(m.method)
      )
    ).toBe(false);
    expect(Channel.current.commands.some((m) => m.method === 'Target.setAutoAttach')).toBe(false);
  } finally {
    if (enable) Channel.current.emit({ id: enable.id, result: {} });
    await opening.then(
      (owner) => owner.close(),
      () => {}
    );
    held.mockRestore();
  }
});

it('owns root pauses and exact proxy challenges without confusing a child request identifier', async () => {
  const f = await fixture();
  try {
    f.channel.emit({ method: 'Fetch.requestPaused', params: { requestId: 'root-request' } });
    const challenge = (requestId: string, source: string, origin: string, session?: string) =>
      f.channel.emit({
        method: 'Fetch.authRequired',
        ...(session ? { sessionId: session } : {}),
        params: { requestId, authChallenge: { source, origin } },
      });
    challenge('same-request', 'Proxy', peer.url);
    challenge('same-request', 'Proxy', peer.url, 'original-page');
    challenge('same-request', 'Proxy', peer.url);
    challenge('server', 'Server', peer.url);
    challenge('foreign', 'Proxy', 'http://127.0.0.1:4242');
    await settle();
    const pause = f.channel.commands.find((m) => m.method === 'Fetch.continueRequest');
    expect(pause?.params).toEqual({ requestId: 'root-request' });
    expect(Object.hasOwn(pause!, 'sessionId')).toBe(false);
    const replies = f.channel.commands.filter((m) => m.method === 'Fetch.continueWithAuth');
    for (const reply of replies.slice(0, 2))
      expect(reply.params.authChallengeResponse).toEqual({
        response: 'ProvideCredentials',
        ...peer.credentials,
      });
    for (const reply of replies.slice(2))
      expect(reply.params.authChallengeResponse).toEqual({ response: 'CancelAuth' });
    expect(f.failed).not.toHaveBeenCalled();
  } finally {
    await f.owner.close();
  }
});

it.each([null, false, ''])(
  'refuses explicit invalid root event session %s instead of root authority',
  async (sessionId) => {
    const f = await fixture();
    try {
      f.channel.emit({
        method: 'Fetch.authRequired',
        sessionId,
        params: { requestId: 'root-request', authChallenge: { source: 'Proxy', origin: peer.url } },
      });
      expect(f.failed).toHaveBeenCalledOnce();
      expect(f.channel.commands.some((m) => m.method === 'Fetch.continueWithAuth')).toBe(false);
      await expect(f.owner.close()).rejects.toThrow('PROXY_AUTH_CUSTODY_UNCERTAIN');
    } finally {
      await f.owner.close().catch(() => {});
    }
  }
);

it.each([false, undefined])(
  'joins held root authentication and preserves original falsy reply %s',
  async (cause) => {
    const f = await fixture();
    const send = f.channel.send;
    let reply!: Message;
    f.channel.send = function (this: Channel, input: string) {
      const message = JSON.parse(input) as Message;
      if (message.method === 'Fetch.continueWithAuth' && !Object.hasOwn(message, 'sessionId')) {
        this.commands.push(message);
        reply = message;
      } else Reflect.apply(send, this, [input]);
    };
    let preparing: Promise<void> | undefined,
      released = false;
    const release = () => {
      if (!reply || released) return;
      released = true;
      // JSON cannot encode an undefined own property; capture its raw reply
      // through the original decoder's retained test-only JSON.parse port.
      const parse = JSON.parse;
      const original = vi.spyOn(JSON, 'parse').mockImplementation((input, reviver) => {
        if (input === 'original-root-error') return { id: reply.id, error: cause };
        return parse(input, reviver);
      });
      try {
        f.channel.dispatchEvent(new MessageEvent('message', { data: 'original-root-error' }));
      } finally {
        original.mockRestore();
      }
    };
    try {
      f.channel.emit({
        method: 'Fetch.authRequired',
        params: { requestId: 'held-root', authChallenge: { source: 'Proxy', origin: peer.url } },
      });
      await settle();
      preparing = f.owner.prepareClose();
      void preparing.catch(() => {});
      await settle();
      expect(f.channel.readyState).toBe(1);
      const count = f.channel.commands.length;
      f.channel.emit({ method: 'Fetch.requestPaused', params: { requestId: 'late-root' } });
      expect(f.channel.commands).toHaveLength(count);
      release();
      await expect(preparing).rejects.toBe(cause);
      await expect(f.owner.close()).rejects.toBe(cause);
    } finally {
      release();
      // Assertion failure cannot suppress entry or joining of either original.
      const closing = f.owner.close();
      await Promise.allSettled([...(preparing ? [preparing] : []), closing]);
      f.channel.send = send;
    }
  }
);

it('rejects a child-session ACK for the original root Fetch before target admission', async () => {
  vi.stubGlobal('WebSocket', Channel);
  const send = Channel.prototype.send;
  const held = vi.spyOn(Channel.prototype, 'send').mockImplementation(function (
    this: Channel,
    input: string
  ) {
    const message = JSON.parse(input) as Message;
    if (message.method === 'Fetch.enable' && !Object.hasOwn(message, 'sessionId')) {
      this.commands.push(message);
      queueMicrotask(() => this.emit({ id: message.id, sessionId: 'unowned-child', result: {} }));
    } else Reflect.apply(send, this, [input]);
  });
  const failed = vi.fn();
  const opening = ownPrivateProxyAuthentication(
    'ws://127.0.0.1:9222/devtools/browser/original',
    peer,
    failed
  );
  void opening.catch(() => {});
  try {
    await expect(opening).rejects.toThrow('PROXY_AUTH_ROOT_REPLY_SESSION_INVALID');
    expect(Channel.current.commands.some((m) => m.method === 'Target.setAutoAttach')).toBe(false);
    expect(failed).toHaveBeenCalledOnce();
  } finally {
    await opening.catch(() => {});
    await settle();
    held.mockRestore();
  }
});

it.each([{ result: null }, { result: false }, { result: [] }])(
  'refuses malformed original root result $result before target admission',
  async ({ result }) => {
    vi.stubGlobal('WebSocket', Channel);
    const send = Channel.prototype.send;
    const held = vi.spyOn(Channel.prototype, 'send').mockImplementation(function (
      this: Channel,
      input: string
    ) {
      const message = JSON.parse(input) as Message;
      if (message.method === 'Fetch.enable' && !Object.hasOwn(message, 'sessionId')) {
        this.commands.push(message);
        queueMicrotask(() => this.emit({ id: message.id, result }));
      } else Reflect.apply(send, this, [input]);
    });
    const opening = ownPrivateProxyAuthentication(
      'ws://127.0.0.1:9222/devtools/browser/original',
      peer,
      vi.fn()
    );
    void opening.catch(() => {});
    try {
      await expect(opening).rejects.toThrow('PROXY_AUTH_ROOT_REPLY_INVALID');
      expect(Channel.current.commands.some((m) => m.method === 'Target.setAutoAttach')).toBe(false);
    } finally {
      await opening.catch(() => {});
      await settle();
      held.mockRestore();
    }
  }
);
