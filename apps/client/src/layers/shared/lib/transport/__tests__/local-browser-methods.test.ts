/**
 * The person's browser calls send exactly the requests the hand-written ones
 * did (DOR-5473). Only the request is under test: each answer is the same
 * made-up body, so a call whose own schema refuses it is let go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalBrowserMethods } from '../local-browser-methods';

afterEach(() => vi.unstubAllGlobals());

/** Record every request, answering each with an empty JSON object. */
function record() {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL, method (`fetch` sends GET when none is named) and body of each request. */
function sent(fetchMock: ReturnType<typeof record>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method ?? 'GET',
    body: init?.body,
  }));
}

/** Run each call, ignoring what its own schema makes of the made-up answer. */
async function settle(calls: Array<() => Promise<unknown>>) {
  for (const call of calls) await call().catch(() => undefined);
}

describe('createLocalBrowserMethods', () => {
  const methods = createLocalBrowserMethods('/api', () => 'client-1');

  it('reads the handoff, the capabilities and the profiles with bodyless GETs', async () => {
    const fetchMock = record();
    await settle([
      () => methods.getLocalBrowserHandoffState(),
      () => methods.getLocalBrowserCapabilities(),
      () => methods.listLocalBrowserProfiles(),
    ]);
    expect(sent(fetchMock)).toEqual([
      { url: '/api/local-browser/handoff/state', method: 'GET', body: undefined },
      { url: '/api/local-browser/capabilities', method: 'GET', body: undefined },
      { url: '/api/local-browser/profiles', method: 'GET', body: undefined },
    ]);
  });

  it('changes profiles at their encoded ids', async () => {
    const fetchMock = record();
    await settle([
      () => methods.bindLocalBrowserProfile('agent-a', 'agent 1', 'chat-a'),
      () => methods.unbindLocalBrowserProfile('agent-a', 'agent 1', 'chat-a'),
      () => methods.unbindLocalBrowserProfile('agent-a', 'agent 1'),
      () => methods.forgetLocalBrowserSignIns('agent-a'),
      () => methods.forgetLocalBrowserSignIns(null),
      () => methods.deleteLocalBrowserProfile('agent-a'),
    ]);
    expect(sent(fetchMock)).toEqual([
      {
        url: '/api/local-browser/profiles/agent-a/agents?sessionId=chat-a',
        method: 'POST',
        body: '{"agentId":"agent 1"}',
      },
      {
        url: '/api/local-browser/profiles/agent-a/agents/agent%201?sessionId=chat-a',
        method: 'DELETE',
        body: undefined,
      },
      {
        url: '/api/local-browser/profiles/agent-a/agents/agent%201',
        method: 'DELETE',
        body: undefined,
      },
      { url: '/api/local-browser/profiles/agent-a/forget-sign-ins', method: 'POST', body: '{}' },
      { url: '/api/local-browser/profiles/default/forget-sign-ins', method: 'POST', body: '{}' },
      { url: '/api/local-browser/profiles/agent-a', method: 'DELETE', body: undefined },
    ]);
  });

  it('opens, steers and hands back the browser with the same bodies', async () => {
    const fetchMock = record();
    await settle([
      () => methods.openLocalBrowser({ mode: 'embedded', sessionId: 'chat-a' }),
      () => methods.selectLocalBrowserTab('page a', 'chat-a'),
      () => methods.navigateLocalBrowser('https://example.test/', { sessionId: 'chat-a' }),
      () => methods.navigateLocalBrowser('example.test', { httpFallback: true }),
      () => methods.stepLocalBrowserHistory('back', 'chat-a'),
      () => methods.takeOverLocalBrowser('chat-a'),
      () => methods.pauseLocalBrowser('chat-a'),
      () => methods.resumeLocalBrowser(null),
      () => methods.disconnectLocalBrowser('chat-a'),
      () => methods.signInLocalBrowser({ url: 'https://example.test/' }, 'chat-a'),
      () => methods.finishLocalBrowserSignIn('handoff-1', 'chat-a'),
      () => methods.finishLocalBrowserSignIn(undefined, null),
      () => methods.handBackLocalBrowser('handoff-1'),
      () => methods.stopLocalBrowserHandoff('handoff-1'),
    ]);
    expect(sent(fetchMock)).toEqual([
      {
        url: '/api/local-browser/open',
        method: 'POST',
        body: '{"mode":"embedded","sessionId":"chat-a"}',
      },
      {
        url: '/api/local-browser/tabs/page%20a/select?sessionId=chat-a',
        method: 'POST',
        body: '{}',
      },
      {
        url: '/api/local-browser/navigate?sessionId=chat-a',
        method: 'POST',
        body: '{"url":"https://example.test/"}',
      },
      {
        url: '/api/local-browser/navigate',
        method: 'POST',
        body: '{"url":"example.test","httpFallback":true}',
      },
      {
        url: '/api/local-browser/history?sessionId=chat-a',
        method: 'POST',
        body: '{"direction":"back"}',
      },
      { url: '/api/local-browser/take-over?sessionId=chat-a', method: 'POST', body: '{}' },
      { url: '/api/local-browser/pause?sessionId=chat-a', method: 'POST', body: '{}' },
      { url: '/api/local-browser/resume', method: 'POST', body: '{}' },
      { url: '/api/local-browser/disconnect?sessionId=chat-a', method: 'POST', body: '{}' },
      {
        url: '/api/local-browser/sign-in?sessionId=chat-a',
        method: 'POST',
        body: '{"url":"https://example.test/"}',
      },
      {
        url: '/api/local-browser/sign-in/done?sessionId=chat-a',
        method: 'POST',
        body: '{"handoffId":"handoff-1"}',
      },
      { url: '/api/local-browser/sign-in/done', method: 'POST', body: '{}' },
      {
        url: '/api/local-browser/handoff/hand-back',
        method: 'POST',
        body: '{"handoffId":"handoff-1"}',
      },
      {
        url: '/api/local-browser/handoff/stop',
        method: 'POST',
        body: '{"handoffId":"handoff-1"}',
      },
    ]);
  });
});
