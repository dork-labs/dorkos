import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { fakeLeasePage } from './page-leases-fixture.js';
import { productionBackend } from '../playwright-backend.js';
import { BrowserProfileConnections } from '../leases/profile-connection.js';
import { SignInWindow } from '../sign-in-window.js';
import type { PlainChromiumExit } from '../plain-chromium.js';

const edges = vi.hoisted(() => ({ heldWindowsLocks: new Set<string>() }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: (file: Parameters<typeof fs.existsSync>[0]) => {
      // Installation discovery only. Profile files and process locks use the real filesystem.
      const name = String(file).replaceAll('\\', '/');
      if (
        name === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ||
        name === '/opt/google/chrome/chrome' ||
        name.endsWith('/Google/Chrome/Application/chrome.exe')
      )
        return true;
      return fs.existsSync(file);
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      // Windows keeps this file open; its failed unlink is the OS lock boundary.
      if (edges.heldWindowsLocks.has(String(args[0])))
        throw Object.assign(new Error('Held lockfile'), { code: 'EPERM' });
      return fs.rmSync(...args);
    },
  };
});

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'agent-launch-'));
  if (process.platform === 'win32') vi.stubEnv('PROGRAMFILES', path.join(folder, 'installation'));
  await mkdir(path.join(folder, 'Default', 'Sessions'), { recursive: true });
  await writeFile(path.join(folder, 'Default', 'Sessions', 'Session_test'), 'saved tabs');
  await writeFile(path.join(folder, 'Default', 'Cookies'), 'saved cookies');
  await writeFile(
    path.join(folder, 'Default', 'Preferences'),
    JSON.stringify({
      session: { restore_on_startup: 1, other: 'keep' },
      profile: { name: 'Original', other: 'keep' },
    })
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  edges.heldWindowsLocks.clear();
  await rm(folder, { recursive: true, force: true });
});
const prefs = async () =>
  JSON.parse(await readFile(path.join(folder, 'Default', 'Preferences'), 'utf8'));

function windowFixture() {
  const pages: ReturnType<typeof fakeLeasePage>[] = [];
  const context = {
    pages: () => pages.filter(({ page }) => !page.isClosed()).map(({ page }) => page),
    newPage: vi.fn(async () => add('about:blank').page),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
  function add(url: string) {
    const next = fakeLeasePage(() => context, `page-${pages.length}`);
    next.navigate(url);
    pages.push(next);
    return next;
  }
  return { context, add };
}

it('writes restore-off before physical launch and removes only its startup page', async () => {
  const f = windowFixture();
  const startup = f.add('about:blank');
  vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (storage, options) => {
    expect(storage).toBe(folder);
    expect(options?.channel).toBe('chrome');
    expect(await prefs()).toMatchObject({
      session: { restore_on_startup: 5, other: 'keep' },
      credentials_enable_service: false,
      profile: { name: 'Agent · DorkOS', other: 'keep', password_manager_enabled: false },
    });
    expect(JSON.parse(await readFile(path.join(folder, 'Local State'), 'utf8'))).toMatchObject({
      profile: { info_cache: { Default: { name: 'Agent · DorkOS' } } },
    });
    expect(await readFile(path.join(folder, 'Default', 'Cookies'), 'utf8')).toBe('saved cookies');
    expect(await readFile(path.join(folder, 'Default', 'Sessions', 'Session_test'), 'utf8')).toBe(
      'saved tabs'
    );
    return f.context;
  });
  const context = await productionBackend.launch(
    folder,
    undefined,
    undefined,
    null,
    () => undefined
  );
  expect(startup.page.close).not.toHaveBeenCalled();
  const owned = await context.newPage();
  expect(owned).not.toBe(startup.page);
  expect(context.pages()).toEqual([owned]);
});

it.each(['physical', 'person'])('does not write or launch a held %s profile', async (kind) => {
  const original = await readFile(path.join(folder, 'Default', 'Preferences'), 'utf8');
  if (kind === 'physical') {
    if (process.platform === 'win32') {
      const lock = path.join(folder, 'lockfile');
      await writeFile(lock, 'held');
      edges.heldWindowsLocks.add(lock);
    } else {
      await symlink(`test-host-${process.pid}`, path.join(folder, 'SingletonLock'));
    }
  }
  const launch = vi
    .spyOn(chromium, 'launchPersistentContext')
    .mockRejectedValue(new Error('Unexpected launch'));
  await expect(
    productionBackend.launch(folder, undefined, undefined, null, () => {
      if (kind === 'person') throw new Error('held');
    })
  ).rejects.toThrow();
  expect(await readFile(path.join(folder, 'Default', 'Preferences'), 'utf8')).toBe(original);
  await expect(readFile(path.join(folder, 'Local State'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(launch).not.toHaveBeenCalled();
});

it('does not change restore or capture pages without owned-launch authority', async () => {
  const f = windowFixture();
  const startup = f.add('about:blank');
  vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue(f.context);
  const context = await productionBackend.launch(folder);
  await context.newPage();
  expect((await prefs()).session).toEqual({ restore_on_startup: 1, other: 'keep' });
  expect(startup.page.close).not.toHaveBeenCalled();
});

it.each([null, 'named-profile'])(
  'does not change or close profile %s while sign-in holds it',
  async (profileId) => {
    let held = false;
    let exit!: (value: PlainChromiumExit) => void;
    const exited = new Promise<PlainChromiumExit>((resolve) => {
      exit = resolve;
    });
    const quit = vi.fn(() => {
      held = false;
      exit({ code: 0, signal: null });
    });
    const signIns = new SignInWindow({
      executable: async () => '/fake/chrome',
      installedChrome: () => '/fake/chrome',
      held: () => held,
      lockOwner: () => 424242,
      spawner: () => {
        held = true;
        return { pid: 424242, exited, quit, forceQuit: quit };
      },
    });
    await signIns.start(folder, profileId, 'https://accounts.example.test/');
    expect(signIns.holds(folder)).toBe(true);
    const preferences = await readFile(path.join(folder, 'Default', 'Preferences'), 'utf8');
    const cookies = await readFile(path.join(folder, 'Default', 'Cookies'), 'utf8');
    const launch = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockRejectedValue(new Error('Unexpected launch'));
    const connection = new BrowserProfileConnections(productionBackend).forChat((target) =>
      signIns.holds(target)
    );
    try {
      await expect(connection.launch(folder)).rejects.toMatchObject({ code: 'profile_busy' });
      expect(launch).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      expect(signIns.holds(folder)).toBe(true);
      expect(await readFile(path.join(folder, 'Default', 'Preferences'), 'utf8')).toBe(preferences);
      expect(await readFile(path.join(folder, 'Default', 'Cookies'), 'utf8')).toBe(cookies);
    } finally {
      // End only the fake child this test created, after the held-profile assertions.
      quit();
      await exited;
    }
  }
);
