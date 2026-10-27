/**
 * Every git DorkOS starts goes through the audited runner (DOR-3343).
 *
 * Reads a repository the server did not make go through `runSafeGit`
 * (`@dorkos/shared/safe-git`), which refuses a repository whose own settings
 * hold a key off the safe list and lets nothing reach out. This census reads
 * the source of the server and every package for a git process started any
 * other way, and fails on one that is not on the list below, each with the
 * reason it is not a read of somebody else's repository. A listed file that
 * no longer starts git fails too, so the list only shrinks.
 *
 * It sees a literal `git` command only. A command held in a variable, a shell
 * line, and `gh` (which starts git itself) are not seen; the heartbeat
 * gatherer's `gh` runs only where `mayRunGitHere` allows git at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Where server-side code lives. `packages/ci-steward` runs in CI on CI's own checkout, never in DorkOS. */
const SCANNED = ['apps/server/src', 'apps/desktop/src', 'packages'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__tests__', 'ci-steward', 'scripts']);

/** Files that may start git themselves, and why. */
const ALLOWED: Record<string, string> = {
  'packages/shared/src/safe-git.ts': 'The runner itself.',
  'apps/server/src/lib/git-safety.ts': '`git --version` only; it reads no repository.',
  'packages/cli/src/commands/doctor-checks.ts': '`git --version` only; it reads no repository.',
  'apps/server/src/services/rooms/repo/room-repo-git.ts':
    "Rooms' own runner: pins git to the room's repository and audits its settings first.",
  'apps/server/src/services/workspace/providers/git.ts':
    "Makes and removes workspaces from a source repository (clone, worktree add and remove): writes that need the source's transports and, for a person's own repository, their hooks. Its reads use the runner.",
  'apps/server/src/services/marketplace/lib/git/git-runner.ts':
    "Fetches a package from its author's address into a new temporary folder, with the transport allowlist.",
  'apps/server/src/services/core/agent-templates/template-downloader.ts':
    'Clones a template from its address into a new folder, with the transport allowlist.',
};

/** A git process started with a literal `git` command, including `promisify(execFile)('git', …)`. */
const STARTS_GIT =
  /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|exec|execSync|execAsync|execa)\s*(?:\)\s*)?\(\s*['"`]git\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (
      /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) &&
      !/\.test\.|\.spec\./.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('git runner census', () => {
  const starters = SCANNED.flatMap((dir) => sourceFiles(path.join(REPO, dir)))
    .filter((file) => STARTS_GIT.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(REPO, file).split(path.sep).join('/'))
    .sort();

  it('finds git started outside the runner only in the listed files', () => {
    expect(starters.filter((file) => !(file in ALLOWED))).toEqual([]);
  });

  it('has no listed file that no longer starts git', () => {
    expect(Object.keys(ALLOWED).filter((file) => !starters.includes(file))).toEqual([]);
  });

  it('catches the shapes it is meant to', () => {
    expect(STARTS_GIT.test("execFileAsync('git', ['status'])")).toBe(true);
    expect(STARTS_GIT.test("promisify(execFile)('git', ['--version'])")).toBe(true);
    expect(STARTS_GIT.test("spawn(\n  'git',\n  args)")).toBe(true);
    expect(STARTS_GIT.test("runSafeGit(['status'], cwd)")).toBe(false);
  });
});
