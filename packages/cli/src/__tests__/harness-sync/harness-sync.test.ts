import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HARNESS_MANIFEST_PATH } from '@dorkos/harness';
import { runHarnessSync, parseHarnessSyncArgs } from '../../harness-sync-command.js';
import { runHarnessDispatcher } from '../../commands/harness-dispatcher.js';
import {
  createTempDir,
  pinEmptyClaudeRoot,
  syncArgs,
  writeFixtureRepo,
} from '../harness-fixtures.js';
import {
  snapshotTree,
  writeFixtureRepoWithoutManifest,
  writeInstalledPlugin,
  writeFullInstalledPlugin,
} from '../harness-fixtures.js';

describe('parseHarnessSyncArgs', () => {
  it('throws with a clear message on unknown option', () => {
    expect(() => parseHarnessSyncArgs(['--nope'])).toThrow(
      /Unknown option for 'harness sync': --nope/
    );
  });
});

describe('runHarnessSync', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    // Hermetic dork home: the command resolves DORK_HOME (else ~/.dork) to scan
    // global installs, so point it at an empty temp dir to keep tests isolated
    // from the developer's real ~/.dork.
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    pinEmptyClaudeRoot(homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  // DOR-678: `--check` is the mode documented as safe to run any time. It used to
  // scaffold `.agents/harness.manifest.json` into whatever directory it was invoked
  // from, so a drift check run from the wrong folder silently created a file there.
  // These compare the whole path set before and after (see `snapshotTree`) rather
  // than the exit code — an exit-code-only test passed throughout the life of the
  // bug, and so did one that probed only the manifest path.
  describe('--check is read-only', () => {
    it('adds no path to the directory and exits 1 when no manifest exists', async () => {
      writeFixtureRepoWithoutManifest(tmpDir);
      process.chdir(tmpDir);
      const before = snapshotTree(tmpDir);

      const result = await runHarnessSync(syncArgs({ check: true, fix: false }));

      expect(snapshotTree(tmpDir)).toEqual(before);
      expect(fs.existsSync(path.join(tmpDir, '.agents', 'harness.manifest.json'))).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  it('AP-03: rejects an unknown --harness without writing anything', async () => {
    // A rejected argument must not leave a scaffolded manifest as its only lasting
    // effect: validation runs before disk is touched.
    writeFixtureRepoWithoutManifest(tmpDir);
    process.chdir(tmpDir);
    const before = snapshotTree(tmpDir);

    const result = await runHarnessSync(syncArgs({ check: false, fix: true, harness: 'bogus' }));

    expect(snapshotTree(tmpDir)).toEqual(before);
    expect(result.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness'));
  });

  it('J-03, TR-01, IN-01: scaffolds the tool DorkOS runs into a project that shows no sign of it', async () => {
    // A repo that has only ever run OpenCode: an `AGENTS.md` they wrote and a
    // `.opencode/`, no `.claude/` anywhere. Detection alone gives `codex,
    // opencode` and the pointer that makes their own AGENTS.md the instructions
    // a DorkOS session reads is never written (DOR-1901).
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# House rules\n');
    fs.mkdirSync(path.join(tmpDir, '.opencode', 'skills'), { recursive: true });
    process.chdir(tmpDir);

    const result = await runHarnessSync(syncArgs({ check: false, fix: true }));

    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, HARNESS_MANIFEST_PATH), 'utf8')
    ) as { harnesses: string[] };
    expect(manifest.harnesses).toEqual(['codex', 'opencode', 'claude-code']);
    // The set's provenance says which part of it their folder explains…
    expect(logSpy).toHaveBeenCalledWith(
      `No manifest found; wrote a default at ${HARNESS_MANIFEST_PATH} ` +
        '(detected harnesses plus Claude Code, because DorkOS runs it here: ' +
        'codex, opencode, claude-code) - edit to customize.'
    );
    // …and one plain line says what that one entry does for them.
    expect(logSpy).toHaveBeenCalledWith(
      'Claude Code is turned on because DorkOS runs it here; ' +
        '.claude/CLAUDE.md will point at your AGENTS.md.'
    );
    // …and the file it promises.
    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'CLAUDE.md'), 'utf8')).toBe(
      '@../AGENTS.md\n'
    );
  });

  it('TR-01, AP-01: reports drift on an unprojected fixture (--check) then applies and is idempotent (--fix)', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);

    // --check on the un-projected fixture: drift present.
    const firstCheck = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(firstCheck.exitCode).toBe(1);

    // --fix realizes the plan with no conflicts.
    const fix = await runHarnessSync(syncArgs({ check: false, fix: true }));
    expect(fix.exitCode).toBe(0);

    // The projected files now exist.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.lstatSync(path.join(tmpDir, '.claude', 'skills', 'demo')).isSymbolicLink()).toBe(
      true
    );
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks.json'))).toBe(true);

    // A second --check is clean.
    const secondCheck = await runHarnessSync(syncArgs({ check: false, fix: false }));
    expect(secondCheck.exitCode).toBe(0);
  });

  it('SRC-02: projects a project-scoped installed plugin when the dork home is empty (regression)', async () => {
    // The `dorkos harness sync` CLI runs offline — there are no GLOBAL installs.
    // Project-scoped installs (`.dork/plugins/<name>`) are repo-relative and MUST
    // still project. Previously they were ignored entirely. The empty temp
    // DORK_HOME (from beforeEach) stands in for a home with no global plugins.
    writeFixtureRepo(tmpDir);
    writeInstalledPlugin(tmpDir, 'acme', 'greet');
    process.chdir(tmpDir);

    // --check sees the installed skill as drift (it isn't projected yet).
    const check = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(check.exitCode).toBe(1);

    // --fix projects it: a namespaced symlink lands in the Codex skills dir.
    const fix = await runHarnessSync(syncArgs({ check: false, fix: true }));
    expect(fix.exitCode).toBe(0);
    const projected = path.join(tmpDir, '.agents', 'skills', 'acme__greet');
    expect(fs.lstatSync(projected).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(projected)).toBe(
      fs.realpathSync(path.join(tmpDir, '.dork', 'plugins', 'acme', 'skills', 'greet'))
    );
  });

  it('SK-03: tells the operator WHY a scheduled plugin skill is linked where no enabled harness reads (DOR-1518)', async () => {
    // A stock project: claude-code only. The scheduled skill is still linked
    // into `.agents/skills` for the DorkOS scheduler, and a bare
    // `[symlink] skill ... (codex)` line in a repo that does not run Codex is
    // exactly the sort of thing an operator would call arbitrary — so the
    // action's note has to reach them, not just sit on the object.
    fs.mkdirSync(path.join(tmpDir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code'] }, null, 2)
    );
    const plugin = path.join(tmpDir, '.dork', 'plugins', 'flow');
    fs.mkdirSync(path.join(plugin, '.dork'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'flow',
        version: '1.0.0',
        type: 'plugin',
        description: 'A fixture plugin',
        layers: ['skills'],
      })
    );
    fs.mkdirSync(path.join(plugin, 'skills', 'drain'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, 'skills', 'drain', 'SKILL.md'),
      "---\nname: drain\ndescription: Drains the queue\nschedule:\n  cron: '0 9 * * *'\n---\nDrain it.\n"
    );
    process.chdir(tmpDir);

    const fix = await runHarnessSync(syncArgs({ check: false, fix: true }));
    expect(fix.exitCode).toBe(0);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('.agents/skills/flow__drain');
    expect(printed).toMatch(/flow__drain.*—.*scheduler/);
  });

  it('HK-09: prints what a rotted plugin hooks.json lost during salvage (DOR-1724)', async () => {
    // The salvage keeps what the file still says clearly and drops the rest
    // (DOR-646). This report is where a person is told a hook stopped being
    // installed — and since DOR-1849 it appears once the package's hooks are
    // actually going in, which is when losing one of them means anything.
    writeFixtureRepo(tmpDir);
    writeInstalledPlugin(tmpDir, 'acme', 'greet');
    const hooksDir = path.join(tmpDir, '.dork', 'plugins', 'acme', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        Stop: [{ hooks: [{ command: 'still-good.sh' }] }, { hooks: 'rotted' }],
        PostToolUse: [{ hooks: [{ type: 'command' }] }],
      })
    );
    process.chdir(tmpDir);

    const fix = await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme'] }));
    expect(fix.exitCode).toBe(0);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The file, both affected events, and the difference between "some of this
    // event survived" and "this event is gone entirely".
    expect(printed).toContain('.dork/plugins/acme/hooks/hooks.json');
    expect(printed).toContain(
      'hook "acme:Stop": .dork/plugins/acme/hooks/hooks.json declares one or more unusable matcher groups under "Stop", so those were dropped and only the readable ones are projected'
    );
    expect(printed).toContain(
      'hook "acme:PostToolUse": .dork/plugins/acme/hooks/hooks.json declares "PostToolUse" in a shape this reader cannot use, so the whole event was dropped and no "PostToolUse" hook is projected'
    );
    // The salvaged half really did install.
    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.local.json'), 'utf8')).toContain(
      'still-good.sh'
    );
  });

  it('AP-05: --check reports a dead link at a generated file as drift instead of crashing', async () => {
    // The file was moved away and a broken link left behind. There is nothing to
    // read at that path, so there is no ownership question — it is stale, and
    // saying so is the whole job. This used to throw ENOENT out of `checkPlan`
    // and print a stack trace over the report.
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ check: false, fix: true })); // project everything first
    fs.rmSync(path.join(tmpDir, '.codex', 'hooks.json'), { force: true });
    fs.symlinkSync('hooks.json.bak', path.join(tmpDir, '.codex', 'hooks.json'));
    logSpy.mockClear();

    const check = await runHarnessSync(syncArgs({ check: true, fix: false }));

    expect(check.exitCode).toBe(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Drift detected');
    expect(printed).toContain('.codex/hooks.json');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('SK-10: --check names a link whose skill is gone, and --fix sweeps it', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ check: false, fix: true })); // project `demo`
    const projected = path.join(tmpDir, '.claude', 'skills', 'demo');
    expect(fs.lstatSync(projected).isSymbolicLink()).toBe(true);

    // The person deletes the skill. Its projection is now a link to nothing.
    fs.rmSync(path.join(tmpDir, '.agents', 'skills', 'demo'), { recursive: true, force: true });
    logSpy.mockClear();

    const check = await runHarnessSync(syncArgs({ check: true, fix: false }));

    expect(check.exitCode).toBe(1);
    const checkOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(checkOutput).toContain('Orphaned projections — what they came from is gone (1):');
    expect(checkOutput).toContain('.claude/skills/demo');
    // Read-only: the dead link is still there after a check.
    expect(fs.lstatSync(projected).isSymbolicLink()).toBe(true);

    logSpy.mockClear();
    const fix = await runHarnessSync(syncArgs({ check: false, fix: true }));

    expect(fix.exitCode).toBe(0);
    const fixOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(fixOutput).toMatch(/Swept 1 orphaned[\s\S]*\.claude\/skills\/demo/);
    expect(fs.existsSync(projected)).toBe(false);
    expect((await runHarnessSync(syncArgs({ check: true, fix: false }))).exitCode).toBe(0);
  });

  it('keeps the skills of a running extension the server listed, and sweeps them once it stops (DOR-2685)', async () => {
    // Purpose: a terminal sync reads the same running-skills ledger the server
    // writes, so it plans the same links and its sweep never removes a running
    // extension's skills. A dev-linked copy says so in the drift it reports.
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    const repo = fs.realpathSync(tmpDir);
    const skillsDir = path.join(repo, '.dork', 'extensions', 'mail', 'skills');
    fs.mkdirSync(path.join(skillsDir, 'triage-inbox'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'triage-inbox', 'SKILL.md'),
      '---\nname: triage-inbox\ndescription: Sort the inbox.\n---\nSort it.\n'
    );
    const writeLedger = (extensions: unknown[]): void => {
      fs.mkdirSync(path.join(homeDir, 'extensions'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, 'extensions', 'running-skills.json'),
        JSON.stringify({ version: 1, extensions })
      );
    };
    writeLedger([
      {
        id: 'mail',
        scope: 'local',
        projectRoot: repo,
        skillsDir,
        skills: ['triage-inbox'],
        devLink: '/work/mail',
      },
    ]);

    const before = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(before.exitCode).toBe(1);
    const drift = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(drift).toContain('mail__triage-inbox');
    expect(drift).toContain('(dev link: /work/mail)');

    expect((await runHarnessSync(syncArgs({ check: false, fix: true }))).exitCode).toBe(0);
    const link = path.join(repo, '.claude', 'skills', 'mail__triage-inbox');
    expect(fs.realpathSync(link)).toBe(path.join(skillsDir, 'triage-inbox'));
    // Run again from the terminal: nothing to sweep, nothing drifted.
    logSpy.mockClear();
    expect((await runHarnessSync(syncArgs({ check: false, fix: true }))).exitCode).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect((await runHarnessSync(syncArgs({ check: true, fix: false }))).exitCode).toBe(0);

    // The extension stopped: the server's ledger no longer lists it.
    writeLedger([]);
    logSpy.mockClear();
    expect((await runHarnessSync(syncArgs({ check: false, fix: true }))).exitCode).toBe(0);
    expect(fs.existsSync(link)).toBe(false);
  });

  /**
   * The nine paths an uninstalled `acme` leaves behind, each with the sentence
   * the engine gives for it — the one list `--check` promises and `--fix`
   * receipts, verbatim in both.
   *
   * Every line carries a REASON, and they are not all the same one (DOR-1906):
   * two links go because the package is gone, two hooks paths because nothing
   * projects hooks there any more, four wrappers because the command's package
   * is gone, and the settings file is not removed at all. A heading cannot say
   * five things at once, which is why the count on its own was never enough.
   */
  const ORPHAN_LINES = [
    '  .agents/skills/acme__greet — The package this skill came from is no longer installed here.',
    '  .claude/commands/acme/.gitignore — The package this command came from is no longer installed here.',
    '  .claude/commands/acme/hello.md — The package this command came from is no longer installed here.',
    '  .claude/settings.local.json — Only the hook entries DorkOS added go; your own settings stay.',
    '  .claude/skills/acme__greet — The package this skill came from is no longer installed here.',
    '  .codex/hooks.json — DorkOS wrote this, and no hooks project here any more.',
    '  .codex/hooks.json.dorkos-generated — DorkOS wrote this, and no hooks project here any more.',
    '  .opencode/commands/.gitignore — The package this command came from is no longer installed here.',
    '  .opencode/commands/acme-hello.md — The package this command came from is no longer installed here.',
  ];

  it('--check names every path an uninstalled plugin left, and --fix removes exactly those', async () => {
    // Before DOR-1889 this exited 0 and said nothing: `checkPlan` answered for
    // one sweep of six, so a tree a `--fix` was about to take nine files out of
    // read clean. `--allow-hooks` is here because the plugin ships hooks and
    // nobody has said yes to them yet — without it the hook projections never
    // land, and the case would prove less than the whole sweep.
    //
    // Seeded defect for the reasons half (DOR-1906): print the count and the
    // bare paths — the shape this report had before — and both blocks red, in
    // the check and in the fix, because `ORPHAN_LINES` is the whole line.
    fs.mkdirSync(path.join(tmpDir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex', 'opencode'] }, null, 2)
    );
    writeFullInstalledPlugin(tmpDir, 'acme');
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ check: false, fix: true, allowHooks: ['acme'] }));

    // The plugin is uninstalled. Nothing else about the tree changes.
    fs.rmSync(path.join(tmpDir, '.dork', 'plugins', 'acme'), { recursive: true, force: true });
    logSpy.mockClear();

    const check = await runHarnessSync(syncArgs({ check: true, fix: false }));

    expect(check.exitCode).toBe(1);
    const checkOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Verbatim, including the one line that is NOT a deletion: the settings file
    // survives and loses only the hook entries DorkOS merged into it, and a
    // report that said "removed" over it without saying so would be the same
    // sort of untruth this whole change is about.
    expect(checkOutput).toContain(
      ['Orphaned projections — what they came from is gone (9):', ...ORPHAN_LINES].join('\n')
    );
    expect(checkOutput).toContain(
      'Run `dorkos harness sync --fix` to apply — the orphaned paths above are removed.'
    );
    // Read-only: everything it just named is still on disk.
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks.json'))).toBe(true);

    logSpy.mockClear();
    const fix = await runHarnessSync(syncArgs({ check: false, fix: true }));

    expect(fix.exitCode).toBe(0);
    const fixOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The same nine, in the same order, under the sweep's own heading: the
    // receipt a person reads after the command lines up with the promise the
    // one before it made. `swept` itself comes back in sweep order; the report
    // sorts it for display so the two lists can be compared line for line.
    expect(fixOutput).toContain(
      ['Swept 9 orphaned projection(s) — what they came from is gone:', ...ORPHAN_LINES].join('\n')
    );
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'acme'))).toBe(false);
    // The one line that promised survival kept its promise: the file is still
    // there, and the managed hook groups are what left it.
    const settings = path.join(tmpDir, '.claude', 'settings.local.json');
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.readFileSync(settings, 'utf8')).not.toContain('echo acme');
    // And the tree is clean afterwards, so the report cannot come straight back.
    expect((await runHarnessSync(syncArgs({ check: true, fix: false }))).exitCode).toBe(0);
  });

  it('AP-11: turns an engine failure into one line, not a stack trace', async () => {
    // Defence in depth: whatever the projection engine throws — here a manifest
    // somebody typo'd into invalid JSON — a person gets a sentence and exit 1.
    writeFixtureRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.agents', 'harness.manifest.json'), '{ not json');
    process.chdir(tmpDir);

    const check = await runHarnessSync(syncArgs({ check: true, fix: false }));

    expect(check.exitCode).toBe(1);
    const errors = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errors.join('\n')).toContain('Harness sync failed');
    expect(errors.join('\n')).not.toContain('\n    at ');
  });
});

describe('runHarnessDispatcher', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('prints help (not a parse error) for `harness` with no subcommand', async () => {
    expect(await runHarnessDispatcher(undefined, [])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: dorkos harness'));
  });

  it('returns exit code 1 for an unknown subcommand', async () => {
    expect(await runHarnessDispatcher('bogus', [])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness subcommand'));
  });
});
