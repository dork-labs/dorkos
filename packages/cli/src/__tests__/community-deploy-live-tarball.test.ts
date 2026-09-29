import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
