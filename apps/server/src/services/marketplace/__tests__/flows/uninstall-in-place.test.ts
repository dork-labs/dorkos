/**
 * The in-place, journaled uninstall (DOR-2245, spec §5).
 *
 * Only the files the installed-files record proves are the package's move,
 * into a same-filesystem sibling; the person's files never move (their inode
 * numbers are the proof). Failures before the commit put every move back,
 * identity files first. Real temp directories throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { UninstallFlow, type UninstallFlowDeps } from '../../flows/uninstall.js';
import {
  computeInstalledFiles,
  readInstalledFiles,
  writeInstalledFiles,
} from '../../lib/installed-files.js';
import * as journalModule from '../../lib/uninstall-journal.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

async function home(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'uninstall-in-place-'));
  dirs.push(d);
  return d;
}

function deps(dorkHome: string, extra: Partial<Omit<UninstallFlowDeps, 'extensionManager'>> = {}) {
  return {
    dorkHome,
    extensionManager: {
      disable: vi.fn().mockResolvedValue(undefined),
      forgetRunApproval: vi.fn().mockResolvedValue(undefined),
    },
    adapterManager: { removeAdapter: vi.fn().mockResolvedValue(undefined) },
    logger: logger(),
    ...extra,
  };
}

async function put(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function exists(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => undefined)) !== undefined;
}

/** Lay down an install the way a real one looks: shipped files plus the record. */
async function installed(
  root: string,
  files: Record<string, string>,
  manifest: Partial<MarketplacePackageManifest> = {}
): Promise<void> {
  const name = path.basename(root);
  await put(
    root,
    '.dork/manifest.json',
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'plugin',
      description: 'x',
      ...manifest,
    })
  );
  for (const [rel, content] of Object.entries(files)) await put(root, rel, content);
  await writeInstalledFiles(
    root,
    await computeInstalledFiles(root, {
      identity: { name, type: (manifest.type ?? 'plugin') as 'plugin' },
      userEditable: [],
      npmRan: false,
    })
  );
  await put(
    root,
    '.dork/install-metadata.json',
    JSON.stringify({ name, version: '1.0.0', type: manifest.type ?? 'plugin', installedAt: 'x' })
  );
}

describe('in-place uninstall (DOR-2245)', () => {
  // Purpose: the person's files never move; package files leave; the record is pruned.
  it("moves only the package's files and never the person's", async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { 'skills/a/SKILL.md': 'a', 'skills/b/SKILL.md': 'b', 'README.md': 'r' });
    await put(root, 'config/config.json', '{"mine":1}');
    await put(root, 'README.md', 'edited');
    const inoBefore = (await stat(path.join(root, 'config', 'config.json'))).ino;

    const result = await new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg' });

    expect((await stat(path.join(root, 'config', 'config.json'))).ino).toBe(inoBefore);
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('edited');
    expect(await exists(path.join(root, 'skills'))).toBe(false);
    expect(await exists(path.join(root, '.dork', 'manifest.json'))).toBe(false);
    expect(await exists(path.join(root, '.dork', 'install-metadata.json'))).toBe(false);
    const record = await readInstalledFiles(root);
    expect(Object.keys(record!.files)).toEqual(['README.md']);
    expect(record!.uninstalledAt).toBeDefined();
    expect(result.preservedData.sort()).toEqual([
      path.join(root, 'README.md'),
      path.join(root, 'config'),
    ]);
    expect((await readdir(path.dirname(root))).sort()).toEqual(['pkg']);
  });

  // Purpose: an edited identity file still leaves with the package, but the
  // person's copy stays as .dork-old: nothing of theirs is deleted.
  it('keeps a copy of an edited identity file', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { '.claude-plugin/plugin.json': '{"name":"pkg"}' });
    await put(root, '.claude-plugin/plugin.json', '{"name":"pkg","mine":true}');
    await new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg' });
    expect(await exists(path.join(root, '.claude-plugin', 'plugin.json'))).toBe(false);
    expect(
      await readFile(path.join(root, '.claude-plugin', 'plugin.json.dork-old'), 'utf8')
    ).toContain('mine');
  });

  // Purpose: an untouched package leaves nothing, not even an empty .dork/data.
  it('leaves no folder behind for an untouched package', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { 'skills/a/SKILL.md': 'a' });
    await mkdir(path.join(root, '.dork', 'data'), { recursive: true });

    const result = await new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg' });

    expect(await exists(root)).toBe(false);
    expect(result.preservedData).toEqual([]);
    expect(await readdir(path.dirname(root))).toEqual([]);
  });

  // Purpose: purge removes the person's files too, once the uninstall commits.
  it('removes everything with purge', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { 'a.md': 'a' });
    await put(root, 'config/config.json', 'mine');
    await new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg', purge: true });
    expect(await exists(root)).toBe(false);
    expect(await readdir(path.dirname(root))).toEqual([]);
  });

  // Purpose: a side-effect failure puts every move back; the person's files never moved.
  it('puts everything back when a side effect fails', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { '.dork/extensions/ext/extension.json': '{}', 'a.md': 'a' });
    await put(root, 'mine.txt', 'mine');
    const d = deps(dorkHome);
    d.extensionManager.disable.mockRejectedValue(new Error('disable failed'));

    await expect(new UninstallFlow(d).uninstall({ name: 'pkg' })).rejects.toThrow('disable failed');

    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('a');
    expect(await exists(path.join(root, '.dork', 'manifest.json'))).toBe(true);
    expect(await exists(path.join(root, '.dork', 'install-metadata.json'))).toBe(true);
    expect(await readFile(path.join(root, 'mine.txt'), 'utf8')).toBe('mine');
    expect(await readdir(path.dirname(root))).toEqual(['pkg']);
  });

  // Purpose: the crash matrix. A failure after the k-th move, for every k,
  // leaves the root exactly as it was (identity files restored first).
  it('restores the root after a failure at every move', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { 'a.md': 'a', 'b/c.md': 'c', 'node_modules/x.js': 'x' }, {});
    await put(root, 'mine.txt', 'mine');
    const snapshot = await tree(root);
    const real = journalModule.journaledMove;
    let total = 0;
    const spy = vi.spyOn(journalModule, 'journaledMove').mockImplementation(async (o) => {
      total++;
      return real(o);
    });
    // Count the moves once, on a copy.
    await new UninstallFlow(deps(dorkHome))
      .uninstall({ name: 'pkg', purge: false })
      .catch(() => undefined);
    spy.mockRestore();
    expect(total).toBeGreaterThan(2);

    for (let k = 1; k <= total; k++) {
      await rm(root, { recursive: true, force: true });
      await installed(root, { 'a.md': 'a', 'b/c.md': 'c', 'node_modules/x.js': 'x' }, {});
      await put(root, 'mine.txt', 'mine');
      let n = 0;
      vi.spyOn(journalModule, 'journaledMove').mockImplementation(async (o) => {
        n++;
        await real(o);
        if (n === k) throw new Error(`crash after move ${k}`);
      });
      await expect(new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg' })).rejects.toThrow(
        `crash after move ${k}`
      );
      vi.restoreAllMocks();
      expect(await tree(root)).toEqual(snapshot);
      expect(await readdir(path.dirname(root))).toEqual(['pkg']);
    }
  });

  // Purpose: the identity files move last, so a crash mid-way leaves a root
  // that is still recognisably the package until everything else has moved.
  it('moves the package identity files last', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { 'a.md': 'a', 'b/c.md': 'c' });
    const order: string[] = [];
    const real = journalModule.journaledMove;
    vi.spyOn(journalModule, 'journaledMove').mockImplementation(async (o) => {
      order.push(o.move.path);
      return real(o);
    });
    await new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg' });
    expect(order[order.length - 1]).toBe('.dork/manifest.json');
    expect(order.indexOf('.dork/install-metadata.json')).toBeLessThan(order.length - 1);
  });

  // Purpose: side-effect inputs come from the live root: an extension whose
  // file the person edited (so it is not moved) is still disabled.
  it('disables an extension even when the person edited its files', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { '.dork/extensions/ext/extension.json': '{}' });
    await put(root, '.dork/extensions/ext/extension.json', '{"edited":true}');
    const d = deps(dorkHome);
    await new UninstallFlow(d).uninstall({ name: 'pkg' });
    expect(d.extensionManager.disable).toHaveBeenCalledWith('ext');
    expect(d.extensionManager.forgetRunApproval).toHaveBeenCalledWith('ext');
  });

  // Purpose (round-3 N9): a file written into a unit-moved folder while it sat
  // in the sibling is moved back before the commit deletes it.
  it('moves back a stray written into a moved folder', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { '.dork/extensions/ext/extension.json': '{}', 'docs/a.md': 'a' });
    const d = deps(dorkHome);
    d.extensionManager.disable.mockImplementation(async () => {
      const sibling = (await readdir(path.dirname(root))).find((n) =>
        n.includes('.dorkos-uninstall-')
      )!;
      await put(path.join(path.dirname(root), sibling), 'docs/late.md', 'late');
    });
    const result = await new UninstallFlow(d).uninstall({ name: 'pkg' });
    expect(await readFile(path.join(root, 'docs', 'late.md'), 'utf8')).toBe('late');
    expect(result.warnings?.[0]).toMatch(/docs\/late\.md/);
  });

  // Purpose: a linked install is removed by removing the link; the tree is untouched.
  it('removes only the link of a linked install', async () => {
    const dorkHome = await home();
    const work = await home();
    await put(work, '.claude-plugin/plugin.json', '{"name":"pkg"}');
    await put(work, 'src/index.ts', 'dev');
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await mkdir(path.dirname(root), { recursive: true });
    await symlink(work, root);
    await new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg' });
    expect(await exists(root)).toBe(false);
    expect(await readFile(path.join(work, 'src', 'index.ts'), 'utf8')).toBe('dev');
  });

  // Purpose: an install made before records existed keeps what nothing proves
  // is the package's; a rebuilt record lets the package's files go.
  it('keeps unprovable files of a legacy install, and uses a rebuilt record when there is one', async () => {
    const dorkHome = await home();
    const root = path.join(dorkHome, 'plugins', 'pkg');
    await installed(root, { 'a.md': 'a' });
    await rm(path.join(root, '.dork', 'installed-files.json'));
    await put(root, 'mine.txt', 'mine');

    await new UninstallFlow(deps(dorkHome)).uninstall({ name: 'pkg' });
    expect(await readFile(path.join(root, 'a.md'), 'utf8')).toBe('a');
    expect(await exists(path.join(root, '.dork', 'manifest.json'))).toBe(false);

    await rm(root, { recursive: true, force: true });
    await installed(root, { 'a.md': 'a' });
    const record = await readInstalledFiles(root);
    await rm(path.join(root, '.dork', 'installed-files.json'));
    await put(root, 'mine.txt', 'mine');
    await new UninstallFlow(deps(dorkHome, { rebuildLegacy: async () => record })).uninstall({
      name: 'pkg',
    });
    expect(await exists(path.join(root, 'a.md'))).toBe(false);
    expect(await readFile(path.join(root, 'mine.txt'), 'utf8')).toBe('mine');
  });
});

describe('uninstalling an agent package (DOR-2245 §5)', () => {
  async function agentRoot(dorkHome: string): Promise<string> {
    const root = path.join(dorkHome, 'agents', 'bot');
    await installed(root, { 'AGENTS.md': 'x' }, { type: 'agent' });
    await put(root, '.dork/agent.json', '{"id":"01AGENT","name":"bot"}');
    return root;
  }

  // Purpose: the agent leaves the team, last, with its identity parked.
  it('parks agent.json and unregisters the agent', async () => {
    const dorkHome = await home();
    const root = await agentRoot(dorkHome);
    const agentRegistry = {
      unregisterAtPath: vi.fn().mockResolvedValue({ id: '01AGENT', directoryDenied: false }),
      restoreAtPath: vi.fn(),
    };
    const result = await new UninstallFlow(deps(dorkHome, { agentRegistry })).uninstall({
      name: 'bot',
    });
    expect(agentRegistry.unregisterAtPath).toHaveBeenCalledWith(root);
    expect(await readFile(path.join(root, '.dork', 'uninstalled-agent.json'), 'utf8')).toContain(
      '01AGENT'
    );
    expect(result.agentRemoved).toMatchObject({ id: '01AGENT', directoryDenied: false });
    expect(result.agentRemoved!.removed).toContain('mcp-sign-ins');
  });

  // Purpose (code review 6): with no registry row to release the manifest
  // (Mesh never saw the agent), a copied agent.json stayed live and the next
  // scan registered an agent with no package. The manifest is moved, not copied.
  it('leaves no live agent.json when the registry has no row for the agent', async () => {
    const dorkHome = await home();
    const root = await agentRoot(dorkHome);
    const agentRegistry = {
      unregisterAtPath: vi.fn().mockResolvedValue(null),
      restoreAtPath: vi.fn(),
    };
    await new UninstallFlow(deps(dorkHome, { agentRegistry })).uninstall({ name: 'bot' });
    expect(await exists(path.join(root, '.dork', 'agent.json'))).toBe(false);
    expect(await readFile(path.join(root, '.dork', 'uninstalled-agent.json'), 'utf8')).toContain(
      '01AGENT'
    );
  });

  // Purpose (code review 6): a git-tracked agent.json is never moved or
  // deleted (DOR-1019): it is copied to the parked name and mesh keeps it and
  // denies the folder instead.
  it('copies, never moves, a git-tracked agent.json', async () => {
    const dorkHome = await home();
    const root = await agentRoot(dorkHome);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.dork/agent.json');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'agent');
    const agentRegistry = {
      unregisterAtPath: vi.fn().mockResolvedValue({ id: '01AGENT', directoryDenied: true }),
      restoreAtPath: vi.fn(),
    };
    await new UninstallFlow(deps(dorkHome, { agentRegistry })).uninstall({ name: 'bot' });
    expect(await readFile(path.join(root, '.dork', 'agent.json'), 'utf8')).toContain('01AGENT');
    expect(await exists(path.join(root, '.dork', 'uninstalled-agent.json'))).toBe(true);
  });

  // Purpose: an update's uninstall half keeps the agent registered.
  it('leaves the agent registered when replacing', async () => {
    const dorkHome = await home();
    await agentRoot(dorkHome);
    const agentRegistry = { unregisterAtPath: vi.fn(), restoreAtPath: vi.fn() };
    const result = await new UninstallFlow(deps(dorkHome, { agentRegistry })).uninstall({
      name: 'bot',
      replacing: true,
    });
    expect(agentRegistry.unregisterAtPath).not.toHaveBeenCalled();
    expect(result.agentRemoved).toBeUndefined();
  });

  // Purpose: a failure after the agent left the team (before the commit)
  // restores its manifest and registers it again.
  it('registers the agent again when the uninstall rolls back after unregistering', async () => {
    const dorkHome = await home();
    const root = await agentRoot(dorkHome);
    const agentRegistry = {
      unregisterAtPath: vi.fn().mockImplementation(async () => {
        // Mesh releases the manifest, tolerating one already moved aside.
        await rm(path.join(root, '.dork', 'agent.json'), { force: true });
        throw new Error('cascade failed');
      }),
      restoreAtPath: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      new UninstallFlow(deps(dorkHome, { agentRegistry })).uninstall({ name: 'bot' })
    ).rejects.toThrow('cascade failed');
    expect(await readFile(path.join(root, '.dork', 'agent.json'), 'utf8')).toContain('01AGENT');
    expect(await exists(path.join(root, '.dork', 'uninstalled-agent.json'))).toBe(false);
    expect(agentRegistry.restoreAtPath).toHaveBeenCalledWith(root);
    expect(await exists(path.join(root, '.dork', 'manifest.json'))).toBe(true);
  });
});

/** Every entry under `root`: path → content (files) or `->target` (links) or `/` (dirs). */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[child] = '/';
        await walk(child);
      } else {
        out[child] = await readFile(path.join(root, child), 'utf8');
      }
    }
  };
  await walk('');
  return out;
}
