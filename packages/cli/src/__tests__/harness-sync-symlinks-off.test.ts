/**
 * The CLI half of J-10: what a person reads when their checkout could not make
 * the symlinks.
 *
 * Its own file rather than a block inside `harness-sync.test.ts`, for two
 * reasons. The sentence pinned here is the ONLY thing that reaches somebody
 * whose clone has `core.symlinks` off, so it is worth finding by name; and one
 * of these cases has to run in a CHILD PROCESS, which is machinery the rest of
 * that suite does not carry.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';

import { runHarnessSync } from '../harness-sync-command.js';
import { createTempDir, syncArgs, writeFixtureRepo } from './harness-fixtures.js';

/**
 * Every case here drives the real engine over a real temp tree, and one of them
 * spawns two child processes. On a shared runner under load that is well past
 * vitest's 5000 ms default — measured at 5.4 s on a machine running many agents
 * at once, and the merge queue's four shards are exactly that kind of machine.
 * A ceiling, not a budget: it bounds a wedged child rather than describing how
 * long these should take.
 */
const SLOW_UNDER_LOAD_MS = 30_000;

describe('a checkout that could not make the links', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    // Hermetic dork home, exactly as in `harness-sync.test.ts`: the command
    // resolves DORK_HOME (else ~/.dork) to scan global installs.
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  /**
   * The WHOLE line a person on a symlink-less checkout reads, verbatim.
   *
   * Pinned as one string rather than by two substrings on purpose: this is the
   * only sentence that reaches somebody whose clone git could not make links in,
   * and half of it — the two ways out — is the half a substring check would let
   * anybody delete. If this line changes, change it here too and read it aloud
   * first.
   */
  const SYMLINKS_OFF_LINE =
    '  [symlink] skill "demo" -> .claude/skills/demo  (claude-code) — blocked by a plain file ' +
    "holding this link's own text — symlinks are turned off in this checkout, so git could not " +
    'create the link. Turn them on with `git config core.symlinks true` and check the file out ' +
    'again, or run `dorkos harness sync --fix` in a checkout that can make links';

  /**
   * Stage what a teammate's clone looks like when git could not make the link: a
   * plain file holding the path the link should have pointed at (J-10).
   *
   * Staged directly rather than through a clone — the engine's journey test owns
   * the real `git clone -c core.symlinks=false`; these own the printed text,
   * which is the whole of what the person on that checkout sees.
   */
  async function stageSymlinksOffCheckout(): Promise<void> {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ fix: true })); // project `demo`
    const projected = path.join(tmpDir, '.claude', 'skills', 'demo');
    // Exactly what git writes for a symlink blob: the relative target path,
    // spelled with POSIX separators on every platform. Deliberately NOT
    // `readlinkSync`, which on Windows answers the junction's ABSOLUTE target
    // and would stage a different shape entirely (measured on a windows-latest
    // runner, DOR-1855).
    fs.rmSync(projected, { force: true });
    fs.writeFileSync(projected, '../../.agents/skills/demo');
    logSpy.mockClear();
  }

  it(
    'J-10, AP-06: --check explains a checkout with symlinks turned off, instead of calling it drift',
    async () => {
      await stageSymlinksOffCheckout();

      const check = await runHarnessSync(syncArgs({ check: true }));

      expect(check.exitCode).toBe(1);
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain(SYMLINKS_OFF_LINE);
      // The report used to say the opposite of the truth: the link was "drift",
      // and the way out was to run the `--fix` that would then refuse it.
      expect(printed).not.toContain('Drift detected');
      expect(printed).not.toContain('Run `dorkos harness sync --fix` to apply.');
    },
    SLOW_UNDER_LOAD_MS
  );

  it(
    'J-10, AP-06: --fix says the same thing, so the two modes never disagree in print',
    async () => {
      // The mode a person reaches for after reading `--check`. It refuses, and the
      // refusal has to carry the way out — otherwise the sentence that names
      // `git config core.symlinks true` is only ever printed by the command they
      // have already run.
      await stageSymlinksOffCheckout();

      const fix = await runHarnessSync(syncArgs({ fix: true }));

      expect(fix.exitCode).toBe(1);
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('1 conflict(s) left untouched');
      expect(printed).toContain(SYMLINKS_OFF_LINE);
      // Their file is theirs: the plain file git wrote is still exactly that.
      expect(fs.readFileSync(path.join(tmpDir, '.claude', 'skills', 'demo'), 'utf8')).toBe(
        '../../.agents/skills/demo'
      );
    },
    SLOW_UNDER_LOAD_MS
  );

  it(
    'AP-04: never hangs on a named pipe at a link target, and calls it an ordinary conflict',
    (ctx) => {
      // `occupantKind` answers `'file'` for anything real that is not a directory,
      // a FIFO included, and `readFileSync` on a FIFO with no writer BLOCKS IN
      // `open(2)` forever. A named pipe at `.claude/skills/<x>` therefore used to
      // wedge `--check` and `--fix` outright — the commands whose whole job is to
      // tell somebody what is wrong with their tree.
      //
      // THIS ASSERTION LIVES IN A CHILD PROCESS, and that is the only shape that
      // can fail rather than hang: nothing inside a Node process can interrupt a
      // synchronous block — not a vitest timeout, not a signal handler — so an
      // in-process version of this test would take the whole suite down with it
      // instead of going red. The child reaches the engine through
      // `@dorkos/harness`, i.e. through `dist/`, which is the same resolution the
      // rest of this file already relies on (turbo builds it as this package's
      // dependency before `test`).
      if (process.platform === 'win32') {
        ctx.skip('Windows has no mkfifo, and no shape at a link target can block a read there');
      }
      writeFixtureRepo(tmpDir);
      process.chdir(tmpDir);
      const projected = path.join(tmpDir, '.claude', 'skills', 'demo');
      fs.mkdirSync(path.dirname(projected), { recursive: true });
      const made = spawnSync('mkfifo', [projected]);
      expect({ mkfifo: made.status }, String(made.stderr)).toEqual({ mkfifo: 0 });
      expect(fs.lstatSync(projected).isFIFO()).toBe(true);

      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          [
            "const { project, checkPlan } = await import('@dorkos/harness');",
            'const root = process.env.FIFO_REPO;',
            'const drift = checkPlan(root, project(root));',
            'process.stdout.write(JSON.stringify({',
            '  blocked: drift.blocked.map((a) => a.target),',
            '  clean: drift.clean,',
            '}));',
          ].join('\n'),
        ],
        {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          encoding: 'utf8',
          timeout: 15_000,
          killSignal: 'SIGKILL',
          // eslint-disable-next-line no-restricted-syntax -- a child process needs the real environment to find node and the workspace's node_modules
          env: { ...process.env, FIFO_REPO: tmpDir },
        }
      );

      // A hang shows up here as a signal, not as a wrong answer.
      expect({ status: child.status, signal: child.signal }, child.stderr).toEqual({
        status: 0,
        signal: null,
      });
      expect(JSON.parse(child.stdout) as unknown).toEqual({
        blocked: ['.claude/skills/demo'],
        clean: false,
      });
    },
    SLOW_UNDER_LOAD_MS
  );
});
