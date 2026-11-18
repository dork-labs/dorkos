/**
 * Shell entry for the cherry-pick rule, so a CI step (ci-steward's
 * `release-cherry-picks`, DOR-4639) runs the exact function the publish runs.
 * Node builtins only, no install:
 *
 *   node --experimental-strip-types check-picks.ts <repo-dir> <version> <base> <head> <main-sha>
 *
 * `head` must be a branch tip (a PR's head SHA), never GitHub's merge ref.
 * Prints one JSON object (`{ ok, findings }`) on stdout. Exit 0 = pass,
 * 1 = findings, 2 = bad arguments or a read error (fail closed).
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIsAncestor, gitPatchId, readReleaseBranchCommits } from './proof.ts';
import { checkReleaseCherryPicks, type CherryPickFinding } from './rules.ts';

const SHA = /^[a-f0-9]{40}$/;

/** Run the rule over `<base>..<head>` in a full local checkout and return its findings. */
export function checkPicksInRepo(input: {
  repoDir: string;
  version: string;
  base: string;
  head: string;
  mainSha: string;
}): CherryPickFinding[] {
  const { repoDir, version, base, head, mainSha } = input;
  if (![base, head, mainSha].every((sha) => SHA.test(sha)))
    throw Error('base, head and main must be full 40-character SHAs.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw Error('version must be X.Y.Z.');
  // A missing object would otherwise read as "not on main" (exit 1); it is a read error (exit 2).
  for (const sha of [base, head, mainSha])
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoDir, stdio: 'ignore' });
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
  if (shallow !== 'false') throw Error('The checkout is shallow; fetch full history first.');
  return checkReleaseCherryPicks({
    version,
    commits: readReleaseBranchCommits(repoDir, base, head),
    isMainAncestor: (sha) => gitIsAncestor(repoDir, sha, mainSha),
    patchIdOf: (sha) => gitPatchId(repoDir, sha),
    // An empty range with base != head means a shallow or partial fetch.
    allowEmpty: base === head,
  });
}

function main(args: readonly string[]): number {
  if (args.length !== 5) {
    console.error('Usage: check-picks.ts <repo-dir> <version> <base> <head> <main-sha>');
    return 2;
  }
  const [repoDir, version, base, head, mainSha] = args;
  try {
    const findings = checkPicksInRepo({ repoDir, version, base, head, mainSha });
    console.log(JSON.stringify({ ok: findings.length === 0, findings }));
    return findings.length ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
