import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fixture,
  trackedPageSession,
  directories,
  create,
  withHistory,
  selectOwned,
} from './service.fixtures.js';
import { LocalBrowserPageSession } from '../../leases/page-session.js';
import { localBrowserRefusalNext } from '@dorkos/shared/local-browser-refusal';

// DOR-4192: a page with two <body> elements locked the agent out of its tab.
describe('a page with two bodies, and leaving a page the agent can’t read', () => {
  it('reads every body, in order, and acts on it', async () => {
    const f = await create();
    await f.service.open({ mode: 'new-window', sessionId: 'chat-one' });
    f.addBody('- link "Made-up second body"');
    const observed = await f.service.observe();
    expect(observed.snapshot).toBe('- button "Save"\n- link "Made-up second body"');
    await expect(
      f.service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).resolves.toBeDefined();
    const again = await f.service.observe();
    await expect(
      f.service.action({ kind: 'press', key: 'Enter', revision: again.revision })
    ).resolves.toBeDefined();
    await f.service.disconnect();
  });

  it('navigates away after a read fails, and still refuses a click on the old read', async () => {
    const f = await create();
    await f.service.open({ mode: 'new-window', sessionId: 'chat-one' });
    const old = await f.service.observe();
    f.locator.ariaSnapshot.mockRejectedValueOnce(new Error('made-up unreadable page'));
    await expect(f.service.observe()).rejects.toThrow();
    await f.service.action({
      kind: 'navigate',
      url: 'https://made-up.example/',
      revision: old.revision,
    });
    expect(f.page.goto).toHaveBeenCalledWith('https://made-up.example/', expect.anything());
    await expect(
      f.service.action({ kind: 'click', role: 'button', name: 'Save', revision: old.revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    await f.service.disconnect();
  });

  it('still refuses leaving while the agent is paused', async () => {
    const f = await create();
    await f.service.open({ mode: 'new-window', sessionId: 'chat-one' });
    const old = await f.service.observe();
    await f.service.pause();
    await expect(
      f.service.action({
        kind: 'navigate',
        url: 'https://made-up.example/',
        revision: old.revision,
      })
    ).rejects.toMatchObject({ code: 'paused' });
    expect(f.page.goto).not.toHaveBeenCalled();
    await f.service.disconnect();
  });

  it.each([
    ['DorkOS itself', 'http://localhost:4242/connections', 'dorkos_origin'],
    ['DorkOS Cloud', 'https://cloud.dorkos.ai/', 'cloud_origin'],
    ['a local file', 'file:///etc/hosts', 'unsupported_address'],
  ])('still checks where it goes: refuses %s', async (_where, url, code) => {
    const f = await create(() => ['http://localhost:4242']);
    await f.service.open({ mode: 'new-window', sessionId: 'chat-one' });
    const old = await f.service.observe();
    f.locator.ariaSnapshot.mockRejectedValueOnce(new Error('made-up unreadable page'));
    await expect(f.service.observe()).rejects.toThrow();
    await expect(
      f.service.action({ kind: 'navigate', url, revision: old.revision })
    ).rejects.toMatchObject({ code });
    expect(f.page.goto).not.toHaveBeenCalled();
    await f.service.disconnect();
  });
});

it('detaches the embedded guest during a handoff and makes a fresh connection on hand-back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'embedded-handoff-'));
  directories.push(dir);
  const f = fixture();
  const bridge = {
    endpoint: 'ws://127.0.0.1:9876/page/guest',
    headers: {},
    close: vi.fn(async () => undefined),
    detach: vi.fn(async () => {
      f.browserEvents.emit('disconnected');
    }),
    reattach: vi.fn(async () => undefined),
  };
  const service = trackedPageSession(dir, { open: async () => bridge }, f.backend);
  await service.open({ mode: 'embedded', sessionId: 'chat-1' });
  service.handover.useOutsideTurnCheck(async () => null);
  const { handoffId } = await service.handover.ask('chat-1', 'wall');
  expect(bridge.detach).toHaveBeenCalledOnce();
  expect(bridge.close).not.toHaveBeenCalled();
  expect(await service.state()).toMatchObject({ status: 'connected', paused: true });
  // The agent's reads during the handoff get the agent's words; the person's keep theirs (DOR-4678).
  for (const read of [() => service.observe(), () => service.screenshot()]) {
    const error = (await read().catch((caught: unknown) => caught)) as { message: string };
    expect(error).toMatchObject({ code: 'paused' });
    expect(error.message).toContain('only a person can resume it');
  }
  await expect(service.navigate('https://a.example/')).rejects.toMatchObject({
    code: 'paused',
    message: 'Your agent is paused. Resume it to continue.',
  });
  f.page.title = vi.fn(async () => 'A private title');
  await service.state();
  expect(f.page.title).not.toHaveBeenCalled();
  await service.handover.handBack(handoffId);
  expect(bridge.reattach).toHaveBeenCalledOnce();
  expect(f.backend.connect).toHaveBeenCalledTimes(2);
  expect((await service.state()).paused).toBe(false);
  await service.disconnect();
});

it('leaves the embedded guest detached after Stop', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'embedded-stop-'));
  directories.push(dir);
  const f = fixture();
  const bridge = {
    endpoint: 'ws://127.0.0.1:9876/page/guest',
    headers: {},
    close: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    reattach: vi.fn(async () => undefined),
  };
  const service = trackedPageSession(dir, { open: async () => bridge }, f.backend);
  await service.open({ mode: 'embedded', sessionId: 'chat-1' });
  service.handover.useOutsideTurnCheck(async () => null);
  const { handoffId } = await service.handover.ask('chat-1', 'password');
  await service.handover.stop(handoffId);
  expect(bridge.detach).toHaveBeenCalledOnce();
  expect(bridge.reattach).not.toHaveBeenCalled();
  expect(f.backend.connect).toHaveBeenCalledTimes(1);
  expect((await service.state()).paused).toBe(true);
  await service.disconnect();
});

it('retries a failed native detach before publishing a handoff', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'embedded-retry-'));
  directories.push(dir);
  const f = fixture();
  const bridge = {
    endpoint: 'ws://127.0.0.1:9876/page/guest',
    headers: {},
    close: vi.fn(async () => undefined),
    detach: vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('host did not acknowledge')),
    reattach: vi.fn(async () => undefined),
  };
  const service = trackedPageSession(dir, { open: async () => bridge }, f.backend);
  await service.open({ mode: 'embedded', sessionId: 'chat-1' });
  service.handover.useOutsideTurnCheck(async () => null);
  await expect(service.handover.ask('chat-1', 'wall')).rejects.toThrow('host did not acknowledge');
  expect((await service.handover.state()).handoff).toBeNull();
  await service.handover.ask('chat-1', 'wall');
  expect(bridge.detach).toHaveBeenCalledTimes(2);
  await service.disconnect();
});

describe('Back and Forward (DOR-4449)', () => {
  it('says which ways have a page, counting only pages the rules allow', async () => {
    const f = await create(() => ['http://localhost:4242']);
    await f.service.open({ mode: 'new-window' });
    withHistory(
      f,
      ['about:blank', 'http://localhost:4242/', 'https://a.example/', 'https://b.example/'],
      2
    );
    const tab = (await f.service.state()).tabs[0]!;
    expect(tab).toMatchObject({ canGoBack: true, canGoForward: true });
    await f.service.stepHistory('back');
    // Back skipped DorkOS's own page and landed on the empty first page.
    expect(f.page.url()).toBe('about:blank');
    expect((await f.service.state()).tabs[0]).toMatchObject({
      canGoBack: false,
      canGoForward: true,
    });
  });

  it('in the Mac app, asks the app to move and passes its refusal on', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'embedded-history-'));
    directories.push(dir);
    const f = fixture();
    const bridge = {
      endpoint: 'ws://127.0.0.1:9876/page/guest',
      headers: {},
      close: vi.fn(async () => undefined),
      history: vi.fn(async () => ({
        index: 1,
        entries: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }],
      })),
      goToHistory: vi.fn(async () => 'refused' as const),
    };
    f.navigate('https://b.example/');
    const service = trackedPageSession(dir, { open: async () => bridge }, f.backend);
    await service.open({ mode: 'embedded' });
    expect((await service.state()).tabs[0]).toMatchObject({ canGoBack: true, canGoForward: false });
    await expect(service.stepHistory('back')).rejects.toMatchObject({ code: 'history_refused' });
    expect(bridge.goToHistory).toHaveBeenCalledWith(0, 'https://a.example/', expect.any(Array));
    await service.disconnect();
  });
});

// DOR-4097, DOR-4650: a site refusing the Agent browser reads as a refusal, so the
// agent stops and hands it to the person instead of reading or fighting the page.
describe('a page that refuses the Agent browser', () => {
  it('tells the agent a Google sign-in refusal is a stop, from the page text', async () => {
    const { service, navigate, change } = await create();
    await selectOwned(service);
    navigate('https://accounts.google.com/v3/signin/identifier?made=up');
    change(
      '- heading "Couldn’t sign you in" [level=1]\n- text: This browser or app may not be secure.'
    );
    const observed = await service.observe();
    expect(observed.refusal).toEqual({
      kind: 'sign-in',
      host: 'accounts.google.com',
      next: localBrowserRefusalNext('sign-in'),
    });
    await service.disconnect();
  });

  // DOR-4662: the reading uses the page's title, so a vendor's block title counts.
  it('reads a bot check from its title, naming the host from the address', async () => {
    const { service, navigate, change, page } = await create();
    await selectOwned(service);
    navigate('https://shop.example/cart');
    vi.spyOn(page, 'title').mockResolvedValue('Just a moment...');
    change('- heading "Verify you are human" [level=1]\n- text: Sign in at attacker.example');
    expect((await service.observe()).refusal).toEqual({
      kind: 'blocked',
      host: 'shop.example',
      next: localBrowserRefusalNext('blocked'),
    });
    await service.disconnect();
  });

  it('says nothing for bot-check words on an ordinary page', async () => {
    const { service, navigate, change, page } = await create();
    await selectOwned(service);
    navigate('https://support.apple.example/en-us/HT201559');
    vi.spyOn(page, 'title').mockResolvedValue('Force restart iPhone - Support');
    change('- heading "Force restart" [level=1]\n- text: Press and hold the side button.');
    expect((await service.observe()).refusal).toBeUndefined();
    await service.disconnect();
  });
});

// DOR-4097: the in-app handoff card learns of a refusal from DorkOS's own reading.
it('marks an in-app handoff refused only after DorkOS read the refusal itself', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'embedded-refused-'));
  directories.push(dir);
  const f = fixture();
  const bridge = {
    endpoint: 'ws://127.0.0.1:9876/page/guest',
    headers: {},
    close: vi.fn(async () => undefined),
    detach: vi.fn(async () => {
      f.browserEvents.emit('disconnected');
    }),
    reattach: vi.fn(async () => undefined),
  };
  const service = trackedPageSession(dir, { open: async () => bridge }, f.backend);
  await service.open({ mode: 'embedded', sessionId: 'chat-1' });
  service.handover.useOutsideTurnCheck(async () => null);
  f.navigate('https://accounts.google.com/v3/signin/rejected?made=up');
  f.change('- heading "Couldn’t sign you in" [level=1]');
  await service.observe();
  await service.handover.ask('chat-1', 'password');
  expect((await service.handover.state()).handoff).toMatchObject({
    site: 'accounts.google.com',
    refused: true,
  });
});

describe('browser-owned reload evidence (DOR-4816)', () => {
  async function open() {
    const f = await create();
    const bridge = {
      endpoint: 'ws://127.0.0.1:9876/page/guest',
      headers: {},
      close: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      reattach: vi.fn(async () => undefined),
    };
    const service = new LocalBrowserPageSession(f.dir, { open: async () => bridge }, f.backend);
    await service.open({ mode: 'embedded', sessionId: 'chat-1' });
    service.handover.useOutsideTurnCheck(async () => 'read_outside_text');
    f.change('');
    return { ...f, service, bridge };
  }

  function commit(f: Awaited<ReturnType<typeof open>>, url: string) {
    f.events.emit('request', {
      isNavigationRequest: () => true,
      frame: () => f.page.mainFrame(),
      url: () => url,
    });
    f.navigate(url);
  }

  function loop(f: Awaited<ReturnType<typeof open>>) {
    for (let index = 0; index < 4; index++) commit(f, 'https://shop.example/check');
  }

  it('returns a blocked reading without touching the unstable document', async () => {
    const f = await open();
    loop(f);
    vi.mocked(f.page.evaluateHandle).mockClear();
    const observed = await f.service.observe();
    expect(observed).toMatchObject({
      snapshot: '',
      url: 'https://shop.example/check',
      refusal: { kind: 'blocked', host: 'shop.example' },
    });
    expect(f.page.evaluateHandle).not.toHaveBeenCalled();
    await expect(
      f.service.action({ kind: 'click', role: 'button', name: 'Save', revision: observed.revision })
    ).rejects.toMatchObject({ code: 'stale_page' });
    expect(f.click).not.toHaveBeenCalled();
    await f.service.disconnect();
  });

  it.each(['stranger_chat', 'room_outside_words', 'outsider_turn'] as const)(
    'keeps the %s handoff gate closed even on a loop',
    async (reason) => {
      const f = await open();
      loop(f);
      await f.service.observe();
      f.service.handover.useOutsideTurnCheck(async () => reason);
      await expect(f.service.handover.ask('chat-1', 'wall')).rejects.toMatchObject({
        code: 'outside_turn',
        fields: { reason },
      });
      expect(f.bridge.detach).not.toHaveBeenCalled();
      await f.service.disconnect();
    }
  );

  it('rechecks the exact page after the handoff gate awaits browser state', async () => {
    const f = await open();
    loop(f);
    await f.service.observe();
    const state = f.service.state.bind(f.service);
    vi.spyOn(f.service, 'state').mockImplementationOnce(async () => {
      commit(f, 'https://shop.example/different-path');
      return state();
    });
    await expect(f.service.handover.ask('chat-1', 'wall')).rejects.toMatchObject({
      code: 'outside_turn',
    });
    expect(f.bridge.detach).not.toHaveBeenCalled();
    await f.service.disconnect();
  });

  it('offers one handoff and never reloads the page itself', async () => {
    const f = await open();
    loop(f);
    await f.service.observe();
    await f.service.handover.ask('chat-1', 'wall');
    await f.service.handover.ask('chat-1', 'wall').catch(() => undefined);
    expect(f.bridge.detach).toHaveBeenCalledOnce();
    expect(f.page.goto).not.toHaveBeenCalled();
    await f.service.disconnect();
  });
});
