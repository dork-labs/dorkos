import { afterEach, expect, it, vi } from 'vitest';
import { ownPrivateProxyAuthentication } from '../runtime/private-proxy-auth.js';

type Message = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
class Channel extends EventTarget {
  static OPEN = 1;
  static current: Channel;
  readyState = 1;
  readonly commands: Message[] = [];
  withholdClose = false;
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
  const f = await fixture();
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
