import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalBrowserMethods } from '../local-browser-methods';

afterEach(() => vi.unstubAllGlobals());
const state = {
  connectionId: 'connection',
  sessionId: 'chat-a',
  mode: 'new-window',
  status: 'connected',
  paused: false,
  selectedTabId: 'page-a',
  revision: 1,
  preparation: null,
  tabs: [{ id: 'page-a', url: 'https://example.test/', title: 'Made-up page' }],
  handoff: null,
  signIn: null,
  takenOver: false,
};
function setup() {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetch);
  return { fetch, methods: createLocalBrowserMethods('/api') };
}

describe('person browser transport selection', () => {
  it('carries the chat selector on reads and control requests', async () => {
    const { fetch, methods } = setup();
    await methods.getLocalBrowserState('chat-a');
    await methods.takeOverLocalBrowser('chat-b');
    await methods.pauseLocalBrowser('chat-a');
    await methods.finishLocalBrowserSignIn(undefined, 'chat-a');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/local-browser/state?sessionId=chat-a',
      '/api/local-browser/take-over?sessionId=chat-b',
      '/api/local-browser/pause?sessionId=chat-a',
      '/api/local-browser/sign-in/done?sessionId=chat-a',
    ]);
  });

  it('keeps Your browser distinct from any chat selector', async () => {
    const { fetch, methods } = setup();
    await methods.getLocalBrowserState(null);
    expect(fetch.mock.calls[0][0]).toBe('/api/local-browser/state');
  });
});
