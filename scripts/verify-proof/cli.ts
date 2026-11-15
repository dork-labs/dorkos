import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function commit(cwd: string, ref: string): { sha: string; tree: string } {
  const sha = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  return { sha, tree: git(cwd, 'rev-parse', `${sha}^{tree}`) };
}

function proofDir(cwd: string): string {
  return path.join(
    git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    'dorkos-verify-proof'
  );
}

const clean = (cwd: string): boolean =>
  git(cwd, 'status', '--porcelain', '--untracked-files=normal') === '';

/** Run the existing gates once; only the unchanged, clean commit earns a proof. */
export function runVerification(cwd: string, verify: () => number): number {
  const before = commit(cwd, 'HEAD');
  const dir = proofDir(cwd);
  const destination = path.join(dir, before.sha);
  const startedClean = clean(cwd);
  // A failed or interrupted rerun must not leave an earlier green behind.
  rmSync(destination, { force: true });
  const status = verify();
  if (status !== 0) return status;
  const after = commit(cwd, 'HEAD');
  if (!startedClean || !clean(cwd) || after.sha !== before.sha || after.tree !== before.tree) {
    console.warn(
      'pnpm verify passed; no proof recorded because HEAD or the working tree changed or was dirty'
    );
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ ...before, passedAt: new Date().toISOString() }) + '\n'
    );
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return 0;
}

/** Check a local pass without running any verification commands. */
function check(cwd: string, ref: string, escape: boolean): number {
  let shortSha = ref.slice(0, 12);
  try {
    const { sha, tree } = commit(cwd, ref);
    shortSha = sha.slice(0, 12);
    const dir = proofDir(cwd);
    if (escape) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        path.join(dir, 'escapes.jsonl'),
        JSON.stringify({
          sha,
          who: git(cwd, 'config', 'user.name'),
          when: new Date().toISOString(),
        }) + '\n'
      );
      return 0;
    }
    const proof = JSON.parse(readFileSync(path.join(dir, sha), 'utf8'));
    if (proof.sha === sha && proof.tree === tree && typeof proof.passedAt === 'string') return 0;
  } catch {
    // Missing, unreadable, or malformed proof is the same actionable refusal.
  }
  console.error(
    `no pnpm verify pass recorded for ${shortSha}; run pnpm verify, or pass --no-verify-proof`
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ref, ...flags] = process.argv.slice(2);
  if (command === 'run' && ref === undefined) {
    process.exitCode = runVerification(process.cwd(), () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['run', 'verify:checks'],
        {
          cwd: process.cwd(),
          stdio: 'inherit',
          // pnpm's child inherits the current environment, just as the old shell did.
        }
      );
      return result.status ?? 1;
    });
  } else if (command === 'check' && ref && flags.every((flag) => flag === '--no-verify-proof')) {
    process.exitCode = check(process.cwd(), ref, flags.includes('--no-verify-proof'));
  } else {
    console.error('usage: node scripts/verify-proof/cli.ts run | check <sha> [--no-verify-proof]');
    process.exitCode = 2;
  }
}
