/**
 * Tests for the package content hash (DOR-2306): what it binds, what it skips,
 * and the refusal of a package that ships DorkOS's runtime state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertShipsNoRuntimeState,
  hashTree,
  isRuntimeStatePath,
  packageContentHash,
  RUNTIME_STATE_PATHS,
  ShipsRuntimeStateError,
  TreeUnhashableError,
} from '../content-hash.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'content-hash-'));
  await mkdir(path.join(root, 'hooks'), { recursive: true });
  await writeFile(path.join(root, 'hooks', 'fmt.sh'), 'echo good\n');
  await writeFile(path.join(root, 'README.md'), '# fmt\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('hashTree', () => {
  // Purpose (DOR-2197): an approval binds this hash (DOR-2306), so it must not
  // change when the per-file digest is shared with the installed-files record's
  // hashFile. Pinned for the fixture tree above; a different value here means
  // every recorded approval would stop matching.
  it('keeps the exact hash of a known tree', async () => {
    expect(await hashTree(root)).toBe(
      'sha256:40937766ce57782f21b212e574d747878ec991f8a45060cf809da1e79364ace6'
    );
  });

  it('changes when one file changes, even to the same size (the exploit)', async () => {
    // Purpose: approval binds bytes. A hostile script of the same length, or
    // any length, must not hash like the approved one.
    const before = await hashTree(root);
    await writeFile(path.join(root, 'hooks', 'fmt.sh'), 'curl evil\n');

    expect(await hashTree(root)).not.toBe(before);
  });

  it('changes when a file becomes executable, is added, or is removed', async () => {
    const base = await hashTree(root);
    await chmod(path.join(root, 'README.md'), 0o755);
    const executable = await hashTree(root);
    expect(executable).not.toBe(base);
    await writeFile(path.join(root, 'extra'), 'x');
    const added = await hashTree(root);
    expect(added).not.toBe(executable);
    await rm(path.join(root, 'extra'));
    expect(await hashTree(root)).toBe(executable);
  });

  it('is the same for the same bytes in another directory', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'content-hash-copy-'));
    try {
      await mkdir(path.join(other, 'hooks'));
      await writeFile(path.join(other, 'hooks', 'fmt.sh'), 'echo good\n');
      await writeFile(path.join(other, 'README.md'), '# fmt\n');
      expect(await hashTree(other)).toBe(await hashTree(root));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('skips DorkOS runtime state, and nothing else by default', async () => {
    // Purpose: saving settings or secrets must not look like a changed package.
    const base = await hashTree(root, isRuntimeStatePath);
    await mkdir(path.join(root, '.dork', 'data'), { recursive: true });
    await writeFile(path.join(root, '.dork', 'data', 'settings.json'), '{}');
    await writeFile(path.join(root, '.dork', 'secrets.json'), '{}');
    await writeFile(path.join(root, '.dork', 'install-metadata.json'), '{}');
    expect(await hashTree(root, isRuntimeStatePath)).toBe(base);

    await writeFile(path.join(root, '.dork', 'manifest.json'), '{}');
    expect(await hashTree(root, isRuntimeStatePath)).not.toBe(base);
  });

  it('leaves links out, in the tree or out of it (the install strips them)', async () => {
    const base = await hashTree(root);
    await symlink('fmt.sh', path.join(root, 'hooks', 'alias'));
    await symlink('/etc/hosts', path.join(root, 'hooks', 'escape'));
    expect(await hashTree(root)).toBe(base);
  });

  it('refuses a tree holding something that is not a file, a folder or a link', async () => {
    execFileSync('mkfifo', [path.join(root, 'hooks', 'pipe')]);
    await expect(hashTree(root)).rejects.toBeInstanceOf(TreeUnhashableError);
  });
});

describe('packageContentHash', () => {
  it('leaves out only what never lands: the root .npmrc and links', async () => {
    const staged = await packageContentHash(root);
    await writeFile(path.join(root, '.npmrc'), 'registry=https://attacker.example');
    await symlink('fmt.sh', path.join(root, 'hooks', 'alias'));

    expect(await packageContentHash(root)).toBe(staged);
  });

  it('leaves out every .git, which the install strips (DOR-2326)', async () => {
    // Purpose: the hash is of what lands, and an installed folder a person
    // made their own repository must still match its record.
    const staged = await packageContentHash(root);
    await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(root, '.git', 'config'), '[core]\n\tfsmonitor = x\n');
    await mkdir(path.join(root, 'hooks', 'vendored'), { recursive: true });
    await writeFile(path.join(root, 'hooks', 'vendored', '.git'), 'gitdir: ../../x\n');
    const withGit = await packageContentHash(root);
    await rm(path.join(root, 'hooks', 'vendored'), { recursive: true });
    expect(withGit).toBe(staged);
  });

  it('covers a file whose name only contains .git', async () => {
    const staged = await packageContentHash(root);
    await writeFile(path.join(root, '.gitignore'), 'x');
    expect(await packageContentHash(root)).not.toBe(staged);
  });

  it('covers a shipped node_modules: two trees differing only there hash differently (the PoC)', async () => {
    // Purpose: npm leaves a shipped node_modules in place, and a server the
    // package starts runs that code, so it must be part of what is approved.
    await mkdir(path.join(root, 'node_modules', 'srv'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'srv', 'index.js'), 'benign()');
    const benign = await packageContentHash(root);
    await writeFile(path.join(root, 'node_modules', 'srv', 'index.js'), 'evil()');

    expect(await packageContentHash(root)).not.toBe(benign);
  });

  it('covers a shipped lockfile: a different `resolved` URL hashes differently', async () => {
    // Purpose: npm obeys the lockfile, so where it fetches from is approved too.
    await writeFile(
      path.join(root, 'package-lock.json'),
      '{"resolved":"https://registry.npmjs.org/x.tgz"}'
    );
    const registry = await packageContentHash(root);
    await writeFile(
      path.join(root, 'package-lock.json'),
      '{"resolved":"https://attacker.example/x.tgz"}'
    );

    expect(await packageContentHash(root)).not.toBe(registry);
  });

  it('covers a nested .npmrc, which lands like any file', async () => {
    const base = await packageContentHash(root);
    await mkdir(path.join(root, 'hooks', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'hooks', 'nested', '.npmrc'), 'x');
    expect(await packageContentHash(root)).not.toBe(base);
  });
});

describe('assertShipsNoRuntimeState (the I-3 refusal)', () => {
  it('passes a package that ships none of it', async () => {
    await mkdir(path.join(root, '.dork'));
    await writeFile(path.join(root, '.dork', 'manifest.json'), '{}');
    await expect(assertShipsNoRuntimeState(root)).resolves.toBeUndefined();
  });

  it.each(RUNTIME_STATE_PATHS)('refuses a package that ships %s', async (kept) => {
    // Purpose: files there are left out of the hash an approval binds, so a
    // package must not be able to arrive with code (or a forged install
    // record) in them.
    const target = path.join(root, ...kept.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '{}');
    const refused = assertShipsNoRuntimeState(root);
    await expect(refused).rejects.toBeInstanceOf(ShipsRuntimeStateError);
    await expect(refused).rejects.toThrow(kept);
  });
});
