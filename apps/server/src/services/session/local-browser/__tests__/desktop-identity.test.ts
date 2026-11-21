import { afterEach, expect, it, vi } from 'vitest';
import { desktopBrowserPort } from '../desktop-bridge.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('passes the real opening identity to the desktop host admission check', async () => {
  vi.stubEnv('DORKOS_MANAGED_BY', 'desktop');
  vi.stubEnv('DORKOS_LOCAL_BROWSER_BRIDGE', 'http://127.0.0.1:6500');
  vi.stubEnv('DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN', 'a'.repeat(64));
  const request = vi.fn(
    async (_url: URL, _options: RequestInit) =>
      new Response(JSON.stringify({ endpoint: 'ws://127.0.0.1:6500/page/example', headers: {} }))
  );
  vi.stubGlobal('fetch', request);
  const port = desktopBrowserPort()!;
  await port.open('example', { sessionId: 'agent-chat', profileId: 'agent-atlas' });
  expect(JSON.parse(request.mock.calls[0]![1].body as string)).toEqual({
    connectionId: 'example',
    sessionId: 'agent-chat',
    profileId: 'agent-atlas',
  });
});
