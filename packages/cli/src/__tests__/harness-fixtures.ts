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
