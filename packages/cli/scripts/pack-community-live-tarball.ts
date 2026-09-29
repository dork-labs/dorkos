/**
 * Pack the CLI from a clean checkout for the live gate's unreleased-package mode.
 *
 * Usage, from the repository root of a checkout at the commit to test:
 *
 *   pnpm install --frozen-lockfile
 *   pnpm --filter dorkos pack:community-live -- --out /absolute/output/directory
 *
 * The tarball lands in `<out>/<commit>/`, which must not exist yet.
 *
 * It refuses a checkout with uncommitted changes, builds the CLI the way a release does
 * (`pnpm --filter dorkos build`), packs it with `pnpm pack` (which rewrites workspace dependency
 * ranges the way publishing does, unlike `npm pack`), checks the checkout is still clean, and writes
 * `<tarball>.provenance.json` with the commit, the package version and the tarball's sha256. It
 * contacts no service. Keep the tarball and its sidecar in place until any run that used them is
 * cleaned up: the gate's recovery command installs from that path.
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import {
  assertPackedCommitUnchanged,
  createCommunityLivePackDirectory,
  CommunityLiveTarballProvenanceSchema,
  communityLiveTarballSidecarPath,
  sha256File,
} from './community-deploy-live-tarball.js';

const cliPackage = resolve(import.meta.dirname, '..');
const root = resolve(cliPackage, '../..');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function requireClean(when: string): void {
  if (git(['status', '--porcelain']) !== '') {
    throw new Error(`The checkout has uncommitted changes ${when}; commit or discard them first.`);
  }
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
  if (!out || !isAbsolute(out)) {
    throw new Error('Pass --out with an absolute directory for the tarball.');
  }
  requireClean('before packing');
  const commit = git(['rev-parse', 'HEAD']);
  // A fresh <out>/<commit> directory, refused if it exists: never overwrite a tarball an earlier
  // run's recovery command may still name.
  const destination = await createCommunityLivePackDirectory(out, commit);
  execFileSync('pnpm', ['--filter', 'dorkos', 'build'], { cwd: root, stdio: 'inherit' });
  assertPackedCommitUnchanged(commit, git(['rev-parse', 'HEAD']));
  const printed = execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: cliPackage,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .at(-1)!;
  // pnpm prints the tarball's path; resolved the same way the package smoke test does.
  const tarball = resolve(cliPackage, printed);
  // A build that rewrote a tracked file would make the commit a wrong description of the tarball.
  requireClean('after building');
  const packageJson = JSON.parse(await readFile(join(cliPackage, 'package.json'), 'utf8')) as {
    version: string;
  };
  const provenance = CommunityLiveTarballProvenanceSchema.parse({
    schema: 1,
    packageName: 'dorkos',
    packageVersion: packageJson.version,
    commit,
    sha256: await sha256File(tarball),
    clean: true,
    packedAt: new Date().toISOString(),
  });
  await writeFile(
    communityLiveTarballSidecarPath(tarball),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { flag: 'wx' }
  );
  process.stdout.write(
    `Packed ${tarball}\nCommit ${commit}, dorkos ${provenance.packageVersion}, sha256 ${provenance.sha256}\n` +
      `Run the live gate with DORKOS_COMMUNITY_LIVE_PACKAGE_TARBALL=${tarball} instead of DORKOS_COMMUNITY_LIVE_VERSION.\n`
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Packing failed'}\n`);
  process.exitCode = 1;
});
