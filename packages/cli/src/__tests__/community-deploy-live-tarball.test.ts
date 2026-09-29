import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  communityLiveTarballSidecarPath,
  inspectCommunityLiveTarball,
} from '../../scripts/community-deploy-live-tarball.js';

const COMMIT = 'a'.repeat(40);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dorkos-live-tarball-'));
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
    await expect(inspectCommunityLiveTarball(tarball)).resolves.toEqual({
      path: tarball,
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
    await expect(inspectCommunityLiveTarball(join(root, 'absent.tgz'))).rejects.toMatchObject({
      step: 'package-tarball-missing',
    });
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    await sidecar(tarball);
    const link = join(root, 'link.tgz');
    await symlink(tarball, link);
    await expect(inspectCommunityLiveTarball(link)).rejects.toMatchObject({
      step: 'package-tarball-missing',
    });
  });

  it('refuses a tarball without a sidecar, or whose sidecar does not describe it', async () => {
    const tarball = await pack({ name: 'dorkos', version: '0.92.0' });
    await expect(inspectCommunityLiveTarball(tarball)).rejects.toMatchObject({
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
        inspectCommunityLiveTarball(tarball),
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
        inspectCommunityLiveTarball(tarball),
        JSON.stringify(manifest)
      ).rejects.toMatchObject({ step: 'package-tarball-contents' });
    }
  });

  it('refuses a file that is not a gzipped tarball', async () => {
    const tarball = join(root, 'dorkos-0.92.0.tgz');
    await writeFile(tarball, 'not a tarball');
    await sidecar(tarball);
    await expect(inspectCommunityLiveTarball(tarball)).rejects.toMatchObject({
      step: 'package-tarball-contents',
    });
  });
});
