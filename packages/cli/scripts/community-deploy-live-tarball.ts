/**
 * The live gate's unreleased-package mode: what a packed tarball must carry, and the check the gate
 * runs on it before installing it.
 *
 * `pnpm --filter dorkos pack:community-live` packs the CLI from a clean checkout and writes a
 * sidecar, `<tarball>.provenance.json`, naming the commit, the package version and the tarball's
 * sha256. The gate refuses a tarball without a matching sidecar, so every receipt from this mode
 * names the exact code it ran and says that code was not a release. Nothing here contacts npm or a
 * service: it reads two local files and lists one file inside the tarball.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { CommunityLiveGateError } from './community-deploy-live-capture.js';
import { runCommunityLiveGateCommand } from './community-deploy-live-process.js';

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);

/** The sidecar the pack recipe writes beside the tarball. */
export const CommunityLiveTarballProvenanceSchema = z
  .object({
    schema: z.literal(1),
    packageName: z.literal('dorkos'),
    packageVersion: VersionSchema,
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    // A tarball packed from uncommitted changes has no commit that describes it.
    clean: z.literal(true),
    packedAt: z.iso.datetime(),
  })
  .strict();

/** The sidecar's contents. */
export type CommunityLiveTarballProvenance = z.infer<typeof CommunityLiveTarballProvenanceSchema>;

/** The receipt's `source` block for a run from an unreleased tarball. */
export interface CommunityLiveTarballReceipt {
  kind: 'tarball';
  /** Always false: this run did not test a published release. */
  released: false;
  /** File name only; the absolute path is the operator's machine layout. */
  file: string;
  sha256: string;
  commit: string;
  packageVersion: string;
}

/** A tarball the gate checked and may install. */
export interface InspectedCommunityLiveTarball {
  path: string;
  version: string;
  receipt: CommunityLiveTarballReceipt;
}

/** The sidecar path for a tarball. */
export function communityLiveTarballSidecarPath(tarballPath: string): string {
  return `${tarballPath}.provenance.json`;
}

/**
 * The sha256 of a file, as 64 lowercase hex characters.
 *
 * @param path - File to hash.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Read `package/package.json` out of an npm tarball without unpacking it to disk. */
async function readPackedManifest(tarballPath: string): Promise<unknown> {
  const stdout = await runCommunityLiveGateCommand(
    'tar',
    ['-xzOf', tarballPath, 'package/package.json'],
    process.env,
    'package-tarball-contents'
  );
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new CommunityLiveGateError('package-tarball-contents');
  }
}

/**
 * Check an unreleased tarball before the gate installs it.
 *
 * It must be a regular file (not a link), carry a sidecar written by the pack recipe from a clean
 * checkout, hash to the sidecar's sha256, and contain the `dorkos` package at the sidecar's version.
 *
 * @param tarballPath - Absolute `.tgz` path the config already validated.
 * @param readManifest - Test seam for reading the packed `package.json`.
 */
export async function inspectCommunityLiveTarball(
  tarballPath: string,
  readManifest: (path: string) => Promise<unknown> = readPackedManifest
): Promise<InspectedCommunityLiveTarball> {
  try {
    const stat = await lstat(tarballPath);
    if (!stat.isFile()) throw new Error('not a regular file');
  } catch {
    throw new CommunityLiveGateError('package-tarball-missing');
  }
  let provenance: CommunityLiveTarballProvenance;
  try {
    provenance = CommunityLiveTarballProvenanceSchema.parse(
      JSON.parse(await readFile(communityLiveTarballSidecarPath(tarballPath), 'utf8'))
    );
  } catch {
    throw new CommunityLiveGateError('package-tarball-provenance');
  }
  const sha256 = await sha256File(tarballPath);
  if (sha256 !== provenance.sha256) throw new CommunityLiveGateError('package-tarball-provenance');
  const manifest = z
    .object({ name: z.literal('dorkos'), version: VersionSchema })
    .passthrough()
    .safeParse(await readManifest(tarballPath));
  if (!manifest.success || manifest.data.version !== provenance.packageVersion) {
    throw new CommunityLiveGateError('package-tarball-contents');
  }
  return {
    path: tarballPath,
    version: provenance.packageVersion,
    receipt: {
      kind: 'tarball',
      released: false,
      file: basename(tarballPath),
      sha256,
      commit: provenance.commit,
      packageVersion: provenance.packageVersion,
    },
  };
}
