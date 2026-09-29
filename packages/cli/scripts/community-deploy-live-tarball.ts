/**
 * The live gate's unreleased-package mode: what a packed tarball must carry, and the check the gate
 * runs on it before installing it.
 *
 * `pnpm --filter dorkos pack:community-live` packs the CLI from a clean checkout and writes a
 * sidecar, `<tarball>.provenance.json`, naming the commit, the package version and the tarball's
 * sha256. The gate refuses a tarball without a matching sidecar, so every receipt from this mode
 * names the exact code it ran and says that code was not a release. Nothing here contacts npm, a
 * profile or a service: it copies the tarball into the run's own directory, reads the sidecar, and
 * runs one local `tar` read of the copy. The `commit` comes from that local sidecar and is not
 * checked against a remote.
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
  /**
   * The gate's own verified copy, inside the retained run directory. Every later step (install,
   * recovery) uses this path, never the operator's original, which could be replaced or repacked
   * after the check.
   */
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
 * Copy an unreleased tarball into the run's retained directory and check the copy before the gate
 * installs it.
 *
 * The original must be a regular file (not a link) with a sidecar written by the pack recipe from a
 * clean checkout. The copy must hash to the sidecar's sha256 and contain the `dorkos` package at the
 * sidecar's version. From then on only the copy is used: hashing, reading, installing and the
 * recovery command all name it, so replacing or repacking the original afterwards cannot change
 * what a failed run resumes with. The copy lives in the run's retained directory, which survives a
 * failure and is removed with it on success. A failed check removes the copy.
 *
 * @param tarballPath - Absolute `.tgz` path the config already validated.
 * @param copyDirectory - A directory in the run's retained home that does not exist yet.
 * @param seams - Test seams: reading the packed `package.json`, and a hook right after the copy.
 */
export async function inspectCommunityLiveTarball(
  tarballPath: string,
  copyDirectory: string,
  seams: {
    readManifest?: (path: string) => Promise<unknown>;
    afterCopy?: (copy: string) => Promise<void>;
  } = {}
): Promise<InspectedCommunityLiveTarball> {
  const readManifest = seams.readManifest ?? readPackedManifest;
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
  const copy = join(copyDirectory, basename(tarballPath));
  try {
    // A fresh directory, and an exclusive copy: nothing already there can stand in for the check.
    await mkdir(copyDirectory, { recursive: false, mode: 0o700 });
  } catch {
    throw new CommunityLiveGateError('package-tarball-copy');
  }
  try {
    await copyFile(tarballPath, copy, constants.COPYFILE_EXCL);
  } catch {
    await rm(copyDirectory, { recursive: true, force: true });
    throw new CommunityLiveGateError('package-tarball-copy');
  }
  try {
    await seams.afterCopy?.(copy);
    const sha256 = await sha256File(copy);
    if (sha256 !== provenance.sha256) {
      throw new CommunityLiveGateError('package-tarball-provenance');
    }
    const manifest = z
      .object({ name: z.literal('dorkos'), version: VersionSchema })
      .passthrough()
      .safeParse(await readManifest(copy));
    if (!manifest.success || manifest.data.version !== provenance.packageVersion) {
      throw new CommunityLiveGateError('package-tarball-contents');
    }
    return verified(copy, sha256, provenance);
  } catch (error) {
    await rm(copyDirectory, { recursive: true, force: true });
    throw error;
  }
}

function verified(
  copy: string,
  sha256: string,
  provenance: CommunityLiveTarballProvenance
): InspectedCommunityLiveTarball {
  return {
    path: copy,
    version: provenance.packageVersion,
    receipt: {
      kind: 'tarball',
      released: false,
      file: basename(copy),
      sha256,
      commit: provenance.commit,
      packageVersion: provenance.packageVersion,
    },
  };
}

/**
 * The fresh directory a pack run writes into: `<out>/<commit>`. Refuses one that already exists, so
 * a second pack can never overwrite a tarball (or a sidecar) that an earlier run may still name in
 * its recovery command. Builds are not byte-reproducible, so an overwrite would swap in different,
 * unchecked code.
 *
 * @param out - Absolute output directory.
 * @param commit - The commit being packed.
 */
export async function createCommunityLivePackDirectory(
  out: string,
  commit: string
): Promise<string> {
  const directory = join(out, commit);
  await mkdir(out, { recursive: true });
  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${directory} already exists. A tarball packed from this commit is already there; use it, or pass a different --out.`,
        { cause: error }
      );
    }
    throw error;
  }
  return directory;
}

/**
 * Refuse when HEAD moved while the build ran: the commit recorded must be the one packed.
 *
 * @param before - HEAD read before the build.
 * @param after - HEAD read after the build.
 */
export function assertPackedCommitUnchanged(before: string, after: string): void {
  if (before !== after) {
    throw new Error(`HEAD moved from ${before} to ${after} while building; pack again.`);
  }
}
