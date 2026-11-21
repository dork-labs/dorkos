import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { confirmPersonPaint, leaseFixture } from './page-leases-fixture.js';
import { BrowserPageProtection } from '../leases/page-protection.js';
import { BrowserHandover } from '../handover.js';
import { SignInWindow } from '../sign-in-window.js';
import type { PlainChromiumExit } from '../plain-chromium.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup(url = 'https://example.com/start') {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate(url);
  const viewer = await f.service.pageBroker.captureViewerLease('chat-a', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'view',
  });
  const beforeTakeover = f.protocolSessions.length;
  const lease = await f.service.pageBroker.takePersonControl(viewer);
  return {
    ...f,
    page,
    viewer,
    lease,
    personSessions: f.protocolSessions.slice(beforeTakeover),
    protocol: f.protocolSessions.at(-1)!,
    baseline: f.protocolSessions.length,
  };
}
describe('same-site held control', () => {
  it('the full takeover path owns one CDP session and reads only the approved three methods', async () => {
    const f = await setup();
    expect(f.personSessions).toHaveLength(1);
    expect(f.protocol.send.mock.calls.map(([method]) => method)).toEqual([
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    expect(f.protocol.send.mock.calls[1][1]).toEqual({
      frameId: 'frame',
      worldName: 'dorkos-person-safety',
      grantUniveralAccess: false,
    });
    expect(f.protocol.send.mock.calls[2][1]).toMatchObject({
      contextId: 1,
      returnByValue: true,
      awaitPromise: false,
      timeout: 500,
    });
  });
  it('retains only the lease, requiring fresh safety, paint and address generations', async () => {
    const f = await setup();
    expect(f.lease.inputReady()).toBe(false);
    confirmPersonPaint(f.lease, f.viewer);
    await f.lease.runPerson({ kind: 'keyDown', key: 'Shift' });
    await f.lease.runPerson({ kind: 'down', button: 'left' });
    const old = f.viewer.facts().navigationGeneration;
    f.page.navigate('https://accounts.example.com/next');
    expect(f.lease.isCurrent()).toBe(true);
    expect(f.lease.inputReady()).toBe(false);
    await expect(f.lease.runPerson({ kind: 'text', text: 'stale' })).rejects.toBeDefined();
    await vi.waitFor(() => expect(f.protocolSessions).toHaveLength(f.baseline + 1));
    await vi.waitFor(() => {
      expect(() =>
        f.lease.confirmPaint({
          navigationGeneration: old,
          addressGeneration: old,
          viewportGeneration: 1,
        })
      ).toThrow();
      const next = f.viewer.facts().navigationGeneration;
      expect(() =>
        f.lease.confirmPaint({
          navigationGeneration: next,
          addressGeneration: old,
          viewportGeneration: 1,
        })
      ).toThrow();
      confirmPersonPaint(f.lease, f.viewer);
    });
    expect(f.page.page.keyboard.up).toHaveBeenCalledWith('Shift');
    expect(f.page.page.mouse.up).toHaveBeenCalledWith({ button: 'left' });
    expect(f.protocol.detach).toHaveBeenCalledOnce();
    await f.lease.runPerson({ kind: 'text', text: 'fresh' });
    expect(f.page.page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith('fresh');
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
  it.each([
    ['https://example.com', 'https://other.com'],
    ['https://example.com', 'http://example.com'],
    ['https://alice.github.io', 'https://bob.github.io'],
    ['https://a.github.io', 'https://b.github.io'],
    ['https://a.vercel.app', 'https://b.vercel.app'],
    ['http://localhost:6001', 'http://localhost:6001/next'],
    ['https://xn--bcher-kva.de', 'https://xn--bcher-kva.de/next'],
    ['https://192.0.2.1:6001', 'https://192.0.2.2:6001'],
    ['https://example.com', 'https://example.com.evil.com'],
    ['https://example.com', 'https://notexample.com'],
    ['https://example.com', 'https://example.com./'],
    ['https://example.com', 'about:blank'],
    ['https://foo.internal', 'https://foo.internal/next'],
    ['https://127.0.0.1:6001', 'https://127.0.0.1:6002'],
  ])('ends control at a cross-site or unknown commit: %s → %s', async (initial, next) => {
    const f = await setup(initial);
    const count = f.protocolSessions.length;
    f.page.navigate(next);
    expect(f.lease.isCurrent()).toBe(false);
    await vi.waitFor(() => expect(f.protocol.detach).toHaveBeenCalled());
    expect(f.protocolSessions).toHaveLength(count);
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
  it.each([
    ['https://alice.github.io', 'https://app.alice.github.io'],
    ['https://example.com', 'https://accounts.example.com:8443'],
    ['https://127.0.0.1:6001', 'https://127.0.0.1:6001/next'],
  ])('keeps a matching schemeful site or exact IP origin: %s → %s', async (initial, next) => {
    const f = await setup(initial);
    f.page.navigate(next);
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(f.lease.isCurrent()).toBe(true);
    expect(f.lease.inputReady()).toBe(true);
  });
  it('never restores control after a committed cross-site bounce back', async () => {
    const f = await setup();
    f.page.navigate('https://other.com');
    f.page.navigate('https://example.com/returned');
    expect(f.lease.isCurrent()).toBe(false);
    await expect(f.lease.readSelection()).rejects.toBeDefined();
    expect(f.protocolSessions).toHaveLength(f.baseline);
  });
  it('serializes rapid same-site commits without restoring an older generation', async () => {
    const f = await setup();
    f.page.navigate('https://accounts.example.com/one');
    f.page.navigate('https://www.example.com/two');
    f.page.navigate('https://example.com/three');
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(f.lease.isCurrent()).toBe(true);
    expect(f.lease.inputReady()).toBe(true);
  });
  it('invalidates per-action fences on subframe changes without treating them as main commits', async () => {
    const f = await setup();
    confirmPersonPaint(f.lease, f.viewer);
    f.page.events.emit('frameattached', { url: () => 'https://other.com' });
    expect(f.lease.isCurrent()).toBe(true);
    expect(f.lease.inputReady()).toBe(false);
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(f.lease.isCurrent()).toBe(true);
  });
  it('judges a server redirect by its committed URL', async () => {
    const f = await setup();
    // Network redirect intermediates do not emit a Playwright main-frame commit.
    f.page.navigate('https://accounts.example.com/redirect-result');
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(f.lease.isCurrent()).toBe(true);
  });
  it('plain sign-in ownership refuses the metadata guard without a debugger or document read', async () => {
    const f = await setup();
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
    const handover = new BrowserHandover(
      f.service.personSession('chat-a'),
      signIns,
      () => f.directory
    );
    const protection = new BrowserPageProtection(
      handover,
      () => 'agent-atlas',
      () => [],
      () => [],
      () => undefined
    );
    expect(protection.allowed(f.page.page)).toBe(true);
    const count = f.protocolSessions.length;
    vi.mocked(f.page.page.title).mockClear();
    await signIns.start(
      path.join(f.directory, 'browser-profiles', 'agent-atlas'),
      'agent-atlas',
      'https://example.com'
    );
    try {
      expect(protection.allowed(f.page.page)).toBe(false);
      expect(f.protocolSessions).toHaveLength(count);
      expect(f.page.page.title).not.toHaveBeenCalled();
    } finally {
      signIns.done();
    }
  });
  it('refuses an initial protected page before acquiring a person protocol session', async () => {
    const f = await leaseFixture();
    fixtures.push(f);
    await f.open('chat-a');
    f.contexts[0].pages[0].navigate('http://localhost:4242/sign-in');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', {
      ownerId: 'owner',
      appSessionId: 'app',
      clientInstanceId: 'client',
      viewerId: 'view',
    });
    const count = f.protocolSessions.length;
    await expect(f.service.pageBroker.takePersonControl(viewer)).rejects.toBeDefined();
    expect(f.protocolSessions).toHaveLength(count);
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
  it('protected-origin metadata wins before any additional safety read', async () => {
    const f = await setup();
    f.page.navigate('http://localhost:4242/sign-in');
    expect(f.lease.isCurrent()).toBe(false);
    await vi.waitFor(() => expect(f.protocol.detach).toHaveBeenCalled());
    expect(f.protocolSessions).toHaveLength(f.baseline);
  });
  it('ends control on a fresh refused sign-in verdict without publishing its content', async () => {
    const f = await setup('https://accounts.google.com/start');
    const attach = vi.mocked(f.contexts[0].context.newCDPSession);
    const original = attach.getMockImplementation()!;
    attach.mockImplementationOnce(async (...args) => {
      const protocol = await original(...args);
      const send = protocol.send.bind(protocol);
      protocol.send = vi.fn(async (method, params) =>
        method === 'Runtime.evaluate'
          ? { result: { value: { title: 'Couldn’t sign you in', text: 'PRIVATE_CANARY' } } }
          : send(method, params)
      ) as typeof protocol.send;
      return protocol;
    });
    f.page.navigate('https://accounts.google.com/next');
    await vi.waitFor(() => expect(f.lease.isCurrent()).toBe(false));
    expect(f.lease.inputReady()).toBe(false);
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('PRIVATE_CANARY');
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
});
