import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runHarnessSync } from '../../harness-sync-command.js';
import {
  createTempDir,
  pinEmptyClaudeRoot,
  pinHome,
  syncArgs,
  writeFixtureRepo,
} from '../harness-fixtures.js';
import { snapshotTree } from '../harness-fixtures.js';

/**
 * SRC-08, J-07 and HK-14's user half at the CLI: the "Installed in Claude Code
 * only" block, where it sits in the report, and what happens to the rest of the
 * report when the settings file cannot be read.
 *
 * The block is assembled here, beside `formatDropList`'s output and never inside
 * it — putting it in the engine would make `@dorkos/harness` read a home
 * directory, which three of its own module docs forbid by name. So its POSITION
 * is the thing worth pinning: it belongs after the drops, which are about this
 * project, and before the not-enabled notices, which are about what to turn on
 * next.
 */
describe('runHarnessSync — what Claude Code alone has', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let claudeRoot: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  /** Everything the run printed, as one string. */
  const printed = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

  /** Stage `<claudeRoot>/settings.json`. */
  function writeClaudeSettings(settings: unknown): void {
    fs.writeFileSync(
      path.join(claudeRoot, 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2)
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    claudeRoot = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeRoot);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFixtureRepo(tmpDir);
    // A harness on disk the manifest does not enable, so the not-enabled notice
    // this block has to precede is really in the output.
    fs.mkdirSync(path.join(tmpDir, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cursor', 'rules', 'x.mdc'), '# rules\n');
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    for (const dir of [tmpDir, homeDir, claudeRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Seeded defect one: move the block above `formatDropList`, and the ordering
  // below reds.
  it('SRC-08, J-07, HK-14: prints the block after the drops and before the not-enabled notices', async () => {
    writeClaudeSettings({
      enabledPlugins: {
        'context7@claude-plugins-official': true,
        'persona-toolkit@dork-labs': true,
        'never-turned-on@claude-plugins-official': false,
      },
      extraKnownMarketplaces: {
        'claude-plugins-official': {
          source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
        },
      },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Sounds/Glass.aiff' }] }],
      },
    });

    const result = await runHarnessSync(syncArgs({ check: true }));

    const output = printed();
    const drops = output.search(/Dropped artifacts|No drops/);
    const block = output.indexOf('Installed in Claude Code only');
    const notEnabled = output.indexOf('is not enabled');
    expect({ drops: drops >= 0, block: block >= 0, notEnabled: notEnabled >= 0 }).toEqual({
      drops: true,
      block: true,
      notEnabled: true,
    });
    expect(drops).toBeLessThan(block);
    expect(block).toBeLessThan(notEnabled);

    // The root it read, the count, the two rungs, and HK-14's line — the whole
    // block, in its frozen wording.
    expect(output).toContain(`  Read from ${claudeRoot}`);
    expect(output).toContain(
      '  You turned on 2 plugins in Claude Code. Your other agent tools cannot see them.'
    );
    expect(output).toContain(
      '  Your personal Claude Code settings run 1 command automatically. Only Claude Code runs it.'
    );
    expect(output).toContain(
      '  DorkOS can install these for this project, so every agent tool here gets them:'
    );
    expect(output).toContain('    - context7 (from anthropics/claude-plugins-official)');
    // ABSOLUTE, never `.`. The command is sent to a running server, which
    // resolves `projectPath` in ITS process: a `.` there means the directory the
    // server was started in, so the offer either 403s outside the boundary or
    // silently installs into whatever project the server happens to be sitting
    // in. Seeded defect: put `--project .` back.
    // `realpathSync`, because the command carries `process.cwd()` and macOS
    // resolves `/var` to `/private/var` on the way in. That the two spellings
    // differ is the point: an absolute path is a path, and `.` is a question the
    // server answers about itself.
    expect(output).toContain(`  Run: dorkos install context7 --project ${fs.realpathSync(tmpDir)}`);
    expect(output).not.toContain('--project .');
    expect(output).toContain(
      '  DorkOS has to be running, and it asks you to approve the install first.'
    );
    expect(output).toContain('  DorkOS cannot tell where these came from:');
    expect(output).toContain('    - persona-toolkit (from a source Claude Code calls "dork-labs")');
    expect(output).toContain(
      '  Your company can also turn plugins on or off, in a settings file DorkOS cannot read. So this list may'
    );
    expect(output).toContain('  not be the whole story.');
    // A plugin nobody turned on is not something anybody is missing.
    expect(output).not.toContain('never-turned-on');
    // Nothing is installed from here: the offer is a printed command.
    expect(result.exitCode).toBe(1);
  });
});

/**
 * Whether this machine can make a directory unreadable at all.
 *
 * `chmod 000` is the only way to stage that case, and two platforms ignore it.
 * Windows has no POSIX mode bits, so the `chmod` is a no-op, the scan succeeds
 * and `unreadableRoot` is never set — measured on the advisory `harness-windows`
 * job. Root ignores permission bits by definition, which is every root CI
 * container.
 *
 * **A green run on either is NOT evidence this path is covered.** It is
 * exercised on POSIX as a non-root user, where the assertion is exactly as
 * strong as it was; nothing is weakened to make the skip possible.
 */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('runHarnessSync --global — the packages installed for all your projects', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let userHome: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  /** Everything the run printed, in order, so a promise can be located before a deletion. */
  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** Install a package for all projects, holding the skills named. */
  function installGlobal(name: string, skills: readonly { name: string; timed?: boolean }[]): void {
    const dir = path.join(homeDir, 'plugins', name);
    fs.mkdirSync(path.join(dir, '.dork'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dork', 'manifest.json'),
      JSON.stringify({ name, version: '1.0.0', type: 'plugin', description: name })
    );
    for (const skill of skills) {
      fs.mkdirSync(path.join(dir, 'skills', skill.name), { recursive: true });
      const schedule = skill.timed === true ? "schedule:\n  cron: '0 9 * * *'\n" : '';
      fs.writeFileSync(
        path.join(dir, 'skills', skill.name, 'SKILL.md'),
        `---\nname: ${skill.name}\ndescription: The ${skill.name} skill\n${schedule}---\n\n# ${skill.name}\n`
      );
    }
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    userHome = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    pinEmptyClaudeRoot(homeDir);
    // The user tier resolves `~/.agents/skills` through `os.homedir()`, so a
    // global case would otherwise read the developer's own home directory.
    pinHome(userHome);
    process.chdir(tmpDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(userHome, { recursive: true, force: true });
    // Mode first: `rmSync -r` has to read a directory to empty it, so the
    // mode-000 one the unreadable-root case stages would leak the temp tree.
    try {
      fs.chmodSync(path.join(homeDir, 'plugins'), 0o755);
    } catch {
      /* no plugins folder, or already readable */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('SK-03: links a scheduled skill from a package installed for all projects, from a folder with no manifest', async () => {
    // No manifest anywhere in this directory: `--global` is a different subject
    // and must not go looking for one.
    installGlobal('globex', [{ name: 'daily-sweep', timed: true }]);

    const result = await runHarnessSync(syncArgs({ fix: true, global: true }));

    expect(result.exitCode).toBe(0);
    expect(fs.lstatSync(path.join(homeDir, 'skills', 'globex__daily-sweep')).isSymbolicLink()).toBe(
      true
    );
    const output = printed();
    expect(output).toContain('Linked 1 link(s):');
    expect(output).toContain('skill runs on a timer');
    expect(output).toContain(
      'It does not share them with Claude Code, Codex or any other agent tool yet.'
    );
  });

  it('SK-03: names every link it will remove BEFORE removing it, and again after', async () => {
    // Seeded defect: apply before printing the removals. The promise then lands
    // after the deletion, and the index comparison below reds.
    installGlobal('globex', [{ name: 'greet' }]);
    installGlobal('acme', [{ name: 'build' }]);
    await runHarnessSync(syncArgs({ fix: true, global: true }));
    logSpy.mockClear();

    // An uninstall: the package directory goes, and its link is now an orphan.
    fs.rmSync(path.join(homeDir, 'plugins', 'acme'), { recursive: true, force: true });
    // `lstat`, not `existsSync`: the package went first, so the link it left is
    // now DANGLING — which is the whole point, and is exactly the shape
    // `existsSync` answers `false` for.
    const removed = path.join(homeDir, 'skills', 'acme__build');
    expect(fs.lstatSync(removed, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);

    // Console ORDER cannot answer this on its own: printing the promise after
    // the deletion still puts it above the receipt. So each line is recorded
    // with what was on disk AT THE MOMENT it was printed.
    const trace: { text: string; linkStillThere: boolean }[] = [];
    logSpy.mockImplementation((...printedArgs: unknown[]) => {
      trace.push({
        text: String(printedArgs[0]),
        linkStillThere: fs.lstatSync(removed, { throwIfNoEntry: false }) !== undefined,
      });
    });

    await runHarnessSync(syncArgs({ fix: true, global: true }));

    const naming = trace.filter((entry) => entry.text.includes(removed));
    expect(naming).toHaveLength(2);
    // Named first while it was still there, and again once it was gone.
    expect(naming.map((entry) => entry.linkStillThere)).toEqual([true, false]);
    const headings = trace.map((entry) => entry.text);
    expect(headings.some((t) => t.includes('Removing 1 link(s)'))).toBe(true);
    expect(headings.some((t) => t.includes('Removed 1 link(s)'))).toBe(true);
    // Each line carries the engine's own sentence for that path, promised and
    // delivered in the same words (DOR-1906).
    expect(
      naming.every((entry) => entry.text.includes('no longer installed for all your projects.'))
    ).toBe(true);
    expect(fs.lstatSync(removed, { throwIfNoEntry: false })).toBeUndefined();
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'SK-03: a skill folder it cannot look inside keeps its link, and says which folder',
    async () => {
      // DOR-1935. Seeded defect: let the scan decide "is this a skill?" with
      // `existsSync(<dir>/SKILL.md)`, which needs `x` on `<dir>`. The folder then
      // is not a skill, the plan stops naming its link, and clause 4 of the sweep
      // — the package is on disk AND the plan enumerated it — removes the link
      // with nothing printed.
      installGlobal('globex', [{ name: 'greet', timed: true }, { name: 'wave' }]);
      await runHarnessSync(syncArgs({ fix: true, global: true }));
      const linked = path.join(homeDir, 'skills', 'globex__greet');
      expect(fs.lstatSync(linked, { throwIfNoEntry: false })).toBeDefined();
      logSpy.mockClear();

      const skillDir = path.join(homeDir, 'plugins', 'globex', 'skills', 'greet');
      fs.chmodSync(skillDir, 0o000);
      try {
        const result = await runHarnessSync(syncArgs({ fix: true, global: true }));

        expect(result.exitCode).toBe(0);
        expect(printed()).toContain('could not look inside');
        // The folder is named ONCE on the line. Measured before: an absolute
        // path printed twice, as the entry's name and again in the sentence.
        const line = printed()
          .split('\n')
          .find((l) => l.includes(skillDir));
        expect(line).toBeDefined();
        expect(line?.split(skillDir)).toHaveLength(2);
        expect(printed()).not.toContain('Removed 1 link(s)');
        expect(fs.lstatSync(linked, { throwIfNoEntry: false })).toBeDefined();
        // The sibling is untouched, so this is containment rather than a sweep
        // switched off.
        expect(
          fs.lstatSync(path.join(homeDir, 'skills', 'globex__wave'), { throwIfNoEntry: false })
        ).toBeDefined();
      } finally {
        fs.chmodSync(skillDir, 0o755);
      }
    }
  );

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'SK-03: a packages folder it cannot read stops the run and removes nothing',
    async () => {
      // Seeded defect: drop the `unreadableRoot` guard. The plan is empty because
      // nobody could read the folder, the sweep reads a plan as its evidence of
      // what is installed, and every global link goes.
      installGlobal('globex', [{ name: 'greet', timed: true }]);
      await runHarnessSync(syncArgs({ fix: true, global: true }));
      const linked = path.join(homeDir, 'skills', 'globex__greet');
      expect(fs.lstatSync(linked, { throwIfNoEntry: false })).toBeDefined();
      logSpy.mockClear();

      fs.chmodSync(path.join(homeDir, 'plugins'), 0o000);
      try {
        const result = await runHarnessSync(syncArgs({ fix: true, global: true }));

        expect(result.exitCode).toBe(1);
        expect(printed()).toContain('so nothing was linked and nothing was removed');
        expect(fs.lstatSync(linked, { throwIfNoEntry: false })).toBeDefined();
      } finally {
        fs.chmodSync(path.join(homeDir, 'plugins'), 0o755);
      }
    }
  );
});

/**
 * S8 — the one place somebody who turned `harness.autoAdopt` on learns why
 * nothing happened in their own repository (DOR-1853, contract §16 D3).
 *
 * The flag is one global boolean and a config write has no project in hand, so
 * it is accepted at write time and read at exactly two call sites in the server,
 * both inside a folder DorkOS owns. Everywhere else it is inert by construction
 * — and the terminal is what says so.
 */
describe('runHarnessSync: harness.autoAdopt in a folder DorkOS does not own', () => {
  let tmpDir: string;
  let homeDir: string;
  let originalCwd: string;
  let logSpy: MockInstance<typeof console.log>;

  /** Everything `console.log` was handed, joined — the terminal as a person reads it. */
  const printed = (): string => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

  /** B1's frozen sentence, spelled out rather than imported from what produced it. */
  const S8 =
    'harness.autoAdopt is on, and it does nothing here: DorkOS only moves skills on its own inside the agent folders it owns. Run dorkos harness adopt <name> to move one yourself.';

  /** Write `config.json` into the staged dork home with the flag at `value`. */
  function writeAutoAdopt(value: boolean): void {
    fs.writeFileSync(
      path.join(homeDir, 'config.json'),
      JSON.stringify({ version: 1, harness: { autoAdopt: value } }, null, 2)
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    pinEmptyClaudeRoot(homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFixtureRepo(tmpDir);
    // A real skill in Claude Code's own folder, so the run has something to
    // report as adoptable beside the sentence about the flag.
    fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'local'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'skills', 'local', 'SKILL.md'),
      '---\nname: local\ndescription: Portable\n---\n\nDo the thing.\n'
    );
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('D3: --check prints S8 exactly once and moves nothing', async () => {
    // Seeded defect: read the flag in `runAutoProjection`. The skill moves, and
    // the whole-tree snapshot reds beside this sentence.
    writeAutoAdopt(true);
    const before = snapshotTree(tmpDir);

    await runHarnessSync(syncArgs({ check: true, fix: false }));

    const occurrences = printed().split(S8).length - 1;
    expect(occurrences).toBe(1);
    expect(snapshotTree(tmpDir)).toEqual(before);
  });

  it('D3: --fix prints it too, and still moves nothing', async () => {
    writeAutoAdopt(true);

    await runHarnessSync(syncArgs({ check: false, fix: true }));

    expect(printed().split(S8).length - 1).toBe(1);
    // The projection wrote its own links; the skill a person authored did not
    // move out of Claude Code's folder.
    expect(fs.lstatSync(path.join(tmpDir, '.claude', 'skills', 'local')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'skills', 'local'))).toBe(false);
  });
});
