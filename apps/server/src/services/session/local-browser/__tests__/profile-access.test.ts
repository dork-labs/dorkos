import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentBrowserProfileAgents, eq, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { createLocalBrowserProfileAccess } from '../profile-access.js';
import { loadProfileBindingKey, prepareProfileFolder } from '../profile-folders.js';
import { createLocalBrowserProfileStore } from '../profile-store.js';

describe('who may use a named browser profile', () => {
  const profiles = {
    isBound: vi.fn((_profile: string, agent: string, _folder: string) => agent === 'bound'),
  };
  const deps = (
    runtime: { type: string; bound: boolean },
    agentPath: string | null,
    id?: string,
    folder: string | undefined = agentPath ?? undefined
  ) =>
    createLocalBrowserProfileAccess({
      profiles,
      resolveSessionRuntime: async () => runtime,
      getSessionAgentPath: async () => agentPath,
      agentIdAtPath: () => id,
      realFolder: () => folder,
    });
  const claude = { type: 'claude-code', bound: true };

  it('lets a bound agent through, checking its real folder', async () => {
    await expect(
      deps(claude, '/agents/link', 'bound', '/agents/real')('p', 's')
    ).resolves.toBeUndefined();
    expect(profiles.isBound).toHaveBeenLastCalledWith('p', 'bound', '/agents/real');
  });

  it('refuses an agent a person did not add', async () => {
    await expect(deps(claude, '/agents/b', 'other')('p', 's')).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
  });

  it.each([
    [null, undefined],
    ['/not/registered', undefined],
  ])('refuses a chat with no verified agent (%s)', async (agentPath, id) => {
    await expect(deps(claude, agentPath, id)('p', 's')).rejects.toMatchObject({
      code: 'profile_not_allowed',
    });
  });

  it('refuses an agent whose folder is gone', async () => {
    const access = createLocalBrowserProfileAccess({
      profiles,
      resolveSessionRuntime: async () => claude,
      getSessionAgentPath: async () => '/agents/a',
      agentIdAtPath: () => 'bound',
      realFolder: () => undefined,
    });
    await expect(access('p', 's')).rejects.toMatchObject({ code: 'profile_not_allowed' });
  });

  it.each([
    [{ type: 'codex', bound: true }],
    [{ type: 'opencode', bound: true }],
    // A runtime only inferred, never launched, is not proof of how the agent runs.
    [{ type: 'claude-code', bound: false }],
  ])('refuses %o even when the agent is bound', async (runtime) => {
    await expect(deps(runtime, '/agents/a', 'bound')('p', 's')).rejects.toMatchObject({
      code: 'profile_runtime',
    });
  });
});

describe('the profile records', () => {
  const FOLDER = '/agents/atlas';
  let db: Db;
  let store: ReturnType<typeof createLocalBrowserProfileStore>;
  beforeEach(() => {
    db = createTestDb();
    const key = randomBytes(32);
    store = createLocalBrowserProfileStore(db, () => key);
  });

  it('starts a profile with no agents, under a server-chosen id', () => {
    const profile = store.create('Work');
    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(profile.agentIds).toEqual([]);
    expect(store.isBound(profile.id, 'a', FOLDER)).toBe(false);
  });

  it('binds and unbinds one agent without touching another', () => {
    const profile = store.create('Work');
    store.bind(profile.id, 'a', FOLDER);
    store.bind(profile.id, 'a', FOLDER);
    store.bind(profile.id, 'b', '/agents/b');
    expect(store.isBound(profile.id, 'a', FOLDER)).toBe(true);
    store.unbind(profile.id, 'a');
    expect(store.isBound(profile.id, 'a', FOLDER)).toBe(false);
    expect(store.get(profile.id)?.agentIds).toEqual(['b']);
    expect(store.list()).toHaveLength(1);
  });

  it('does not let a binding on one profile reach another', () => {
    const work = store.create('Work');
    const home = store.create('Home');
    store.bind(work.id, 'a', FOLDER);
    expect(store.isBound(home.id, 'a', FOLDER)).toBe(false);
  });

  describe('a binding written straight into the database', () => {
    const insert = (profileId: string, agentId: string, signature: string, createdAt = 'now') =>
      db
        .insert(agentBrowserProfileAgents)
        .values({ profileId, agentId, createdAt, signature })
        .run();
    const signatureOf = (agentId: string) =>
      db
        .select()
        .from(agentBrowserProfileAgents)
        .where(eq(agentBrowserProfileAgents.agentId, agentId))
        .get()!;

    it('refuses one with no real signature', () => {
      const profile = store.create('Work');
      insert(profile.id, 'mallory', '');
      expect(store.isBound(profile.id, 'mallory', '/agents/mallory')).toBe(false);
      insert(store.create('Home').id, 'mallory', 'a'.repeat(64));
      expect(store.isBound(profile.id, 'mallory', '/agents/mallory')).toBe(false);
    });

    it('refuses another agent’s signature copied onto its row', () => {
      const profile = store.create('Work');
      store.bind(profile.id, 'atlas', FOLDER);
      const copied = signatureOf('atlas');
      insert(profile.id, 'mallory', copied.signature, copied.createdAt);
      expect(store.isBound(profile.id, 'mallory', FOLDER)).toBe(false);
      expect(store.isBound(profile.id, 'mallory', '/agents/mallory')).toBe(false);
    });

    it('refuses a signature copied from another profile', () => {
      const work = store.create('Work');
      const home = store.create('Home');
      store.bind(work.id, 'atlas', FOLDER);
      const copied = signatureOf('atlas');
      insert(home.id, 'atlas', copied.signature, copied.createdAt);
      expect(store.isBound(home.id, 'atlas', FOLDER)).toBe(false);
    });
  });

  it('refuses a binding once its agent’s real folder changes', () => {
    const profile = store.create('Work');
    store.bind(profile.id, 'atlas', FOLDER);
    expect(store.isBound(profile.id, 'atlas', '/somewhere/else')).toBe(false);
  });

  it('voids every binding when the key changes', () => {
    let key = randomBytes(32);
    const keyed = createLocalBrowserProfileStore(db, () => key);
    const profile = keyed.create('Work');
    keyed.bind(profile.id, 'atlas', FOLDER);
    key = randomBytes(32);
    expect(keyed.isBound(profile.id, 'atlas', FOLDER)).toBe(false);
  });
});

describe('profile folders', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dorkos-profiles-'));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('keeps each profile under browser-profiles, private to this user', async () => {
    const folder = await prepareProfileFolder(home, 'abc');
    expect(folder).toBe(path.join(home, 'browser-profiles', 'abc'));
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(folder))).mode & 0o777).toBe(0o700);
  });

  it('tightens a profiles folder that already exists too open', async () => {
    await mkdir(path.join(home, 'browser-profiles'), { recursive: true, mode: 0o755 });
    await prepareProfileFolder(home, 'abc');
    expect((await stat(path.join(home, 'browser-profiles'))).mode & 0o777).toBe(0o700);
  });

  it('moves older saved sign-ins into the default profile once', async () => {
    const older = path.join(home, 'local-browser', 'saved-logins');
    await mkdir(older, { recursive: true });
    await writeFile(path.join(older, 'Cookies'), 'kept');
    const folder = await prepareProfileFolder(home, null);
    expect(await readFile(path.join(folder, 'Cookies'), 'utf8')).toBe('kept');
    await expect(stat(older)).rejects.toThrow();
    // An older folder that reappears later never replaces the default profile.
    await mkdir(older, { recursive: true });
    await writeFile(path.join(older, 'Cookies'), 'stale');
    await prepareProfileFolder(home, null);
    expect(await readFile(path.join(folder, 'Cookies'), 'utf8')).toBe('kept');
  });

  it('never gives older sign-ins to a named profile', async () => {
    const older = path.join(home, 'local-browser', 'saved-logins');
    await mkdir(older, { recursive: true });
    await prepareProfileFolder(home, 'abc');
    expect((await stat(older)).isDirectory()).toBe(true);
  });

  it('keeps one signing key, readable only by this user', async () => {
    const key = loadProfileBindingKey(home);
    expect(key).toHaveLength(32);
    expect(loadProfileBindingKey(home).equals(key)).toBe(true);
    const file = path.join(home, 'browser-profiles', '.binding-key');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('replaces a damaged key, which voids old bindings', async () => {
    const key = loadProfileBindingKey(home);
    await writeFile(path.join(home, 'browser-profiles', '.binding-key'), 'short');
    expect(loadProfileBindingKey(home).equals(key)).toBe(false);
  });
});
