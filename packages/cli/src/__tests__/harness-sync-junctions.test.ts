/**
 * The CLI half of DOR-1883: what a person on Windows reads when the links
 * DorkOS made are junctions and they are about to commit them.
 *
 * A junction resolves where the plan says, so nothing is drifted, nothing is
 * blocked, and the tree is clean — which is exactly why this sentence has to be
 * printed. Git sees a junction as a DIRECTORY: `git add` walks into it and
 * commits the skill's files a second time, and the committed tree holds no link
 * at all (measured on a `windows-latest` runner, DOR-1855).
 *
 * Its own file rather than a block inside `harness-sync.test.ts`, for the reason
 * `harness-sync-symlinks-off.test.ts` gives for being one: this is the whole of
 * what reaches somebody in that situation, and it is worth finding by name. The
 * `harness-sync` prefix is what puts it on the Windows CI leg
 * (`.github/workflows/harness-windows.yml` runs the prefix, not a file list).
 *
 * `process.platform` is redefined and the junction staged as what a junction IS
 * on disk — a link whose stored target is absolute — so the real command runs
 * over a real tree on this machine. The engine's own suite states why that is
 * the discriminator (`apply/windows-links.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';

import { JUNCTION_COMMIT_WARNING } from '@dorkos/harness';

import { runHarnessSync } from '../harness-sync-command.js';
import {
  createTempDir,
  pinEmptyClaudeRoot,
  syncArgs,
  writeFixtureRepo,
} from './harness-fixtures.js';

/** Every case drives the real engine over a real temp tree; a ceiling, not a budget. */
const SLOW_UNDER_LOAD_MS = 30_000;

describe('a Windows checkout whose links are junctions', () => {
  let tmpDir: string;
  let homeDir: string;
  let originalCwd: string;
  let logSpy: MockInstance<typeof console.log>;
  const realPlatform = process.platform;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    pinEmptyClaudeRoot(homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  /** The whole line a person reads, indented under the block's own heading. */
  const JUNCTION_LINE = `  - ${JUNCTION_COMMIT_WARNING}`;

  /**
   * The heading above it, pinned whole.
   *
   * It names the families this run carries and no others: this fixture's only
   * warning is the machine's, so a heading mentioning the target harness or an
   * unreadable declaration would be telling somebody about something that is
   * not in their tree.
   */
  const JUNCTION_HEADING = 'Warnings (may not commit as a link):';

  /**
   * Stage a fully projected git checkout whose skill link is a junction.
   *
   * Projected first, so the only thing left to say about the tree is the
   * junction — otherwise the ordinary drift of an unsynced fixture is what the
   * exit code is about and this file would be asserting nothing about DOR-1883.
   *
   * The link is then REPLACED by hand rather than left to the `--fix`, because a
   * `--fix` on this machine makes a POSIX symlink whatever `process.platform`
   * claims: the shape under test is the one Windows produces, and its stored
   * text — absolute — is what says so.
   */
  async function stageJunctionCheckout(): Promise<void> {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ fix: true }));

    const link = path.join(tmpDir, '.claude', 'skills', 'demo');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmpDir, '.agents', 'skills', 'demo'), link);
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    logSpy.mockClear();
  }

  it(
    'AP-06: --check warns before anybody commits, and still calls the tree clean',
    async () => {
      await stageJunctionCheckout();

      const check = await runHarnessSync(syncArgs({ check: true }));

      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain(`${JUNCTION_HEADING}\n\nthis machine:\n${JUNCTION_LINE}`);
      // Not drift, and not a conflict: the link works. Only committing it is
      // the problem, so the command that reports it still exits 0.
      expect(check.exitCode).toBe(0);
      expect(printed).toContain('No drift');
    },
    SLOW_UNDER_LOAD_MS
  );

  it(
    'AP-06: --fix says the same thing, so the two modes never disagree in print',
    async () => {
      await stageJunctionCheckout();

      const fix = await runHarnessSync(syncArgs({ fix: true }));

      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain(`${JUNCTION_HEADING}\n\nthis machine:\n${JUNCTION_LINE}`);
      expect(fix.exitCode).toBe(0);
    },
    SLOW_UNDER_LOAD_MS
  );

  it(
    'AP-06: says nothing on a checkout whose links git would commit as links',
    async () => {
      await stageJunctionCheckout();
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });

      await runHarnessSync(syncArgs({ check: true }));

      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('this machine:');
      expect(printed).not.toContain(JUNCTION_COMMIT_WARNING);
      // And the heading never advertises a family this run does not carry.
      expect(printed).not.toContain('may not commit as a link');
    },
    SLOW_UNDER_LOAD_MS
  );
});
