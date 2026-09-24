/**
 * Tests for what counts as an installed package on disk (DOR-2245 §7).
 *
 * An uninstall now keeps the files a person added inside an install root, so a
 * root can exist and hold no package. Every lookup must treat such a root as
 * "not installed", or `dorkos update` / `uninstall` would act on a person's
 * leftover files as if they were a package.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasPackageIdentity, locateInstallRoot } from '../locate-install.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'locate-install-'));
  dirs.push(d);
  return d;
}

async function put(file: string, content = '{}'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

describe('hasPackageIdentity', () => {
  // Purpose: either manifest makes a root a package; neither means kept files only.
  it('is true for a DorkOS manifest or a Claude Code plugin.json, false otherwise', async () => {
    const home = await tmp();
    const dork = path.join(home, 'a');
    const cc = path.join(home, 'b');
    const kept = path.join(home, 'c');
    await put(path.join(dork, '.dork', 'manifest.json'));
    await put(path.join(cc, '.claude-plugin', 'plugin.json'));
    await put(path.join(kept, 'config', 'config.json'));
    await put(path.join(kept, '.dork', 'installed-files.json'));

    expect(await hasPackageIdentity(dork)).toBe(true);
    expect(await hasPackageIdentity(cc)).toBe(true);
    expect(await hasPackageIdentity(kept)).toBe(false);
    expect(await hasPackageIdentity(path.join(home, 'missing'))).toBe(false);
  });

  // Purpose: a directory where the manifest file should be is not an identity.
  it('is false when the manifest path is a directory', async () => {
    const home = await tmp();
    await mkdir(path.join(home, 'x', '.dork', 'manifest.json'), { recursive: true });
    expect(await hasPackageIdentity(path.join(home, 'x'))).toBe(false);
  });

  // Purpose: a linked install (the root itself is a symlink to a working copy)
  // keeps its identity; DOR-2194 checks those and must keep finding them.
  it('follows a symlinked install root to its manifest', async () => {
    const home = await tmp();
    const work = await tmp();
    await put(path.join(work, '.claude-plugin', 'plugin.json'));
    await symlink(work, path.join(home, 'linked'));
    expect(await hasPackageIdentity(path.join(home, 'linked'))).toBe(true);
  });
});

describe('locateInstallRoot', () => {
  // Purpose: a root an uninstall left (kept files, no manifest) is skipped.
  it('skips a root with no package identity', async () => {
    const home = await tmp();
    await put(path.join(home, 'plugins', 'flow', 'config', 'config.json'));
    expect(await locateInstallRoot({ dorkHome: home, name: 'flow' })).toBeNull();
  });

  // Purpose: a kept project root is as if the project never installed it, so a
  // project-scoped lookup falls through to the global install (spec §7).
  it('falls through a kept project root to the global install', async () => {
    const home = await tmp();
    const project = await tmp();
    await put(path.join(project, '.dork', 'plugins', 'flow', 'config', 'config.json'));
    await put(path.join(home, 'plugins', 'flow', '.dork', 'manifest.json'));

    expect(await locateInstallRoot({ dorkHome: home, name: 'flow', projectPath: project })).toBe(
      path.join(home, 'plugins', 'flow')
    );
  });

  // Purpose: the ordinary case still resolves.
  it('finds a root with an identity', async () => {
    const home = await tmp();
    await put(path.join(home, 'agents', 'bot', '.dork', 'manifest.json'));
    expect(await locateInstallRoot({ dorkHome: home, name: 'bot' })).toBe(
      path.join(home, 'agents', 'bot')
    );
  });
});
