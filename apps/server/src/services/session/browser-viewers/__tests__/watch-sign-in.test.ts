import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { leaseFixture } from '../../local-browser/__tests__/page-leases-fixture.js';
import { BrowserPageBroker } from '../../local-browser/leases/page-broker.js';
import { BrowserPageProtection } from '../../local-browser/leases/page-protection.js';
import { BrowserHandover } from '../../local-browser/handover.js';
import { SignInWindow } from '../../local-browser/sign-in-window.js';
import type { PlainChromiumExit } from '../../local-browser/plain-chromium.js';
import { captureViewerPage } from '../page-binding.js';
const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
it('W1: refuses watch and screencast while sign-in holds an otherwise current page', async () => {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate('https://example.com');
  f.signIn.mockRestore();
  let exit!: (value: PlainChromiumExit) => void;
  const exited = new Promise<PlainChromiumExit>((resolve) => {
    exit = resolve;
  });
  const signIns = new SignInWindow({
    executable: async () => '/fake/Chrome',
    installedChrome: () => '/fake/Chrome',
    prepare: async () => undefined,
    held: () => false,
    lockOwner: () => 123,
    spawner: () => ({
      pid: 123,
      exited,
      quit: () => exit({ code: 0, signal: null }),
      forceQuit: () => exit({ code: 1, signal: null }),
    }),
  });
  const session = f.service.personSession('chat-a');
  const handover = new BrowserHandover(session, signIns, () => f.directory);
  const protection = new BrowserPageProtection(
    handover,
    () => 'agent-atlas',
    () => [],
    () => [],
    () => undefined
  );
  // Real captured service authority; only the independent sign-in window uses fake process edges.
  const source = session.captureViewerPage();
  const broker = new BrowserPageBroker(() => ({
    ...source,
    assertWatchAllowed: () => protection.watch(page.page),
  }));
  const identity = {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'viewer',
  };
  const handle = await broker.captureViewerLease('chat-a', identity);
  const view = await captureViewerPage(
    broker,
    'chat-a',
    { ownerId: 'owner', sessionId: 'app', clientId: 'client' },
    'watch'
  );
  const count = f.protocolSessions.length;
  await signIns.start(
    path.join(f.directory, 'browser-profiles', 'agent-atlas'),
    'agent-atlas',
    'https://example.com'
  );
  try {
    expect(source.isCurrent()).toBe(true);
    expect(handover.signInHoldsProfile('agent-atlas')).toBe(true);
    expect(() => view.assertLive()).toThrow('viewer_unavailable');
    await expect(handle.openScreencast()).rejects.toBeDefined();
    expect(f.protocolSessions).toHaveLength(count);
    expect(source.isCurrent()).toBe(true);
  } finally {
    signIns.done();
    await view.close();
    await handle.close();
  }
});
