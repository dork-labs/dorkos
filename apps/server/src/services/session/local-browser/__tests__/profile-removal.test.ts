import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { BrowserProfileRemoval } from '../profile-removal/index.js';
import { createLocalBrowserProfileStore } from '../profile-store.js';
import { prepareProfileFolder } from '../profile-folders.js';
import { LocalBrowserService } from '../service.js';

describe('whole-profile disk removal (DOR-3887)', () => {
  let home: string;
  const store = () => {
    const key = randomBytes(32);
    return createLocalBrowserProfileStore(createTestDb(), () => key);
  };
  const removal = () =>
    new BrowserProfileRemoval({
      dataDirectory: () => home,
      busy: () => false,
    });
  const seed = async (folder: string) => {
    for (const file of [
      'Default/Network/Cookies',
      'Default/Local Storage/leveldb/site.ldb',
      'Default/IndexedDB/site/data',
      'Default/Service Worker/CacheStorage/data',
      'storage-state.json',
    ]) {
      const target = path.join(folder, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'made-up-site-session');
    }
  };
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dorkos-profile-forget-'));
    await mkdir(path.join(home, 'home'));
    await mkdir(path.join(home, 'claude'));
    vi.stubEnv('DORK_HOME', home);
    vi.stubEnv('HOME', path.join(home, 'home'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, 'claude'));
    vi.stubEnv('DORKOS_TEST_RUNTIME', 'true');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('forgets every storage type on disk, keeps the named profile and its agents, and reopens empty', async () => {
    const profiles = store();
    const profile = profiles.create('Example work');
    profiles.bind(profile.id, 'made-up-agent', '/made-up/folder');
    const folder = await prepareProfileFolder(home, profile.id);
    await seed(folder);
    await removal().forget(profile.id);
    await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(profiles.get(profile.id)?.agentIds).toEqual(['made-up-agent']);
    await prepareProfileFolder(home, profile.id);
    await expect(readFile(path.join(folder, 'storage-state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(path.join(folder, 'Default/Network/Cookies'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('forgets every profile at once: the default and each named one (DOR-4105)', async () => {
    const profiles = store();
    const work = profiles.create('Example work');
    const personal = profiles.create('Example personal');
    const folders = [
      await prepareProfileFolder(home, null),
      await prepareProfileFolder(home, work.id),
      await prepareProfileFolder(home, personal.id),
    ];
    for (const folder of folders) await seed(folder);
    const forgotten: (string | null)[] = [];
    await new BrowserProfileRemoval({
      dataDirectory: () => home,
      busy: () => false,
      forgotten: (id) => forgotten.push(id),
    }).forgetAll([work.id, personal.id]);
    for (const folder of folders) {
      await expect(readFile(path.join(folder, 'storage-state.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(path.join(folder, 'Default/Network/Cookies'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    // The named profiles stay on record, emptied; the panel just no longer lists them.
    expect(profiles.get(work.id)).toBeDefined();
    expect(forgotten.sort()).toEqual([null, work.id, personal.id].sort());
  });

  it('clears nothing when any named profile is busy', async () => {
    const profiles = store();
    const work = profiles.create('Example work');
    const folder = await prepareProfileFolder(home, null);
    await seed(folder);
    await expect(
      new BrowserProfileRemoval({
        dataDirectory: () => home,
        busy: (id) => id === work.id,
      }).forgetAll([work.id])
    ).rejects.toMatchObject({ code: 'profile_busy' });
    expect(await readFile(path.join(folder, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
  });

  it('deletes the named profile, its bindings and folder without touching another profile', async () => {
    const profiles = store();
    const target = profiles.create('Example work');
    const other = profiles.create('Example personal');
    profiles.bind(target.id, 'made-up-agent', '/made-up/folder');
    const folder = await prepareProfileFolder(home, target.id);
    const kept = await prepareProfileFolder(home, other.id);
    await seed(folder);
    await seed(kept);
    await removal().delete(target.id, profiles);
    expect(profiles.get(target.id)).toBeUndefined();
    expect(profiles.isBound(target.id, 'made-up-agent', '/made-up/folder')).toBe(false);
    await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(kept, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
  });

  it('leaves no default cookie source or exported agent state that can restore forgotten sign-ins', async () => {
    const folder = await prepareProfileFolder(home, null);
    const older = path.join(home, 'local-browser/saved-logins');
    const cli = path.join(home, 'browser');
    await seed(folder);
    await seed(older);
    await seed(path.join(cli, 'profile'));
    await writeFile(
      path.join(cli, 'storage-state.json'),
      JSON.stringify({
        cookies: [{ name: 'made-up' }],
        origins: [{ origin: 'https://example.test' }],
      })
    );
    const preserved = await prepareProfileFolder(home, '11111111-1111-4111-8111-111111111111');
    await seed(preserved);
    await removal().forget(null);
    for (const target of [folder, older, cli])
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await prepareProfileFolder(home, null);
    await expect(stat(path.join(folder, 'Default/Network/Cookies'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(preserved, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
  });

  it('refuses an externally held profile and preserves both disk and bindings', async () => {
    if (process.platform === 'win32') return; // Windows lock ownership is tested by the bridge suite.
    const profiles = store();
    const profile = profiles.create('Example');
    profiles.bind(profile.id, 'made-up-agent', '/made-up/folder');
    const folder = await prepareProfileFolder(home, profile.id);
    await seed(folder);
    await symlink(`fixture-${process.pid}`, path.join(folder, 'SingletonLock'));
    await expect(removal().delete(profile.id, profiles)).rejects.toMatchObject({
      code: 'profile_busy',
    });
    expect(profiles.get(profile.id)?.agentIds).toEqual(['made-up-agent']);
    expect(await readFile(path.join(folder, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
  });

  it('rejects traversal and redirected profile parents without deleting their contents', async () => {
    await expect(removal().forget('../home')).rejects.toThrow();
    await writeFile(path.join(home, 'home/kept'), 'kept');
    await symlink(
      path.join(home, 'home'),
      path.join(home, 'browser-profiles'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(removal().forget(null)).rejects.toMatchObject({ code: 'profile_busy' });
    expect(await readFile(path.join(home, 'home/kept'), 'utf8')).toBe('kept');
  });

  it('fences concurrent opens and sign-ins until disk removal and guest flushing finish', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service = new LocalBrowserService(home, { open: vi.fn(), forgetSignIns: () => gate });
    const pending = service.profileRemoval.forget(null);
    await expect(service.open({ mode: 'new-window' })).rejects.toMatchObject({ code: 'busy' });
    await expect(service.handover.signIn({ url: 'https://example.test/' })).rejects.toMatchObject({
      code: 'busy',
    });
    finish();
    await pending;
    expect(() => service.profileRemoval.assertAvailable()).not.toThrow();
  });

  it('refuses a parent symlink introduced while embedded sign-ins are being cleared', async () => {
    const folder = await prepareProfileFolder(home, null);
    await seed(folder);
    const outside = path.join(home, 'unrelated');
    await seed(path.join(outside, 'default'));
    const forgotten = vi.fn();
    const clearing = new BrowserProfileRemoval({
      dataDirectory: () => home,
      busy: () => false,
      forgotten,
      embedded: () => ({
        forgetSignIns: async () => {
          await rename(path.join(home, 'browser-profiles'), path.join(home, 'original-profiles'));
          await symlink(
            outside,
            path.join(home, 'browser-profiles'),
            process.platform === 'win32' ? 'junction' : 'dir'
          );
        },
      }),
    });
    await expect(clearing.forget(null)).rejects.toMatchObject({ code: 'profile_busy' });
    expect(await readFile(path.join(outside, 'default/storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
    expect(
      await readFile(path.join(home, 'original-profiles/default/storage-state.json'), 'utf8')
    ).toBe('made-up-site-session');
    expect(forgotten).not.toHaveBeenCalled();
    expect(() => clearing.assertAvailable()).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a live lock acquired while embedded sign-ins are being cleared',
    async () => {
      const folder = await prepareProfileFolder(home, null);
      await seed(folder);
      await mkdir(path.join(home, 'browser'), { recursive: true });
      await writeFile(path.join(home, 'browser/storage-state.json'), 'made-up-cli-session');
      const clearing = new BrowserProfileRemoval({
        dataDirectory: () => home,
        busy: () => false,
        embedded: () => ({
          forgetSignIns: async () => {
            await symlink(`fixture-${process.pid}`, path.join(folder, 'SingletonLock'));
          },
        }),
      });
      await expect(clearing.forget(null)).rejects.toMatchObject({ code: 'profile_busy' });
      expect(await readFile(path.join(folder, 'storage-state.json'), 'utf8')).toBe(
        'made-up-site-session'
      );
      expect(await readFile(path.join(home, 'browser/storage-state.json'), 'utf8')).toBe(
        'made-up-cli-session'
      );
    }
  );

  it('refuses while sign-in preparation or saving owns the profile', async () => {
    const service = new LocalBrowserService(home);
    const profiles = store();
    const { id } = profiles.create('Example work');
    let cancel!: (error: Error) => void;
    vi.spyOn(service, 'state').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          cancel = reject;
        })
    );
    const signingIn = service.handover.signIn({ url: 'https://example.test/', profileId: id });
    await expect(service.profileRemoval.delete(id, profiles)).rejects.toMatchObject({
      code: 'profile_busy',
    });
    expect(profiles.get(id)).toBeDefined();
    cancel(new Error('fixture cancelled before any browser launch'));
    await expect(signingIn).rejects.toThrow('fixture cancelled');
  });

  it('refuses while the older CLI window holds its source profile, preserving its exported state', async () => {
    if (process.platform === 'win32') return;
    const cli = path.join(home, 'browser');
    await seed(path.join(cli, 'profile'));
    await writeFile(path.join(cli, 'storage-state.json'), 'made-up-cli-session');
    await symlink(`fixture-${process.pid}`, path.join(cli, 'profile/SingletonLock'));
    await expect(removal().forget(null)).rejects.toMatchObject({ code: 'profile_busy' });
    expect(await readFile(path.join(cli, 'storage-state.json'), 'utf8')).toBe(
      'made-up-cli-session'
    );
  });

  it('preserves the record and reports a partial failure when guest cleanup fails', async () => {
    const service = new LocalBrowserService(home, {
      open: vi.fn(),
      forgetSignIns: async () => {
        throw Error('disk unavailable');
      },
    });
    const folder = await prepareProfileFolder(home, null);
    await seed(folder);
    await expect(service.profileRemoval.forget(null)).rejects.toMatchObject({
      code: 'sign_ins_partial',
    });
    expect(await readFile(path.join(folder, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
  });

  it('keeps the profile and agent bindings retryable when disk deletion fails', async () => {
    const profiles = store();
    const profile = profiles.create('Example work');
    profiles.bind(profile.id, 'made-up-agent', '/made-up/folder');
    const folder = await prepareProfileFolder(home, profile.id);
    await seed(folder);
    const failing = new BrowserProfileRemoval({
      dataDirectory: () => home,
      busy: () => false,
      remove: async () => {
        throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
      },
    });
    await expect(failing.delete(profile.id, profiles)).rejects.toMatchObject({
      code: 'sign_ins_partial',
    });
    expect(profiles.isBound(profile.id, 'made-up-agent', '/made-up/folder')).toBe(true);
    expect(await readFile(path.join(folder, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
  });

  it('fails closed on a profile lock whose owner cannot be established', async () => {
    if (process.platform === 'win32') return;
    const folder = await prepareProfileFolder(home, null);
    await seed(folder);
    await writeFile(path.join(folder, 'SingletonLock'), 'unreadable-owner');
    await expect(removal().forget(null)).rejects.toMatchObject({ code: 'profile_busy' });
    expect(await readFile(path.join(folder, 'storage-state.json'), 'utf8')).toBe(
      'made-up-site-session'
    );
  });
});
