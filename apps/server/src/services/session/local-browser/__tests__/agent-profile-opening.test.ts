import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { LocalBrowserService } from '../service.js';
import { createAgentBrowserProfiles } from '../agent-profiles/agent-profiles.js';
import { createLocalBrowserProfileStore } from '../profile-store.js';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setup(wireSelection = true) {
  const home = await mkdtemp(path.join(tmpdir(), 'dorkos-agent-open-'));
  homes.push(home);
  const events = new EventEmitter();
  const contextEvents = new EventEmitter();
  const cdp = {
    on: vi.fn(),
    send: vi.fn(async () => ({ currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] })),
    detach: vi.fn(async () => {}),
  };
  const page = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    isClosed: () => false,
    url: () => 'about:blank',
    title: async () => 'New tab',
    context: () => context,
  } as unknown as Page;
  const context = {
    on: contextEvents.on.bind(contextEvents),
    once: contextEvents.once.bind(contextEvents),
    pages: () => [page],
    close: vi.fn(async () => {}),
    newCDPSession: async () => cdp,
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as Browser;
  const backend = { launch: vi.fn(async () => context), connect: vi.fn(async () => browser) };
  const embedded = {
    open: vi.fn(async () => ({
      endpoint: 'ws://example.test',
      headers: {},
      close: vi.fn(async () => {}),
    })),
  };
  const profiles = createLocalBrowserProfileStore(createTestDb(), () => Buffer.alloc(32, 2));
  const selection = createAgentBrowserProfiles({
    profiles,
    resolveSessionRuntime: async () => ({ type: 'example', bound: true }),
    guardsOf: () => ({ protectedPaths: true }),
    getSessionAgentPath: async (id) => `/agents/${id}`,
    agentIdAtPath: (folder) => folder.split('/').at(-1),
    realFolder: (folder) => folder,
    agentName: (id) => id,
  });
  const service = new LocalBrowserService(home, embedded, backend, undefined, () => ({
    platform: 'darwin',
  }));
  if (wireSelection) service.useProfileSelection(selection.select);
  service.useProfileAccess(
    async () => {},
    (id) => !!profiles.get(id)
  );
  return { home, service, profiles, backend, embedded, context };
}

it('opens every agent request in its own window, never attaching the embedded bridge', async () => {
  const t = await setup();
  const personal = path.join(t.home, 'browser-profiles', 'default');
  await mkdir(personal, { recursive: true });
  await writeFile(path.join(personal, 'Cookies'), 'example-person-data');
  for (const sessionId of ['atlas', 'bolt']) {
    const result = await t.service.open({ mode: 'embedded', sessionId });
    expect(result.mode).toBe('new-window');
    expect(result.profile?.id).toBe(`agent-${sessionId}`);
    await expect(
      readFile(path.join(t.home, 'browser-profiles', `agent-${sessionId}`, 'Cookies'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(personal, 'Cookies'), 'utf8')).toBe('example-person-data');
    expect(t.backend.launch).toHaveBeenLastCalledWith(
      path.join(t.home, 'browser-profiles', `agent-${sessionId}`),
      expect.anything(),
      expect.anything(),
      null
    );
    await t.service.resume();
    await t.service.disconnect();
  }
  expect(t.embedded.open).not.toHaveBeenCalled();
});

it('keeps the person-alone embedded browser and existing saved data', async () => {
  const t = await setup();
  const folder = path.join(t.home, 'browser-profiles', 'default');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'Cookies'), 'example-person-data');
  const result = await t.service.open({ mode: 'embedded' });
  expect(result).toMatchObject({
    mode: 'embedded',
    profile: { id: 'default', label: 'Your browser' },
  });
  expect(t.embedded.open).toHaveBeenCalledOnce();
  expect(t.backend.launch).not.toHaveBeenCalled();
  expect(await readFile(path.join(folder, 'Cookies'), 'utf8')).toBe('example-person-data');
  await t.service.disconnect();
});

it('closes only its owned late launch before switching to a shared profile', async () => {
  const t = await setup();
  let finish!: (context: BrowserContext) => void;
  t.backend.launch.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const opening = t.service.open({ mode: 'embedded', sessionId: 'atlas' });
  const cancelled = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
  await vi.waitFor(() => expect(t.backend.launch).toHaveBeenCalledOnce());
  const closing = t.service.disconnect();
  finish(t.context);
  await closing;
  await cancelled;
  expect(t.context.close).toHaveBeenCalledOnce();
  t.profiles.bind('default', 'atlas', '/agents/atlas');
  const shared = await t.service.open({
    mode: 'embedded',
    sessionId: 'atlas',
    profileId: 'default',
  });
  expect(shared.mode).toBe('new-window');
  expect(t.backend.launch).toHaveBeenLastCalledWith(
    path.join(t.home, 'browser-profiles', 'default'),
    expect.anything(),
    expect.anything(),
    null
  );
  expect(t.embedded.open).not.toHaveBeenCalled();
  await t.service.disconnect();
});

it('owns setup while profile resolution is pending and cancels before launching anything', async () => {
  const t = await setup();
  const profile = { id: 'default', label: 'Your browser', agentId: null, agentName: null };
  let resolve!: (value: typeof profile) => void;
  const pending = new Promise<typeof profile>((done) => {
    resolve = done;
  });
  let first = true;
  t.service.useProfileSelection(async () => {
    if (first) {
      first = false;
      return pending;
    }
    return profile;
  });
  const opening = t.service.open({ mode: 'new-window' });
  const outcome = opening.then(
    () => ({ code: 'unexpected_success' }),
    (error: unknown) => error
  );
  try {
    await expect(t.service.open({ mode: 'embedded' })).rejects.toMatchObject({ code: 'busy' });
    await t.service.disconnect();
  } finally {
    resolve(profile);
  }
  expect(await outcome).toMatchObject({ code: 'cancelled' });
  expect(t.backend.launch).not.toHaveBeenCalled();
  expect(t.embedded.open).not.toHaveBeenCalled();
});

it('refuses agent opens when trusted profile selection is not wired', async () => {
  const t = await setup(false);
  await expect(t.service.open({ mode: 'embedded', sessionId: 'atlas' })).rejects.toMatchObject({
    code: 'profile_not_allowed',
  });
  expect(t.backend.launch).not.toHaveBeenCalled();
  expect(t.embedded.open).not.toHaveBeenCalled();
});
