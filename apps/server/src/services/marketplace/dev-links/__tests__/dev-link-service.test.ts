/**
 * DevLinkService (DOR-2696 task 1.2): validation order, link, unlink,
 * reconcile, against a real filesystem in a temp folder.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { NotifyPluginsChanged } from '../../types.js';
import { MARKETPLACE_DEVLINK_PARKED_MARKER } from '@dorkos/shared/marketplace-schemas';
import { lex } from '../../../../../../../scripts/lib/code-only.mjs';
import {
  DevLinkService,
  type DevLinkApprovals,
  type DevLinkFs,
  type DevLinkReloads,
} from '../dev-link-service.js';
import { DevLinkError } from '../errors.js';
import { DevLinkWatcher, type DevLinkWatchListeners } from '../dev-link-watcher.js';
import { readDevLinks, updateDevLinks } from '../registry.js';
import { memoryConsentStore } from './memory-consent-store.js';

let base: string;
let home: string;
let work: string;
let approvals: DevLinkApprovals;
let onPluginsChanged: Mock<NotifyPluginsChanged>;
let refreshExtensions: Mock<() => void>;

/** Write a package folder: manifest, plugin.json, and optional extensions. */
async function writePackage(
  dir: string,
  opts: { name?: string; version?: string; type?: string; extensions?: string[] } = {}
): Promise<string> {
  const name = opts.name ?? 'flow';
  const version = opts.version ?? '1.0.0';
  await mkdir(path.join(dir, '.dork'), { recursive: true });
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name, version, type: opts.type ?? 'plugin', description: 'test' })
  );
  await writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version })
  );
  for (const id of opts.extensions ?? []) {
    const ext = path.join(dir, '.dork', 'extensions', id);
    await mkdir(ext, { recursive: true });
    await writeFile(
      path.join(ext, 'extension.json'),
      JSON.stringify({ id, name: id, version: '1.0.0' })
    );
    await writeFile(path.join(ext, 'index.ts'), 'export {}');
  }
  return dir;
}

function service(fs: Partial<DevLinkFs> = {}, reloads?: DevLinkReloads): DevLinkService {
  return new DevLinkService({
    consent: memoryConsentStore(),
    dorkHome: home,
    approvals: {
      read: () => structuredClone(approvals),
      write: (next) => {
        approvals = structuredClone(next);
      },
    },
    onPluginsChanged,
    refreshExtensions,
    boundary: () => base,
    fs,
    ...(reloads && { reloads }),
  });
}

/** The refusal a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<DevLinkError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DevLinkError) return err;
    throw err;
  }
  throw new Error('expected a DevLinkError');
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'devlink-service-')));
  home = path.join(base, 'dork-home');
  work = path.join(base, 'work', 'flow');
  await mkdir(path.join(home, 'plugins'), { recursive: true });
  await writePackage(work, { extensions: ['flow-dash'] });
  approvals = { approvedToRun: [], approvedSources: {} };
  onPluginsChanged = vi.fn<NotifyPluginsChanged>();
  refreshExtensions = vi.fn<() => void>();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const globalSlot = () => path.join(home, 'plugins', 'flow');

describe('DevLinkService.preview', () => {
  it('names the package, the slot, what it carries, and that nothing is replaced', async () => {
    // Purpose: the card shows exactly this; a wrong slot or missing extension
    // list would be a card that does not say what the yes covers.
    const preview = await service().preview({ path: work, scope: 'global' });
    expect(preview).toMatchObject({
      name: 'flow',
      type: 'plugin',
      version: '1.0.0',
      path: work,
      scope: 'global',
      slot: globalSlot(),
      replaces: null,
      extensions: ['flow-dash'],
    });
  });
});

describe('DevLinkService refusals', () => {
  it('refuses a path that is not its own real path, naming the real one', async () => {
    // Purpose: the card must name where the code actually lives.
    const alias = path.join(base, 'alias');
    await symlink(work, alias, 'dir');
    const err = await refusal(service().preview({ path: alias, scope: 'global' }));
    expect(err.code).toBe('dev_link_path_not_real');
    expect(err.details).toEqual({ realPath: work });
    expect(err.message).toBe(`That path is a link. Use ${work} instead.`);
  });

  it('refuses a relative path', async () => {
    // Purpose: a relative path resolves against the server's cwd, not the caller's.
    expect((await refusal(service().preview({ path: 'work/flow', scope: 'global' }))).code).toBe(
      'dev_link_path_not_real'
    );
  });

  it('refuses a folder that does not exist', async () => {
    // Purpose: nothing to link; say so plainly.
    const err = await refusal(
      service().preview({ path: path.join(base, 'nope'), scope: 'global' })
    );
    expect(err.code).toBe('dev_link_path_not_allowed');
  });

  it('refuses a folder outside the boundary', async () => {
    // Purpose: the boundary limits where DorkOS reaches on disk; a dev link
    // runs code from the folder, so it must stay inside.
    const svc = new DevLinkService({
      consent: memoryConsentStore(),
      dorkHome: home,
      approvals: { read: () => approvals, write: () => undefined },
      onPluginsChanged,
      refreshExtensions,
      boundary: () => path.join(base, 'somewhere-else'),
    });
    const err = await refusal(svc.preview({ path: work, scope: 'global' }));
    expect(err).toMatchObject({ code: 'dev_link_path_not_allowed', status: 403 });
  });

  it("refuses a folder inside DorkOS's own data", async () => {
    // Purpose: linking DorkOS's own records or an installed copy as a "working
    // folder" would let a link alias what DorkOS manages.
    const inside = await writePackage(path.join(home, 'stuff', 'flow'));
    const err = await refusal(service().preview({ path: inside, scope: 'global' }));
    expect(err).toMatchObject({ code: 'dev_link_path_not_allowed', status: 403 });
  });

  it('refuses a folder with no package in it', async () => {
    // Purpose: a dev link must know its name and type to pick a slot.
    const empty = path.join(base, 'empty');
    await mkdir(empty);
    const err = await refusal(service().preview({ path: empty, scope: 'global' }));
    expect(err).toMatchObject({
      code: 'dev_link_not_a_package',
      message: 'No package found in this folder.',
    });
  });

  it('refuses an agent package', async () => {
    // Purpose: agents and adapters load through other systems; v1 runs only
    // plugins and skill packs from a folder.
    const agent = await writePackage(path.join(base, 'work', 'scout'), {
      name: 'scout',
      type: 'agent',
    });
    const err = await refusal(service().preview({ path: agent, scope: 'global' }));
    expect(err).toMatchObject({ code: 'dev_link_unsupported_type' });
    expect(err.message).toContain('an agent');
  });

  it('refuses a second dev link for the same name and scope', async () => {
    // Purpose: one slot, one link; a second would orphan the first record.
    await service().link({ path: work, scope: 'global', via: 'app' });
    const other = await writePackage(path.join(base, 'work2', 'flow'));
    expect((await refusal(service().preview({ path: other, scope: 'global' }))).code).toBe(
      'dev_link_exists'
    );
  });

  it('refuses a slot that already links somewhere else', async () => {
    // Purpose: a hand-built link to another folder is someone's setup; never
    // replace it silently.
    const other = await writePackage(path.join(base, 'other', 'flow'));
    await symlink(other, globalSlot(), 'dir');
    expect((await refusal(service().preview({ path: work, scope: 'global' }))).code).toBe(
      'dev_link_slot_is_linked'
    );
  });

  it('refuses to link over an installed copy without the explicit switch', async () => {
    // Purpose: an installed copy is never replaced by a dev link's files
    // without the person ticking "use my folder instead".
    await writePackage(globalSlot(), { version: '0.9.2' });
    const preview = await service().preview({ path: work, scope: 'global' });
    expect(preview.replaces).toEqual({ version: '0.9.2' });
    const err = await refusal(service().link({ path: work, scope: 'global', via: 'app' }));
    expect(err).toMatchObject({ code: 'dev_link_slot_taken', status: 409 });
    expect(err.details).toMatchObject({ installedVersion: '0.9.2' });
    expect((await lstat(globalSlot())).isSymbolicLink()).toBe(false);
  });

  it('refuses while an earlier parked copy is still beside the slot', async () => {
    // Purpose: parking again would overwrite the only copy of the earlier one.
    await mkdir(`${globalSlot()}${MARKETPLACE_DEVLINK_PARKED_MARKER}`);
    expect((await refusal(service().preview({ path: work, scope: 'global' }))).code).toBe(
      'dev_link_parked_exists'
    );
  });

  it('refuses a project that does not exist', async () => {
    // Purpose: the slot lives in the project; a missing one is a typo.
    const err = await refusal(
      service().preview({ path: work, scope: 'project', projectPath: path.join(base, 'gone') })
    );
    expect(err.code).toBe('dev_link_project_not_found');
  });
});

describe('DevLinkService.link', () => {
  it('puts a link in the slot, records it, approves what it carries, and notifies', async () => {
    // Purpose: the four effects of a yes; missing any one leaves a link that
    // does not run, is not a dev link, or asks again.
    const status = await service().link({ path: work, scope: 'global', via: 'terminal' });
    expect(status).toMatchObject({ name: 'flow', state: 'active', path: work, parked: null });
    expect(await readlink(globalSlot())).toBe(work);
    const reading = await readDevLinks(home);
    expect('links' in reading && reading.links).toEqual([
      expect.objectContaining({
        name: 'flow',
        slot: globalSlot(),
        target: work,
        linkedVia: 'terminal',
      }),
    ]);
    expect(approvals.approvedToRun).toEqual(['flow-dash']);
    expect(approvals.approvedSources['flow-dash']).toEqual({
      path: path.join(globalSlot(), '.dork', 'extensions', 'flow-dash'),
      plugin: 'flow',
      devLink: work,
    });
    expect(onPluginsChanged).toHaveBeenCalledWith({ packageName: 'flow', action: 'install' });
    expect(refreshExtensions).toHaveBeenCalled();
  });

  it('links at project scope into the project slot', async () => {
    // Purpose: a project link must never land in the global slot.
    const project = path.join(base, 'proj');
    await mkdir(project);
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });
    expect(await readlink(path.join(project, '.dork', 'plugins', 'flow'))).toBe(work);
    expect(onPluginsChanged).toHaveBeenCalledWith({
      packageName: 'flow',
      action: 'install',
      projectPath: project,
    });
  });

  it('parks an installed copy byte-identical and keeps its approvals to restore', async () => {
    // Purpose: "set aside, not deleted" — and the yes the installed copy had
    // must come back with it.
    await writePackage(globalSlot(), { version: '0.9.2', extensions: ['flow-dash'] });
    const installedExt = path.join(globalSlot(), '.dork', 'extensions', 'flow-dash');
    approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': { path: installedExt, plugin: 'flow' } },
    };
    const before = readFileSync(path.join(globalSlot(), '.dork', 'manifest.json'), 'utf-8');

    const status = await service().link({
      path: work,
      scope: 'global',
      replaceInstalled: true,
      via: 'app',
    });

    const parked = `${globalSlot()}${MARKETPLACE_DEVLINK_PARKED_MARKER}`;
    expect(await readFile(path.join(parked, '.dork', 'manifest.json'), 'utf-8')).toBe(before);
    expect(
      await readFile(path.join(parked, '.dork', 'extensions', 'flow-dash', 'index.ts'), 'utf-8')
    ).toBe('export {}');
    expect(status.parked).toEqual({ version: '0.9.2' });
    const reading = await readDevLinks(home);
    expect('links' in reading && reading.links[0]).toMatchObject({
      parked,
      restoreApprovals: { extensions: { 'flow-dash': { path: installedExt, plugin: 'flow' } } },
    });
    expect(approvals.approvedSources['flow-dash']?.devLink).toBe(work);
  });

  it('puts the installed copy back when linking fails after it was parked', async () => {
    // Purpose: a failure half-way must never leave the installed copy hidden
    // under the parked name with nothing in the slot.
    await writePackage(globalSlot(), { version: '0.9.2' });
    const failing = service({
      symlink: async () => {
        throw new Error('no links here');
      },
    });
    await expect(
      failing.link({ path: work, scope: 'global', replaceInstalled: true, via: 'app' })
    ).rejects.toThrow('no links here');
    expect((await lstat(globalSlot())).isDirectory()).toBe(true);
    await expect(lstat(`${globalSlot()}${MARKETPLACE_DEVLINK_PARKED_MARKER}`)).rejects.toThrow();
    expect(await readDevLinks(home)).toEqual({ links: [] });
    expect(approvals.approvedToRun).toEqual([]);
  });

  it('links exactly what the card described, refusing a folder that changed since', async () => {
    // Purpose: the yes covers the extensions the card listed; an extension
    // added between the card and the link must not be approved with it.
    const svc = service();
    const shown = await svc.describeApproval({ path: work, scope: 'global' });
    expect(shown).toContain('Extensions it may run: flow-dash');
    const added = path.join(work, '.dork', 'extensions', 'sneaky');
    await mkdir(added, { recursive: true });
    await writeFile(path.join(added, 'extension.json'), '{"id":"sneaky"}');
    const err = await refusal(
      svc.link({ path: work, scope: 'global', via: 'agent-card', expectedChange: shown })
    );
    expect(err).toMatchObject({ code: 'dev_link_changed', status: 409 });
    await expect(lstat(globalSlot())).rejects.toThrow();
    expect(approvals.approvedToRun).toEqual([]);
  });

  it('refuses a folder whose card would be cut short, so nothing past the cut can be approved', async () => {
    // Purpose: a card stores 4,000 characters. Binding the approval to a cut
    // text let a folder padded past the cut gain one more extension (sorting
    // last) between the card and the retry with the token still matching.
    // The whole text is bound now, and a folder that does not fit is refused
    // before any card.
    for (let i = 0; i < 60; i++) {
      const id = `ext-${String(i).padStart(2, '0')}-${'x'.repeat(60)}`;
      const dir = path.join(work, '.dork', 'extensions', id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'extension.json'), JSON.stringify({ id }));
    }
    const svc = service();
    const err = await refusal(svc.describeApproval({ path: work, scope: 'global' }));
    expect(err).toMatchObject({ code: 'dev_link_card_too_long', status: 400 });

    // Even a caller holding text cut at the card's limit cannot link the
    // folder once it gains a last-sorting extension.
    const cut = (await svc.preview({ path: work, scope: 'global' })).extensions.join(', ');
    expect(cut.length).toBeGreaterThan(4000);
    const late = path.join(work, '.dork', 'extensions', 'zzz-late');
    await mkdir(late, { recursive: true });
    await writeFile(path.join(late, 'extension.json'), '{"id":"zzz-late"}');
    const stale = `Folder: ${work}\n`.padEnd(4000, 'x');
    expect(
      (
        await refusal(
          svc.link({ path: work, scope: 'global', via: 'agent-card', expectedChange: stale })
        )
      ).code
    ).toBe('dev_link_changed');
    await expect(lstat(globalSlot())).rejects.toThrow();
    expect(approvals.approvedToRun).toEqual([]);
  });

  it('refuses to link a plugin into its own folder', async () => {
    // Purpose: <repo>/.dork/plugins/<name> pointing at <repo> is a loop every
    // scanner would follow, finding each extension twice.
    const err = await refusal(
      service().preview({ path: work, scope: 'project', projectPath: work })
    );
    expect(err).toMatchObject({ code: 'dev_link_path_not_allowed', status: 400 });
    expect(err.message).toContain("can't be linked into itself");
  });

  it('rolls back when the link in the slot does not resolve to the approved folder', async () => {
    // Purpose: nothing is recorded or approved for a slot that points anywhere
    // but the folder the person approved.
    await writePackage(globalSlot(), { version: '0.9.2' });
    const elsewhere = await writePackage(path.join(base, 'elsewhere', 'flow'));
    const crooked = service({
      symlink: async (_target, link, type) => symlink(elsewhere, link, type),
    });
    const err = await refusal(
      crooked.link({ path: work, scope: 'global', replaceInstalled: true, via: 'app' })
    );
    expect(err.code).toBe('dev_link_slot_is_linked');
    expect((await lstat(globalSlot())).isDirectory()).toBe(true);
    await expect(lstat(`${globalSlot()}${MARKETPLACE_DEVLINK_PARKED_MARKER}`)).rejects.toThrow();
    expect(await readDevLinks(home)).toEqual({ links: [] });
    expect(approvals.approvedToRun).toEqual([]);
  });

  it('adopts a link made by hand to the same folder without parking anything', async () => {
    // Purpose: `link` on a DOR-2194 hand-built link makes it a dev link in place.
    await symlink(work, globalSlot(), 'dir');
    const status = await service().link({ path: work, scope: 'global', via: 'app' });
    expect(status.state).toBe('active');
    expect(await readlink(globalSlot())).toBe(work);
    const reading = await readDevLinks(home);
    expect('links' in reading && reading.links[0]?.parked).toBeUndefined();
  });

  it('creates a junction on Windows', async () => {
    // Purpose: a symlink needs a privilege on Windows; a junction does not.
    const calls: unknown[][] = [];
    const svc = new DevLinkService({
      consent: memoryConsentStore(),
      dorkHome: home,
      approvals: { read: () => approvals, write: () => undefined },
      onPluginsChanged,
      refreshExtensions,
      boundary: () => base,
      platform: 'win32',
      fs: {
        symlink: async (...args: Parameters<typeof symlink>) => {
          calls.push(args);
          return symlink(args[0], args[1], 'dir');
        },
      },
    });
    await svc.link({ path: work, scope: 'global', via: 'app' });
    expect(calls[0]?.[2]).toBe('junction');
  });
});

describe('DevLinkService.unlink', () => {
  it("removes the link and leaves every file in the developer's folder", async () => {
    // Purpose: a recursive delete through a junction empties the working
    // folder. This fails if the link is removed with a recursive delete that
    // follows it.
    await service().link({ path: work, scope: 'global', via: 'app' });
    const result = await service().unlink({ name: 'flow', scope: 'global' });
    expect(result).toEqual({ restored: 'removed' });
    await expect(lstat(globalSlot())).rejects.toThrow();
    expect(
      await readFile(path.join(work, '.dork', 'extensions', 'flow-dash', 'index.ts'), 'utf-8')
    ).toBe('export {}');
    expect(await readDevLinks(home)).toEqual({ links: [] });
    expect(approvals).toEqual({ approvedToRun: [], approvedSources: {} });
    expect(onPluginsChanged).toHaveBeenLastCalledWith({ packageName: 'flow', action: 'uninstall' });
  });

  it('removes a link only with unlink or rmdir, never a recursive delete', () => {
    // Purpose: the same guarantee as a source pin, because on macOS and Linux a
    // recursive `rm` of a symlink happens to remove only the link and so the
    // behavioural test above cannot catch it; on Windows a junction is followed.
    const file = path.join(import.meta.dirname, '..', 'dev-link-service.ts');
    const { code: source, parseErrors } = lex(readFileSync(file, 'utf-8'), file);
    expect(parseErrors).toBe(0);
    expect(source).not.toMatch(/\brm(Sync)?\s*\(/);
    expect(source).not.toMatch(/\brmdir\([^)]*recursive/);
    expect(source).not.toMatch(/\bfs\.rm\b|\brm,|\{ rm\b/);
  });

  it('falls back to rmdir for a junction unlink refuses', async () => {
    // Purpose: an older Windows runtime answers EPERM to unlink on a junction;
    // the fallback must be the non-recursive rmdir.
    await service().link({ path: work, scope: 'global', via: 'app' });
    const rmdir = vi.fn(async (target: string) => {
      const { unlink } = await import('node:fs/promises');
      await unlink(target);
    });
    const svc = service({
      unlink: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
      rmdir: rmdir as unknown as DevLinkFs['rmdir'],
    });
    await svc.unlink({ name: 'flow', scope: 'global' });
    expect(rmdir).toHaveBeenCalledWith(globalSlot());
  });

  it('brings the installed copy and its approval back', async () => {
    // Purpose: unlinking restores the installed copy, and it must not be held
    // back or asked about again: its bytes never changed.
    await writePackage(globalSlot(), { version: '0.9.2', extensions: ['flow-dash'] });
    const installedApproval = {
      path: path.join(globalSlot(), '.dork', 'extensions', 'flow-dash'),
      plugin: 'flow',
    };
    approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': installedApproval },
    };
    await service().link({ path: work, scope: 'global', replaceInstalled: true, via: 'app' });

    const result = await service().unlink({ name: 'flow', scope: 'global' });
    expect(result).toEqual({ restored: 'installed' });
    expect((await lstat(globalSlot())).isDirectory()).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(globalSlot(), '.dork', 'manifest.json'), 'utf-8')).version
    ).toBe('0.9.2');
    expect(approvals).toEqual({
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': installedApproval },
    });
  });

  it('leaves an approval that has since moved to another copy alone', async () => {
    // Purpose: unlink forgets only the link's own approvals.
    await service().link({ path: work, scope: 'global', via: 'app' });
    approvals.approvedSources['flow-dash'] = { path: '/elsewhere/flow-dash' };
    await service().unlink({ name: 'flow', scope: 'global' });
    expect(approvals.approvedSources['flow-dash']).toEqual({ path: '/elsewhere/flow-dash' });
  });

  it('finishes from folder-missing, link-missing and link-replaced', async () => {
    // Purpose: unlink is the way out of every broken state, and it never
    // touches a slot that is no longer the recorded link.
    await service().link({ path: work, scope: 'global', via: 'app' });
    await rm(work, { recursive: true });
    expect((await service().list()).links[0]?.state).toBe('folder-missing');
    await service().unlink({ name: 'flow', scope: 'global' });
    await expect(lstat(globalSlot())).rejects.toThrow();

    await writePackage(work);
    await service().link({ path: work, scope: 'global', via: 'app' });
    await rm(globalSlot());
    expect((await service().list()).links[0]?.state).toBe('link-missing');
    expect(await service().unlink({ name: 'flow', scope: 'global' })).toEqual({
      restored: 'removed',
    });

    await service().link({ path: work, scope: 'global', via: 'app' });
    await rm(globalSlot());
    await writePackage(globalSlot(), { version: '2.0.0' });
    expect((await service().list()).links[0]?.state).toBe('link-replaced');
    await service().unlink({ name: 'flow', scope: 'global' });
    // The real folder someone put there is untouched.
    expect(
      JSON.parse(await readFile(path.join(globalSlot(), '.dork', 'manifest.json'), 'utf-8')).version
    ).toBe('2.0.0');
    expect(await readDevLinks(home)).toEqual({ links: [] });
  });

  it('leaves a parked copy in place when something else holds the slot, and its approval too', async () => {
    // Purpose: restoring would mean overwriting whatever is in the slot now;
    // and the installed copy's approval names the slot's path, so putting it
    // back would approve whatever someone put there instead.
    await writePackage(globalSlot(), { version: '0.9.2', extensions: ['flow-dash'] });
    const installedApproval = {
      path: path.join(globalSlot(), '.dork', 'extensions', 'flow-dash'),
      plugin: 'flow',
    };
    approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: { 'flow-dash': installedApproval },
    };
    await service().link({ path: work, scope: 'global', replaceInstalled: true, via: 'app' });
    await rm(globalSlot());
    await mkdir(globalSlot());
    const parked = `${globalSlot()}${MARKETPLACE_DEVLINK_PARKED_MARKER}`;
    expect(await service().unlink({ name: 'flow', scope: 'global' })).toEqual({
      restored: 'removed',
      parkedLeftAt: parked,
    });
    expect((await lstat(parked)).isDirectory()).toBe(true);
    expect(approvals).toEqual({ approvedToRun: [], approvedSources: {} });
  });

  it("does not put the installed copy's approval back when the parked copy is gone", async () => {
    // Purpose: with nothing restored, an approval naming the slot would wait
    // there for the next thing installed or linked into it.
    await writePackage(globalSlot(), { version: '0.9.2', extensions: ['flow-dash'] });
    approvals = {
      approvedToRun: ['flow-dash'],
      approvedSources: {
        'flow-dash': {
          path: path.join(globalSlot(), '.dork', 'extensions', 'flow-dash'),
          plugin: 'flow',
        },
      },
    };
    await service().link({ path: work, scope: 'global', replaceInstalled: true, via: 'app' });
    await rm(`${globalSlot()}${MARKETPLACE_DEVLINK_PARKED_MARKER}`, { recursive: true });
    expect(await service().unlink({ name: 'flow', scope: 'global' })).toEqual({
      restored: 'removed',
    });
    expect(approvals).toEqual({ approvedToRun: [], approvedSources: {} });
  });

  it('answers only one of two unlinks of the same link', async () => {
    // Purpose: the record is read again under the lock, so a second unlink
    // queued behind the first reports there is nothing left to unlink rather
    // than acting on a record that is gone.
    await service().link({ path: work, scope: 'global', via: 'app' });
    const results = await Promise.allSettled([
      service().unlink({ name: 'flow', scope: 'global' }),
      service().unlink({ name: 'flow', scope: 'global' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'dev_link_not_found' });
  });

  it('keeps an approval source that was never approved to run, without approving it', async () => {
    // Purpose: a source with no run approval is still a record of which copy
    // an id belongs to; dropping it loses that, and restoring it as approved
    // would approve something nobody approved.
    approvals = {
      approvedToRun: [],
      approvedSources: { 'flow-dash': { path: '/elsewhere/flow-dash' } },
    };
    await service().link({ path: work, scope: 'global', via: 'app' });
    await service().unlink({ name: 'flow', scope: 'global' });
    expect(approvals).toEqual({
      approvedToRun: [],
      approvedSources: { 'flow-dash': { path: '/elsewhere/flow-dash' } },
    });
  });

  it('forgets an approval given through a linked spelling of the project', async () => {
    // Purpose: discovery names a project the way it was opened, which can be a
    // symlink to the canonical folder the dev link records. An approval given
    // under that spelling is still this dev link's and must go with it.
    const project = path.join(base, 'proj');
    await mkdir(project);
    const alias = path.join(base, 'proj-alias');
    await symlink(project, alias, 'dir');
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });
    approvals.approvedSources['flow-dash'] = {
      path: path.join(alias, '.dork', 'plugins', 'flow', '.dork', 'extensions', 'flow-dash'),
      plugin: 'flow',
      devLink: work,
    };
    await service().unlink({ name: 'flow', scope: 'project', projectPath: project });
    expect(approvals).toEqual({ approvedToRun: [], approvedSources: {} });
  });

  it("does not strip another dev link's approval when the same folder is linked twice", async () => {
    // Purpose: a global link and a project link of one folder share its real
    // path; unlinking one must forget only the approval given inside its slot.
    const project = path.join(base, 'proj');
    await mkdir(project);
    await service().link({ path: work, scope: 'global', via: 'app' });
    await service().link({ path: work, scope: 'project', projectPath: project, via: 'app' });
    const projectApproval = approvals.approvedSources['flow-dash'];
    expect(projectApproval?.path).toBe(
      path.join(project, '.dork', 'plugins', 'flow', '.dork', 'extensions', 'flow-dash')
    );
    await service().unlink({ name: 'flow', scope: 'global' });
    expect(approvals.approvedSources['flow-dash']).toEqual(projectApproval);
    expect(approvals.approvedToRun).toEqual(['flow-dash']);

    // And unlinking the project link does not resurrect the global link's
    // approval it replaced, because that link is gone.
    await service().unlink({ name: 'flow', scope: 'project', projectPath: project });
    expect(approvals).toEqual({ approvedToRun: [], approvedSources: {} });
  });

  it('refuses a name with no dev link', async () => {
    // Purpose: a typo must not be reported as done.
    expect((await refusal(service().unlink({ name: 'flow', scope: 'global' }))).code).toBe(
      'dev_link_not_found'
    );
  });
});

describe('DevLinkService.list', () => {
  it('says the registry cannot be read instead of listing nothing', async () => {
    // Purpose: an unreadable file must be visible, never a silent empty list.
    await updateDevLinks(home, () => []);
    await writeFile(path.join(home, 'marketplace', 'dev-links.json'), 'nope');
    expect(await service().list()).toMatchObject({
      links: [],
      registryUnreadable: expect.any(String),
    });
  });
});

describe('DevLinkService and the hot-reload watcher', () => {
  /** A watcher stand-in that records the order of calls and what the slot held at each. */
  function recordingReloads() {
    const calls: string[] = [];
    const reloads: DevLinkReloads = {
      sync: vi.fn(async () => {
        calls.push(
          `sync:${await readDevLinks(home).then((r) => ('links' in r ? r.links.length : -1))}`
        );
      }),
      hold: vi.fn(async () => {
        const linked = await lstat(globalSlot()).then(
          (st) => st.isSymbolicLink(),
          () => false
        );
        calls.push(`hold:${linked ? 'linked' : 'gone'}`);
      }),
      release: vi.fn(async () => {
        const linked = await lstat(globalSlot()).then(
          (st) => st.isSymbolicLink(),
          () => false
        );
        calls.push(`release:${linked ? 'linked' : 'gone'}`);
      }),
      lastReloadAt: vi.fn(() => '2026-10-03T12:00:00.000Z'),
    };
    return { calls, reloads };
  }

  it('starts watching once the link is recorded, and reports when it last reloaded', async () => {
    // Purpose: the first edit after linking must reload, so the watch opens
    // only after the record exists; the listing carries the last reload time.
    const { calls, reloads } = recordingReloads();
    const status = await service({}, reloads).link({ path: work, scope: 'global', via: 'app' });
    expect(calls).toEqual(['sync:1']);
    expect(status.lastReloadAt).toBe('2026-10-03T12:00:00.000Z');
    expect((await service({}, reloads).list()).links[0]?.lastReloadAt).toBe(
      '2026-10-03T12:00:00.000Z'
    );
  });

  it('leaves lastReloadAt out until something reloaded', async () => {
    // Purpose: an absent time means "not yet", never an empty string.
    const { reloads } = recordingReloads();
    vi.mocked(reloads.lastReloadAt).mockReturnValue(undefined);
    const status = await service({}, reloads).link({ path: work, scope: 'global', via: 'app' });
    expect('lastReloadAt' in status).toBe(false);
  });

  it('lets nothing rebuild, refresh or project from the folder once the unlink has started', async () => {
    // Purpose: nothing may rebuild from the folder while its link and
    // approvals are being taken away. A burst already past the watcher's gate
    // (here, waiting on an extension scan) must finish before the unlink
    // touches the slot, and must not rebuild anything once it resumes.
    const calls: string[] = [];
    let scanDone!: () => void;
    const scan = new Promise<void>((resolve) => {
      scanDone = resolve;
    });
    let listeners: DevLinkWatchListeners | undefined;
    const watcher = new DevLinkWatcher({
      dorkHome: home,
      extensions: {
        carriedBy: () => [{ id: 'flow-dash', dir: 'flow-dash' }],
        refresh: async () => {
          calls.push('refresh');
          await scan;
        },
        reload: async (id) => {
          calls.push(`reload:${id}`);
          return { outcome: 'reloaded' };
        },
      },
      refreshPlugins: async () => {
        calls.push('plugins');
      },
      reproject: async () => {
        calls.push('project');
      },
      broadcast: () => calls.push('broadcast'),
      quietMs: 10,
      rearmMs: 0,
      settleMs: 0,
      watch: (_folder, _ignored, given) => {
        listeners = given;
        queueMicrotask(() => given.onReady());
        return { close: async () => undefined };
      },
    });
    try {
      const svc = service(
        {
          unlink: async (target) => {
            calls.push('unlink-started');
            await unlink(target);
          },
        },
        watcher
      );
      await svc.link({ path: work, scope: 'global', via: 'app' });
      await watcher.ready();
      // A changed extension manifest: a re-scan, then a rebuild.
      listeners!.onEvent(
        'change',
        path.join(work, '.dork', 'extensions', 'flow-dash', 'extension.json')
      );
      for (let i = 0; i < 100 && !calls.includes('refresh'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(calls).toEqual(['refresh']);

      const unlinking = svc.unlink({ name: 'flow', scope: 'global' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).not.toContain('unlink-started');
      scanDone();
      expect(await unlinking).toEqual({ restored: 'removed' });

      const started = calls.indexOf('unlink-started');
      expect(started).toBeGreaterThan(-1);
      expect(calls.slice(started)).toEqual(['unlink-started']);
      expect(calls.some((call) => call.startsWith('reload:'))).toBe(false);
      expect(watcher.watchedFolders()).toEqual([]);
    } finally {
      await watcher.stop();
    }
  });

  it('releases even when the unlink fails, so the link is not left deaf', async () => {
    // Purpose: a failed unlink leaves the dev link in force; it must be
    // watched again rather than stay held until a restart.
    const { calls, reloads } = recordingReloads();
    await service({}, reloads).link({ path: work, scope: 'global', via: 'app' });
    calls.length = 0;
    const svc = service(
      {
        unlink: async () => {
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        },
      },
      reloads
    );
    await expect(svc.unlink({ name: 'flow', scope: 'global' })).rejects.toThrow('EBUSY');
    expect(calls).toEqual(['hold:linked', 'release:linked']);
  });
});
