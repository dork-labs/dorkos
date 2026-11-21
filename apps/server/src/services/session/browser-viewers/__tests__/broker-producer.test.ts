import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserViewerRegistry } from '../viewer-registry.js';
import { leaseFixture } from '../../local-browser/__tests__/page-leases-fixture.js';
const principal = { ownerId: 'owner', sessionId: 'app', clientId: 'client' };
const image = Buffer.from([255, 216, 255, 192, 0, 11, 8, 1, 224, 2, 128, 1, 1, 17, 0, 255, 217]);
const fixtures: { f: Awaited<ReturnType<typeof leaseFixture>>; registry: BrowserViewerRegistry }[] =
  [];
afterEach(async () => {
  for (const { f, registry } of fixtures.splice(0)) {
    await registry.close();
    await f.cleanup();
  }
});
async function setup() {
  const f = await leaseFixture();
  await f.open('chat-a');
  f.contexts[0].pages[0].navigate('https://example.com');
  const registry = new BrowserViewerRegistry(f.service.viewerPages.resolve);
  fixtures.push({ f, registry });
  const starts = () =>
    f.protocolSessions.filter((p) =>
      p.send.mock.calls.some(([method]) => method === 'Page.startScreencast')
    );
  const emit = (protocol: (typeof f.protocolSessions)[number], sessionId = 1) =>
    protocol.events.emit('Page.screencastFrame', {
      sessionId,
      data: image.toString('base64'),
      metadata: {
        deviceWidth: 640,
        deviceHeight: 480,
        offsetTop: 0,
        pageScaleFactor: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });
  return { ...f, registry, starts, emit };
}
describe('one physical broker producer per server-bound Page (V6)', () => {
  it.each(['github.io', 'vercel.app'])(
    'never follows a watch across private tenants on %s',
    async (suffix) => {
      const f = await setup();
      const page = f.contexts[0].pages[0];
      page.navigate(`https://a.${suffix}`);
      const watching = await f.registry.subscribe(principal, 'chat-a');
      const old = f.starts()[0];
      page.navigate(`https://b.${suffix}`);
      f.emit(old);
      await expect(
        f.registry.frame(principal, watching.viewerId, watching.nonce)
      ).rejects.toMatchObject({ code: 'viewer_denied' });
      expect(f.starts()).toHaveLength(1);
      await vi.waitFor(() => expect(old.detach).toHaveBeenCalledOnce());
    }
  );

  it('refuses watch and screencast during same-profile sign-in while the captured page stays current (W1)', async () => {
    const f = await setup();
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', {
      ownerId: 'owner',
      appSessionId: 'app',
      clientInstanceId: 'client',
      viewerId: 'held-view',
    });
    const session = f.service.personSession('chat-a');
    const active = vi
      .spyOn(session.handover, 'signInHoldsProfile')
      .mockImplementation((profile) => profile === 'agent-atlas');
    try {
      expect(viewer.isCurrent()).toBe(true);
      const before = f.protocolSessions.length;
      expect(() => viewer.assertWatchAllowed()).toThrow();
      await expect(viewer.openScreencast()).rejects.toThrow();
      await expect(f.registry.subscribe(principal, 'chat-a')).rejects.toMatchObject({
        code: 'viewer_unavailable',
      });
      expect(viewer.isCurrent()).toBe(true);
      expect(f.protocolSessions).toHaveLength(before);
      expect(f.starts()).toHaveLength(0);
    } finally {
      active.mockRestore();
      await viewer.close();
    }
  });

  it('never starts a replacement stream before navigation teardown physically settles', async () => {
    const f = await setup();
    const viewer = await f.registry.subscribe(principal, 'chat-a');
    const old = f.starts()[0];
    let release!: () => void;
    old.detach.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    f.contexts[0].pages[0].navigate('https://example.com/next');
    await vi.waitFor(() => expect(old.detach).toHaveBeenCalledTimes(1));
    expect(f.starts()).toHaveLength(1);
    f.emit(old);
    await expect(f.registry.frame(principal, viewer.viewerId, viewer.nonce)).resolves.toBeNull();
    release();
    await vi.waitFor(() => expect(f.starts()).toHaveLength(2));
    f.emit(f.starts()[1]);
    expect((await f.registry.frame(principal, viewer.viewerId, viewer.nonce))?.sequence).toBe(1);
    expect(old.detach).toHaveBeenCalledTimes(1);
  });

  it('rejects a delivered old-generation frame after same-site navigation before HTTP delivery', async () => {
    const f = await setup();
    const viewer = await f.registry.subscribe(principal, 'chat-a');
    f.emit(f.starts()[0]);
    const frame = await f.registry.frame(principal, viewer.viewerId, viewer.nonce);
    expect(frame).not.toBeNull();
    expect(f.registry.deliveryCurrent(principal, viewer.viewerId, viewer.nonce, frame!)).toBe(true);
    f.contexts[0].pages[0].navigate('https://example.com/next');
    expect(f.registry.deliveryCurrent(principal, viewer.viewerId, viewer.nonce, frame!)).toBe(
      false
    );
  });

  it('shares concurrent captures while keeping each viewer authority separate', async () => {
    const f = await setup();
    const viewers = await Promise.all(
      ['one', 'two', 'three'].map((clientId) =>
        f.registry.subscribe({ ...principal, clientId }, 'chat-a')
      )
    );
    expect(new Set(viewers.map((v) => v.viewerId)).size).toBe(3);
    expect(f.starts()).toHaveLength(1);
    const stream = f.starts()[0];
    await f.registry.unsubscribe(
      { ...principal, clientId: 'one' },
      viewers[0].viewerId,
      viewers[0].nonce
    );
    expect(stream.detach).not.toHaveBeenCalled();
    f.emit(stream);
    await expect(
      f.registry.frame({ ...principal, clientId: 'one' }, viewers[1].viewerId, viewers[1].nonce)
    ).rejects.toMatchObject({ code: 'viewer_denied' });
    expect(
      (
        await f.registry.frame(
          { ...principal, clientId: 'two' },
          viewers[1].viewerId,
          viewers[1].nonce
        )
      )?.bytes
    ).toEqual(image);
    await f.registry.unsubscribe(
      { ...principal, clientId: 'two' },
      viewers[1].viewerId,
      viewers[1].nonce
    );
    expect(stream.detach).not.toHaveBeenCalled();
    await f.registry.unsubscribe(
      { ...principal, clientId: 'three' },
      viewers[2].viewerId,
      viewers[2].nonce
    );
    expect(stream.detach).toHaveBeenCalledTimes(1);
  });
  it('keeps distinct chat pages distinct even inside one profile connection', async () => {
    const f = await setup();
    await f.open('chat-b');
    await Promise.all(['chat-a', 'chat-b'].map((chat) => f.registry.subscribe(principal, chat)));
    expect(f.starts()).toHaveLength(2);
    expect(new Set(f.starts().map((s) => s.page)).size).toBe(2);
  });
  it('retains the page reservation through last-viewer cleanup and old closes cannot stop a replacement', async () => {
    const f = await setup();
    const a = await f.registry.subscribe(principal, 'chat-a');
    const old = f.starts()[0];
    let finish!: () => void;
    old.detach.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const closing = f.registry.unsubscribe(principal, a.viewerId, a.nonce);
    await vi.waitFor(() => expect(old.detach).toHaveBeenCalledTimes(1));
    await expect(f.registry.subscribe(principal, 'chat-a')).rejects.toMatchObject({
      code: 'viewer_busy',
    });
    expect(f.starts()).toHaveLength(1);
    finish();
    await closing;
    const b = await f.registry.subscribe(principal, 'chat-a');
    expect(f.starts()).toHaveLength(2);
    await expect(f.registry.unsubscribe(principal, a.viewerId, a.nonce)).rejects.toBeDefined();
    expect(f.starts()[1].detach).not.toHaveBeenCalled();
    f.emit(f.starts()[1]);
    expect((await f.registry.frame(principal, b.viewerId, b.nonce))?.bytes).toEqual(image);
  });
  it('serializes replacement streams and retains the subscription across custody and navigation', async () => {
    const f = await setup();
    const a = await f.registry.subscribe(principal, 'chat-a');
    const stream = f.starts()[0];
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', {
      ownerId: 'owner',
      appSessionId: 'app',
      clientInstanceId: 'client',
      viewerId: 'control',
    });
    await f.service.pageBroker.takePersonControl(viewer);
    await vi.waitFor(() => expect(f.starts().at(-1)!.detach).not.toHaveBeenCalled());
    expect(f.starts().length).toBeGreaterThan(1);
    for (const previous of f.starts().slice(0, -1))
      expect(previous.detach).toHaveBeenCalledTimes(1);
    const count = f.starts().length;
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    f.contexts[0].pages[0].navigate('https://example.com/next');
    f.emit(stream);
    await vi.waitFor(() => expect(f.starts()).toHaveLength(count + 1));
    for (const previous of f.starts().slice(0, -1))
      expect(previous.detach).toHaveBeenCalledTimes(1);
    f.emit(f.starts().at(-1)!);
    expect((await f.registry.frame(principal, a.viewerId, a.nonce))?.bytes).toEqual(image);
    await viewer.close();
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
  it('sign-in closes the old watch before reaching the plain-window launch boundary', async () => {
    const f = await setup();
    const a = await f.registry.subscribe(principal, 'chat-a');
    const old = f.starts()[0];
    // The fixture refuses the external plain-window launch; no browser process starts.
    await expect(
      f.service.personSession('chat-a').handover.signIn({
        url: 'https://example.com',
        profileId: 'agent-atlas',
      })
    ).rejects.toThrow('Unexpected plain-window launch');
    expect(f.signIn).toHaveBeenCalledTimes(1);
    expect(old.detach).toHaveBeenCalledTimes(1);
    f.emit(old);
    await expect(f.registry.frame(principal, a.viewerId, a.nonce)).rejects.toBeDefined();
    expect(f.starts()).toHaveLength(1);
    await expect(f.registry.subscribe(principal, 'chat-a')).rejects.toMatchObject({
      code: 'viewer_unavailable',
    });
    expect(f.starts()).toHaveLength(1);
  });
  it('reconnect revokes old subscriptions and never reuses their producer', async () => {
    const f = await setup();
    const a = await f.registry.subscribe(principal, 'chat-a');
    const old = f.starts()[0];
    await f.service.personSession('chat-a').disconnect();
    await f.open('chat-a');
    const b = await f.registry.subscribe(principal, 'chat-a');
    expect(b.binding.connectionId).not.toBe(a.binding.connectionId);
    f.emit(old);
    await expect(f.registry.frame(principal, a.viewerId, a.nonce)).rejects.toBeDefined();
    expect(old.detach).toHaveBeenCalledTimes(1);
    expect(f.starts()).toHaveLength(2);
  });
});
