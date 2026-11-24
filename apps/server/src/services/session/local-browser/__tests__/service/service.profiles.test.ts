import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { createLocalBrowserProfileStore } from '../../profile-store.js';
import { fixture, trackedPageSession, create, selectOwned } from './service.fixtures.js';

it('refuses forgetting a profile until its window has fully closed', async () => {
  const f = await create();
  await f.service.open({ mode: 'new-window' });
  await expect(f.service.profileRemoval.forget(null)).rejects.toMatchObject({
    code: 'profile_busy',
  });
  await f.service.disconnect();
  await expect(f.service.profileRemoval.forget(null)).resolves.toBeUndefined();
});

describe('the agent window’s name (DOR-3111)', () => {
  it('names the window after the agent of the chat it opens for', async () => {
    const f = await create();
    const lookup = vi.fn(async (sessionId: string) =>
      sessionId === 'chat-one' ? 'Atlas' : undefined
    );
    f.service.windowNames.use(lookup);
    await f.service.open({ mode: 'new-window', sessionId: 'chat-one' });
    expect(lookup).toHaveBeenCalledExactlyOnceWith('chat-one');
    expect(vi.mocked(f.backend.launch).mock.calls[0]?.[3]).toBe('Atlas');
    await f.service.disconnect();
  });
});

it('does not remove the profile while its final close is still flushing cookies', async () => {
  const f = await create();
  await f.service.open({ mode: 'new-window' });
  let finish!: () => void;
  vi.mocked(f.context.close).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const closing = f.service.disconnect();
  await Promise.resolve();
  await expect(f.service.profileRemoval.forget(null)).rejects.toMatchObject({
    code: 'profile_busy',
  });
  finish();
  await closing;
  await expect(f.service.profileRemoval.forget(null)).resolves.toBeUndefined();
});

it('refuses profile removal while a window is still acquiring its disk profile', async () => {
  const f = await create();
  let acquired!: () => void;
  vi.mocked(f.backend.launch).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      acquired = resolve;
    });
    return f.context;
  });
  const opening = f.service.open({ mode: 'new-window' });
  await expect(f.service.profileRemoval.forget(null)).rejects.toMatchObject({
    code: 'profile_busy',
  });
  // Let asynchronous folder preparation reach the fake browser launcher.
  await vi.waitFor(() => expect(acquired).toBeTypeOf('function'));
  acquired();
  await opening;
  await f.service.disconnect();
});

it('refuses removing a named profile while its window owns it', async () => {
  const f = await create();
  const profiles = createLocalBrowserProfileStore(createTestDb(), () => Buffer.alloc(32, 1));
  const { id } = profiles.create('Example work');
  f.service.useProfileAccess(
    async () => undefined,
    (candidate) => candidate === id
  );
  await f.service.open({ mode: 'new-window', profileId: id });
  await expect(f.service.profileRemoval.delete(id, profiles)).rejects.toMatchObject({
    code: 'profile_busy',
  });
  expect(profiles.get(id)).toBeDefined();
  await f.service.disconnect();
  await expect(f.service.profileRemoval.delete(id, profiles)).resolves.toBeUndefined();
  expect(profiles.get(id)).toBeUndefined();
});

describe('named profiles (DOR-3218)', () => {
  const profileId = '00000000-0000-4000-8000-000000000001';

  it('opens a named profile in its own folder', async () => {
    const f = await create(undefined, true);
    f.service.useProfileAccess(
      async () => undefined,
      () => true
    );
    await f.service.open({ mode: 'new-window', profileId });
    expect(f.backend.launch).toHaveBeenLastCalledWith(
      path.join(f.dir, 'browser-profiles', profileId),
      expect.anything(),
      expect.anything(),
      null,
      expect.any(Function)
    );
    await f.service.disconnect();
  });

  it.each([
    ['unknown', true],
    ['set up yet', false],
  ])('refuses to open a profile when it is not %s, and makes no folder', async (_name, set) => {
    const f = await create();
    if (set)
      f.service.useProfileAccess(
        async () => undefined,
        () => false
      );
    await expect(f.service.open({ mode: 'new-window', profileId })).rejects.toMatchObject({
      code: 'profile_not_found',
    });
    expect(f.backend.launch).not.toHaveBeenCalled();
    await expect(readFile(path.join(f.dir, 'browser-profiles', profileId))).rejects.toThrow();
  });

  it('asks the access check on every profile, including default', async () => {
    const f = await create();
    const access = vi.fn(async () => undefined);
    f.service.useProfileAccess(access, () => true);
    await f.service.open({ mode: 'new-window', sessionId: 's' });
    await f.service.requireProfileAccess('s');
    expect(access).toHaveBeenCalledExactlyOnceWith('default', 's');
    await f.service.open({ mode: 'new-window', profileId, sessionId: 's' });
    await f.service.requireProfileAccess('s');
    await f.service.requireProfileAccess('s');
    expect(access).toHaveBeenCalledTimes(3);
    expect(access).toHaveBeenLastCalledWith(profileId, 's');
    await f.service.disconnect();
  });

  it('never opens a named profile in the embedded browser', async () => {
    const f = await create();
    f.service.useProfileAccess(
      async () => undefined,
      () => true
    );
    await expect(f.service.open({ mode: 'embedded', profileId })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('DorkOS app origins (DOR-3218)', () => {
  const refused = { code: 'dorkos_origin' };
  const origins = () => [
    'http://localhost:4242',
    'http://127.0.0.1:4242',
    'http://[::1]:4242',
    'http://0.0.0.0:4242',
    'http://fixture.local:4242',
    'http://192.168.1.20:4242',
    'https://fixture.ngrok.app',
  ];

  it.each(origins())('refuses navigation to %s before dispatch', async (url) => {
    const { service, page } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    await expect(
      service.action({ kind: 'navigate', url, revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(page.goto).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it.each(origins())('refuses a redirect to %s and gives the agent nothing', async (url) => {
    const { service, page, context, navigate, change } = await create(origins);
    const cookies = vi.fn(async () => []);
    Object.assign(context, { cookies, storageState: cookies });
    await selectOwned(service);
    const observed = await service.observe();
    vi.mocked(page.evaluateHandle).mockClear();
    vi.mocked(page.goto).mockImplementationOnce(async () => {
      change('- text "PAGE-SECRET"');
      navigate(`${url}/connections?token=URL-SECRET`);
      return null;
    });
    const error = await service
      .action({
        kind: 'navigate',
        url: 'http://fixture.test/redirect',
        revision: observed.revision,
      })
      .catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject(refused);
    expect(JSON.stringify({ message: (error as Error).message })).not.toMatch(/SECRET/);
    expect((await service.state()).paused).toBe(true);
    await expect(service.observe()).rejects.toMatchObject(refused);
    await expect(service.screenshot()).rejects.toMatchObject(refused);
    await expect(service.agentState()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('tells the agent a page it may not read paused it, once the page is safe again (DOR-4678)', async () => {
    const { service, page, navigate } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    vi.mocked(page.goto).mockImplementationOnce(async () => {
      navigate('http://localhost:4242/connections');
      return null;
    });
    await expect(
      service.action({
        kind: 'navigate',
        url: 'http://fixture.test/r',
        revision: observed.revision,
      })
    ).rejects.toMatchObject(refused);
    navigate('http://fixture.test/safe');
    const error = (await service
      .action({ kind: 'navigate', url: 'http://fixture.test/x', revision: observed.revision })
      .catch((caught: unknown) => caught)) as { code: string; message: string };
    expect(error.code).toBe('paused');
    expect(error.message).toContain('only a person can resume it');
    expect(error.message).toContain('or a page you may not read');
    await service.disconnect();
  });

  it.each(['file:///etc/hosts', 'view-source:http://localhost:4242/'])(
    'refuses an agent navigation to %s before dispatch',
    async (url) => {
      const { service, page } = await create(origins);
      await selectOwned(service);
      const observed = await service.observe();
      await expect(
        service.action({ kind: 'navigate', url, revision: observed.revision })
      ).rejects.toMatchObject({ code: 'unsupported_address' });
      expect(page.goto).not.toHaveBeenCalled();
      await service.disconnect();
    }
  );

  it.each([
    ['view-source:http://localhost:4242/connections', 'dorkos_origin'],
    ['view-source:https://fixture.ngrok.app/', 'dorkos_origin'],
    ['view-source:https://cloud.dorkos.ai/', 'cloud_origin'],
    ['file:///Users/someone/.dork/page.html', 'unsupported_address'],
  ])('never reads a tab already showing %s', async (url, code) => {
    const { service, navigate, page } = await create(origins);
    await selectOwned(service);
    navigate(url);
    vi.mocked(page.evaluateHandle).mockClear();
    await expect(service.observe()).rejects.toMatchObject({ code });
    await expect(service.screenshot()).rejects.toMatchObject({ code });
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  it.each(['frameattached', 'framedetached', 'framenavigated'])(
    'fails a screenshot when a sub-frame event %s lands during it',
    async (event) => {
      const { service, page, events, pixels } = await create(origins);
      await selectOwned(service);
      vi.mocked(page.screenshot).mockImplementationOnce(async () => {
        events.emit(event, {});
        return Buffer.from(pixels);
      });
      await expect(service.screenshot()).rejects.toMatchObject({ code: 'stale_page' });
      await service.disconnect();
    }
  );

  it('fails an observation when a frame came and went during it', async () => {
    const { service, locator, events } = await create(origins);
    await selectOwned(service);
    locator.ariaSnapshot.mockImplementationOnce(async () => {
      events.emit('frameattached', {});
      events.emit('framedetached', {});
      return '- button "Save"';
    });
    await expect(service.observe()).rejects.toMatchObject({ code: 'stale_page' });
    await service.disconnect();
  });

  it('checks live origins rather than the set at connection time', async () => {
    const live: string[] = [];
    const { service, page } = await create(() => live);
    await selectOwned(service);
    const observed = await service.observe();
    live.push('https://new-tunnel.example');
    await expect(
      service.action({
        kind: 'navigate',
        url: 'https://new-tunnel.example/connections',
        revision: observed.revision,
      })
    ).rejects.toMatchObject(refused);
    expect(page.goto).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('pauses after a click redirects to DorkOS and refuses all later reads', async () => {
    const { service, click, navigate, page } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    click.mockImplementationOnce(async () => {
      navigate('http://localhost:4242/connections');
    });
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    vi.mocked(page.evaluateHandle).mockClear();
    await expect(service.agentState()).rejects.toMatchObject(refused);
    await expect(service.observe()).rejects.toMatchObject(refused);
    await expect(service.screenshot()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('refuses a page framing DorkOS before observing it', async () => {
    const { service, addFrame, page } = await create(origins);
    await selectOwned(service);
    addFrame('https://fixture.ngrok.app/settings');
    await expect(service.observe()).rejects.toMatchObject(refused);
    expect(page.evaluateHandle).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('refuses acting on DorkOS even with a stale observation', async () => {
    const { service, navigate, click } = await create(origins);
    await selectOwned(service);
    const observed = await service.observe();
    navigate('http://localhost:4242/connections');
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(click).not.toHaveBeenCalled();
    await service.disconnect();
  });

  it('rechecks origins after the audit wait, before any page effect', async () => {
    const f = await create();
    const live: string[] = [];
    const service = trackedPageSession(
      f.dir,
      undefined,
      f.backend,
      async (record) => {
        if (record.phase === 'started') live.push('http://fixture.test');
      },
      () => ({ platform: 'darwin' }),
      undefined,
      () => live
    );
    await selectOwned(service);
    const observed = await service.observe();
    await expect(
      service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject(refused);
    expect(f.click).not.toHaveBeenCalled();
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });

  it('checks a replacement tab before returning its state to an agent', async () => {
    const { service, context, page } = await create(origins);
    const other = fixture();
    other.navigate('http://localhost:4242/connections');
    vi.spyOn(context, 'pages').mockReturnValue([page, other.page]);
    await service.open({ mode: 'new-window' });
    vi.spyOn(page, 'isClosed').mockReturnValue(true);
    await expect(service.agentState()).rejects.toMatchObject(refused);
    expect((await service.state()).paused).toBe(true);
    await service.disconnect();
  });
});
