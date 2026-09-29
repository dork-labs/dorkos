import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describePackageLink, findPackageLinks } from '../package-links.js';

let root: string;
let pkg: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'package-links-'));
  pkg = path.join(root, 'pkg');
  await mkdir(path.join(pkg, 'skills', 'real'), { recursive: true });
  await writeFile(path.join(pkg, 'skills', 'real', 'SKILL.md'), 'x');
  await mkdir(path.join(root, 'shared', 'neon-postgres'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findPackageLinks', () => {
  // Purpose: each kind of shortcut is found, and described in words that say
  // it will not be installed.
  it('finds and describes every shortcut in the package', async () => {
    await symlink(
      path.join(root, 'shared', 'neon-postgres'),
      path.join(pkg, 'skills', 'neon-postgres')
    );
    await symlink(path.join(pkg, 'skills', 'real'), path.join(pkg, 'skills', 'alias'));
    await symlink(path.join(root, 'missing'), path.join(pkg, 'skills', 'broken'));
    await mkdir(path.join(pkg, 'node_modules', '.bin'), { recursive: true });
    await symlink(path.join(pkg, 'skills'), path.join(pkg, 'node_modules', '.bin', 'tool'));

    const links = await findPackageLinks(pkg);

    expect(links.map(describePackageLink)).toEqual([
      "skills/alias is a shortcut to a folder elsewhere in the package, so it won't be installed.",
      "skills/broken is a shortcut that leads nowhere, so it won't be installed.",
      "skills/neon-postgres is a shortcut to a folder outside the package, so it won't be installed.",
    ]);
  });

  // Purpose: a package without shortcuts reports none.
  it('finds nothing in a package without shortcuts', async () => {
    expect(await findPackageLinks(pkg)).toEqual([]);
  });
});
