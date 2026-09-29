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

/** Where the Community migrations live, relative to the repository root. */
const COMMUNITY_MIGRATIONS = 'apps/community/migrations';

/**
 * The release-manifest contract the launcher is compiled with: `COMMUNITY_CONFIG_SCHEMA_VERSION`
 * and a strict schema that refuses any manifest field it does not know.
 */
const COMMUNITY_RELEASE_CONTRACT = 'packages/shared/src/community-release-manifest.ts';

/** `path -> blob id` for the files the launcher's release check depends on, at one ref. */
function releaseCheckInputs(git: (args: string[]) => string, ref: string): Map<string, string> {
  const inputs = new Map<string, string>();
  const listing = git([
    'ls-tree',
    ref,
    '--',
    `${COMMUNITY_MIGRATIONS}/`,
    COMMUNITY_RELEASE_CONTRACT,
  ]);
  for (const line of listing === '' ? [] : listing.split('\n')) {
    // `<mode> <type> <blob>\t<path>`. Only the blob id is compared, so a mode-only change (chmod)
    // never counts: the build reads names and contents, never modes.
    const [meta, path] = line.split('\t');
    const [, type, blob] = (meta ?? '').split(' ');
    if (type !== 'blob' || !path || !blob) continue;
    // `ls-tree` without -r lists only files directly in the directory, which is what build.ts
    // reads; of those, only `.sql` files are fingerprinted.
    const fingerprinted =
      path === COMMUNITY_RELEASE_CONTRACT ||
      (path.startsWith(`${COMMUNITY_MIGRATIONS}/`) && path.endsWith('.sql'));
    if (fingerprinted) inputs.set(path, blob);
  }
  return inputs;
}

/**
 * The files the launcher's release check depends on that differ between a release tag and HEAD.
 *
 * Two inputs. The Community migrations, counted the way `scripts/build.ts` fingerprints them: the
 * `.sql` files directly in `apps/community/migrations`, by name and content. And the release-manifest
 * contract, `packages/shared/src/community-release-manifest.ts`, whose schema version and strict
 * schema the launcher checks a manifest against. Any content change to either counts; for the
 * contract that includes a comment-only edit, which is fail-safe (a refused pack, never a pack that
 * cannot deploy). A mode-only change never counts.
 *
 * @param git - Runs git in the repository and returns trimmed stdout; throws on a non-zero exit.
 * @param tag - The release tag, `v<version>`.
 * @returns The changed paths, sorted; empty when nothing the check reads changed.
 * @throws When the tag is not in this checkout.
 */
export function changedCommunityMigrations(git: (args: string[]) => string, tag: string): string[] {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  } catch (error) {
    throw new Error(
      `Tag ${tag} is not in this checkout. Run \`git fetch --tags\`, then pack again.`,
      { cause: error }
    );
  }
  const before = releaseCheckInputs(git, `${tag}^{commit}`);
  const after = releaseCheckInputs(git, 'HEAD');
  const changed = new Set<string>();
  for (const [path, blob] of before) if (after.get(path) !== blob) changed.add(path);
  for (const [path, blob] of after) if (before.get(path) !== blob) changed.add(path);
  return [...changed].sort();
}

/**
 * Refuse to pack a launcher that could never deploy the image it names.
 *
 * A tarball deploys the published Community image for its own package version, but its launcher
 * carries this checkout's migration fingerprint and release-manifest contract, and refuses a
 * release manifest that does not match them (`COMMUNITY_RELEASE_INVALID`). A checkout that changed
 * either after its release tag can therefore never deploy, so say so before building.
 *
 * @param git - Runs git in the repository.
 * @param version - The package version being packed.
 */
export function assertReleasedCommunityMigrations(
  git: (args: string[]) => string,
  version: string
): void {
  const tag = `v${version}`;
  const changed = changedCommunityMigrations(git, tag);
  if (changed.length === 0) return;
  throw new Error(
    [
      `The files the launcher checks a release against changed since ${tag}:`,
      ...changed.map((path) => `  ${path}`),
      `A launcher packed here would refuse the released ${version} image it deploys (COMMUNITY_RELEASE_INVALID).`,
      `Pack from ${tag} plus only the launcher commits under test (git worktree add <dir> ${tag}, then cherry-pick them).`,
      'The receipt then names a commit that is not on main; see "Unreleased tarball mode" in specs/community-self-host-launcher/04-live-gate.md for how to cite it.',
    ].join('\n')
  );
}
