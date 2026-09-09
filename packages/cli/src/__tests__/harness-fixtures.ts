/**
 * The fixture repo the `dorkos harness sync` CLI suites project, and the temp
 * dir they project it into.
 *
 * Shared by `harness-sync.test.ts` and `harness-sync-symlinks-off.test.ts`: both
 * drive the real engine against a real temp tree from the same starting repo, so
 * the repo is written once here rather than copied into each. Not a `*.test.ts`,
 * so vitest never collects it as a suite — the same shape as
 * `packages/harness/src/__tests__/journeys/stage.ts`.
 *
 * @module __tests__/harness-fixtures
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

import type { HarnessSyncArgs } from '../harness-sync-command.js';

/**
 * Fill in the flags a case does not care about.
 *
 * Every call names the ones under test and nothing else, so adding a flag to
 * `HarnessSyncArgs` does not rewrite thirty unrelated cases into noise.
 *
 * @param partial - the flags this case is actually about.
 * @returns a complete argument object.
 */
export function syncArgs(partial: Partial<HarnessSyncArgs>): HarnessSyncArgs {
  return {
    check: false,
    fix: false,
    strict: false,
    allowHooks: [],
    enable: [],
    global: false,
    writeGitignore: false,
    ...partial,
  };
}

/**
 * A fresh temp directory for one test.
 *
 * @returns the absolute path of the new directory.
 */
export function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-harness-sync-test-'));
}

/**
 * Build a minimal but realistic two-harness fixture repo at `root`: one authored
 * skill, a manifest enabling Claude Code and Codex, an authored Stop hook, and a
 * canonical `AGENTS.md`.
 *
 * @param root - absolute path of the directory to write the repo into.
 */
export function writeFixtureRepo(root: string): void {
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
  );
  fs.writeFileSync(
    path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
    '# Demo skill\n\nA demo skill.\n'
  );

  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'settings.json'),
    JSON.stringify(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } },
      null,
      2
    )
  );

  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n\nCanonical instructions.\n');
}

/**
 * Point `$CLAUDE_CONFIG_DIR` at a Claude root that does not exist, for the whole
 * of one test.
 *
 * `dorkos harness sync` reports the plugins a person turned on in Claude Code,
 * and it finds that root the way a bare `claude` does — `$CLAUDE_CONFIG_DIR`,
 * else `~/.claude`. Without this every case in these suites would read the
 * developer's own settings file and print a block whose contents depend on whose
 * machine the tests ran on, which is the difference between a suite and a
 * coin toss.
 *
 * An absent directory rather than an empty one on purpose: absent is the case
 * the reader is required to answer silently, so pinning it here also keeps that
 * promise under test on every run. Undone by the `vi.unstubAllEnvs()` these
 * suites already call.
 *
 * @param under - a temp directory this test already owns and will remove.
 */
export function pinEmptyClaudeRoot(under: string): void {
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(under, 'claude-root'));
}

/**
 * Point `$HOME` at a directory this test owns, for the whole of one test.
 *
 * Slice A3 made `dorkos harness sync --global` resolve `~/.agents/skills` — the
 * one folder five agent tools read — through `os.homedir()`, which on POSIX
 * answers `$HOME` before it asks the password database. Without this pin, a
 * global case would resolve the DEVELOPER's own home directory, scan it, and
 * offer whatever it found there for removal. Nothing would be removed (the
 * predicate only owns links whose text resolves inside the temp
 * `<dorkHome>/plugins`), but a suite that reads somebody's home folder at all is
 * a suite one bad predicate away from deleting from it.
 *
 * Pair it with {@link pinEmptyClaudeRoot}: the two roots are resolved by
 * different rules, and pinning one is not pinning the other.
 *
 * Undone by the `vi.unstubAllEnvs()` these suites already call.
 *
 * @param dir - a temp directory this test already owns and will remove.
 */
export function pinHome(dir: string): void {
  vi.stubEnv('HOME', dir);
  // Windows resolves the home directory from `USERPROFILE`, and `os.homedir()`
  // reads it first there. Pinned too, so the guarantee is not platform-shaped.
  vi.stubEnv('USERPROFILE', dir);
}
