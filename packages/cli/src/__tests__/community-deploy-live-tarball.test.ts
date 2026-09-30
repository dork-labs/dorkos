import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertReleasedCommunityMigrations,
  changedCommunityMigrations,
  assertPackedCommitUnchanged,
  communityLiveTarballSidecarPath,
  createCommunityLivePackDirectory,
  inspectCommunityLiveTarball,
} from '../../scripts/community-deploy-live-tarball.js';

const COMMIT = 'a'.repeat(40);
let root: string;
let copies = 0;
/** A fresh copy directory inside the retained run home, as the gate passes one. */
const copyDir = () => join(root, 'home', `package-under-test-${copies++}`);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dorkos-live-tarball-'));
  await mkdir(join(root, 'home'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build a real npm-shaped tarball: `package/package.json` inside a gzipped tar. */
async function pack(manifest: Record<string, unknown>, name = 'dorkos-0.92.0.tgz') {
  const staging = join(root, `staging-${name}`);
  await mkdir(join(staging, 'package'), { recursive: true });
  await writeFile(join(staging, 'package', 'package.json'), JSON.stringify(manifest));
  const tarball = join(root, name);
  execFileSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  return tarball;
}

async function sidecar(tarball: string, update: Record<string, unknown> = {}) {
  const sha256 = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');
  await writeFile(
    communityLiveTarballSidecarPath(tarball),
    JSON.stringify({
      schema: 1,
      packageName: 'dorkos',
      packageVersion: '0.92.0',
      commit: COMMIT,
      sha256,
      clean: true,
      packedAt: '2026-09-29T10:00:00.000Z',
      ...update,
    })
  );
  return sha256;
}

describe('live gate unreleased tarball check', () => {
  it('records the tarball as not a release, with its sha256, commit and version', async () => {
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    const sha256 = await sidecar(tarball);
    const directory = copyDir();
    await expect(inspectCommunityLiveTarball(tarball, directory)).resolves.toEqual({
      path: join(directory, 'dorkos-0.92.0.tgz'),
      version: '0.92.0',
      receipt: {
        kind: 'tarball',
        released: false,
        file: 'dorkos-0.92.0.tgz',
        sha256,
        commit: COMMIT,
        packageVersion: '0.92.0',
      },
    });
  });

  it('refuses a missing file and a symbolic link', async () => {
    await expect(
      inspectCommunityLiveTarball(join(root, 'absent.tgz'), copyDir())
    ).rejects.toMatchObject({
      step: 'package-tarball-missing',
    });
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    await sidecar(tarball);
    const link = join(root, 'link.tgz');
    await symlink(tarball, link);
    await expect(inspectCommunityLiveTarball(link, copyDir())).rejects.toMatchObject({
      step: 'package-tarball-missing',
    });
  });

  it('refuses a tarball without a sidecar, or whose sidecar does not describe it', async () => {
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    await expect(inspectCommunityLiveTarball(tarball, copyDir())).rejects.toMatchObject({
      step: 'package-tarball-provenance',
    });
    for (const update of [
      { sha256: 'b'.repeat(64) },
      { clean: false },
      { commit: 'main' },
      { packageName: 'not-dorkos' },
      { extra: true },
    ]) {
      await sidecar(tarball, update);
      await expect(
        inspectCommunityLiveTarball(tarball, copyDir()),
        JSON.stringify(update)
      ).rejects.toMatchObject({ step: 'package-tarball-provenance' });
    }
  });

  it('refuses a tarball whose package is not dorkos at the sidecar version', async () => {
    for (const manifest of [
      { name: 'other', version: '0.92.0' },
      { name: 'dorkos', version: '0.91.0' },
      { version: '0.92.0' },
    ]) {
      const tarball = await pack(manifest, `${String(manifest.name)}-${manifest.version}.tgz`);
      await sidecar(tarball);
      await expect(
        inspectCommunityLiveTarball(tarball, copyDir()),
        JSON.stringify(manifest)
      ).rejects.toMatchObject({ step: 'package-tarball-contents' });
    }
  });

  it('refuses a file that is not a gzipped tarball', async () => {
    const tarball = join(root, 'dorkos-0.92.0.tgz');
    await writeFile(tarball, 'not a tarball');
    await sidecar(tarball);
    await expect(inspectCommunityLiveTarball(tarball, copyDir())).rejects.toMatchObject({
      step: 'package-tarball-contents',
    });
  });

  // The gate installs, and a failed run's recovery resumes, from the copy it checked. Replacing or
  // repacking the original afterwards (builds are not byte-reproducible) must change neither.
  it('keeps using the verified copy after the original path is swapped', async () => {
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    const sha256 = await sidecar(tarball);
    const directory = copyDir();
    const inspected = await inspectCommunityLiveTarball(tarball, directory);
    const other = await pack(
      { name: 'dorkos', version: '0.92.0', extra: 'unchecked' },
      'other.tgz'
    );
    await writeFile(tarball, await readFile(other));
    expect(inspected.path).toBe(join(directory, 'dorkos-0.92.0.tgz'));
    expect(inspected.path).not.toBe(tarball);
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(hash(await readFile(inspected.path))).toBe(sha256);
    expect(hash(await readFile(inspected.path))).toBe(inspected.receipt.sha256);
    expect(hash(await readFile(tarball))).not.toBe(sha256);
  });

  // Everything after the copy is checked on the copy. A change to the original at that moment is
  // irrelevant; a change to the copy is caught.
  it('hashes and reads the copy, not the original', async () => {
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    await sidecar(tarball);
    const other = await pack({ name: 'dorkos', version: '0.92.0', extra: 'unchecked' }, 'x.tgz');
    const swapped = await inspectCommunityLiveTarball(tarball, copyDir(), {
      afterCopy: async () => writeFile(tarball, await readFile(other)),
    });
    expect(swapped.receipt.file).toBe('dorkos-0.92.0.tgz');
    await expect(
      inspectCommunityLiveTarball(
        await pack({ name: 'dorkos', version: '0.92.0' }, 'y.tgz').then(async (fresh) => {
          await sidecar(fresh);
          return fresh;
        }),
        copyDir(),
        {
          afterCopy: async (copy) => writeFile(copy, await readFile(other)),
        }
      )
    ).rejects.toMatchObject({ step: 'package-tarball-provenance' });
  });

  it('refuses a copy directory that already exists, and removes a copy that fails its check', async () => {
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    await sidecar(tarball);
    const existing = copyDir();
    await mkdir(existing);
    await expect(inspectCommunityLiveTarball(tarball, existing)).rejects.toMatchObject({
      step: 'package-tarball-copy',
    });
    await sidecar(tarball, { sha256: 'b'.repeat(64) });
    const failed = copyDir();
    await expect(inspectCommunityLiveTarball(tarball, failed)).rejects.toMatchObject({
      step: 'package-tarball-provenance',
    });
    await expect(readFile(join(failed, 'dorkos-0.92.0.tgz'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('live gate pack recipe guards', () => {
  it('packs into a fresh <out>/<commit> directory and refuses one that exists', async () => {
    const out = join(root, 'packs');
    await expect(createCommunityLivePackDirectory(out, COMMIT)).resolves.toBe(join(out, COMMIT));
    await writeFile(join(out, COMMIT, 'dorkos-0.92.0.tgz'), 'earlier pack');
    await expect(createCommunityLivePackDirectory(out, COMMIT)).rejects.toThrow('already exists');
    await expect(readFile(join(out, COMMIT, 'dorkos-0.92.0.tgz'), 'utf8')).resolves.toBe(
      'earlier pack'
    );
  });

  it('refuses when HEAD moved during the build', () => {
    expect(() => assertPackedCommitUnchanged(COMMIT, COMMIT)).not.toThrow();
    expect(() => assertPackedCommitUnchanged(COMMIT, 'b'.repeat(40))).toThrow('HEAD moved');
  });
});

// A launcher carries its checkout's migration fingerprint and refuses a release manifest with
// another, so a pack past its release's migrations could never deploy (DOR-2169).
describe('live gate pack recipe migration guard', () => {
  async function repo() {
    const dir = join(root, 'repo');
    await mkdir(join(dir, 'apps/community/migrations/meta'), { recursive: true });
    const run = (args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.invalid',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
      }).trim();
    run(['init', '-q', '-b', 'main']);
    const write = (path: string, text: string) => writeFile(join(dir, path), text);
    await write('apps/community/migrations/0001_init.sql', 'create table a();');
    await write('apps/community/migrations/README.md', 'notes');
    await write('launcher.ts', 'v1');
    await mkdir(join(dir, 'packages/shared/src'), { recursive: true });
    await write('packages/shared/src/community-release-manifest.ts', 'export const V = 1;');
    run(['add', '-A']);
    run(['commit', '-qm', 'release']);
    run(['tag', 'v0.92.0']);
    const commit = async (paths: Record<string, string>) => {
      for (const [path, text] of Object.entries(paths)) await write(path, text);
      run(['add', '-A']);
      run(['commit', '-qm', 'change']);
    };
    return { run, commit };
  }

  it('passes a checkout whose migrations match the tag, even with other changes', async () => {
    const { run, commit } = await repo();
    await commit({
      'launcher.ts': 'v2',
      // Not a .sql file directly in the directory, so not in the fingerprint.
      'apps/community/migrations/README.md': 'more notes',
      'apps/community/migrations/meta/journal.json': '{}',
      // build.ts reads only the directory itself, so a nested .sql file is not fingerprinted.
      'apps/community/migrations/meta/snapshot.sql': 'select 1;',
    });
    expect(changedCommunityMigrations(run, 'v0.92.0')).toEqual([]);
    expect(() => assertReleasedCommunityMigrations(run, '0.92.0')).not.toThrow();
  });

  it('refuses, naming each changed migration, when one was added or edited after the tag', async () => {
    const { run, commit } = await repo();
    await commit({
      'apps/community/migrations/0001_init.sql': 'create table a(id int);',
      'apps/community/migrations/0002_more.sql': 'create table b();',
    });
    expect(changedCommunityMigrations(run, 'v0.92.0')).toEqual([
      'apps/community/migrations/0001_init.sql',
      'apps/community/migrations/0002_more.sql',
    ]);
    let message = '';
    try {
      assertReleasedCommunityMigrations(run, '0.92.0');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      'The files the launcher checks a release against changed since v0.92.0:'
    );
    expect(message).toContain('  apps/community/migrations/0002_more.sql');
    expect(message).toContain('COMMUNITY_RELEASE_INVALID');
    expect(message).toContain('Pack from v0.92.0 plus only the launcher commits under test');
    expect(message).toContain('not on main');
  });

  it('refuses a removed migration too', async () => {
    const { run } = await repo();
    run(['rm', '-q', 'apps/community/migrations/0001_init.sql']);
    run(['commit', '-qm', 'drop']);
    expect(changedCommunityMigrations(run, 'v0.92.0')).toEqual([
      'apps/community/migrations/0001_init.sql',
    ]);
  });

  it('tells the operator to fetch tags when the release tag is missing', async () => {
    const { run } = await repo();
    expect(() => assertReleasedCommunityMigrations(run, '0.93.0')).toThrow(
      'Tag v0.93.0 is not in this checkout. Run `git fetch --tags`, then pack again.'
    );
  });

  // The launcher also checks a manifest against its compiled contract (schema version, strict
  // schema), so a change there can refuse a release too. Any content change counts, fail-safe.
  it('refuses a change to the release-manifest contract', async () => {
    const { run, commit } = await repo();
    await commit({ 'packages/shared/src/community-release-manifest.ts': 'export const V = 2;' });
    expect(changedCommunityMigrations(run, 'v0.92.0')).toEqual([
      'packages/shared/src/community-release-manifest.ts',
    ]);
  });

  // The build reads names and contents, never modes, so a chmod alone changes nothing it checks.
  it('ignores a mode-only change to a migration', async () => {
    const { run } = await repo();
    run(['update-index', '--chmod=+x', 'apps/community/migrations/0001_init.sql']);
    run(['commit', '-qm', 'chmod']);
    expect(run(['diff', '--name-only', 'v0.92.0', 'HEAD'])).toBe(
      'apps/community/migrations/0001_init.sql'
    );
    expect(changedCommunityMigrations(run, 'v0.92.0')).toEqual([]);
  });

  it('refuses a renamed migration, which changes its fingerprinted name', async () => {
    const { run } = await repo();
    run([
      'mv',
      'apps/community/migrations/0001_init.sql',
      'apps/community/migrations/0001_start.sql',
    ]);
    run(['commit', '-qm', 'rename']);
    expect(changedCommunityMigrations(run, 'v0.92.0')).toEqual([
      'apps/community/migrations/0001_init.sql',
      'apps/community/migrations/0001_start.sql',
    ]);
  });
});
