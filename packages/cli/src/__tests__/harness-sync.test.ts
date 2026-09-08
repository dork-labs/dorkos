import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';

import { HARNESS_MANIFEST_PATH } from '@dorkos/harness';

import { runHarnessSync, parseHarnessSyncArgs } from '../harness-sync-command.js';
import { runHarnessHooks, parseHarnessHooksArgs } from '../harness-hooks-command.js';
import { hookApprovalEntry } from '../../server/services/harness/hook-consent.js';
import { runHarnessDispatcher } from '../commands/harness-dispatcher.js';
import { createTempDir, syncArgs, writeFixtureRepo } from './harness-fixtures.js';

/**
 * The sorted set of every path under `root`.
 *
 * This measures the tree's SHAPE — which paths exist — and nothing else: not file
 * contents, not mtimes. So it catches any *new* path a read-only mode leaves
 * behind (a manifest, a dotdir, a projected symlink) anywhere under the root,
 * which is the failure this suite exists to catch, but an in-place rewrite of a
 * file that already existed would pass it. No check-mode path can reach such a
 * rewrite today; if one ever can, this helper has to start hashing contents.
 */
function snapshotTree(root: string): string[] {
  const walk = (dir: string, prefix: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Never follow symlinks: a projected link is itself the change under test.
        return entry.isDirectory() && !entry.isSymbolicLink()
          ? [rel, ...walk(path.join(dir, entry.name), rel)]
          : [rel];
      })
      .sort();
  return walk(root, '');
}

/**
 * Like {@link writeFixtureRepo} but WITHOUT the hand-authored manifest, so the
 * missing-manifest path is exercised. The skill, settings, and AGENTS.md still
 * give the projection real drift to report once a manifest exists.
 */
function writeFixtureRepoWithoutManifest(root: string): void {
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'demo'), { recursive: true });
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

describe('parseHarnessSyncArgs', () => {
  it('defaults both flags to false with no args', () => {
    const args = parseHarnessSyncArgs([]);
    expect(args).toEqual({
      check: false,
      fix: false,
      harness: undefined,
      strict: false,
      allowHooks: [],
      enable: [],
      writeGitignore: false,
    });
  });

  it('parses --check and --fix booleans', () => {
    expect(parseHarnessSyncArgs(['--check'])).toEqual({
      check: true,
      fix: false,
      harness: undefined,
      strict: false,
      allowHooks: [],
      enable: [],
      writeGitignore: false,
    });
    expect(parseHarnessSyncArgs(['--fix'])).toEqual({
      check: false,
      fix: true,
      harness: undefined,
      strict: false,
      allowHooks: [],
      enable: [],
      writeGitignore: false,
    });
  });

  it('captures --harness codex', () => {
    const args = parseHarnessSyncArgs(['--check', '--harness', 'codex']);
    expect(args.check).toBe(true);
    expect(args.harness).toBe('codex');
  });

  it('throws with a clear message on unknown option', () => {
    expect(() => parseHarnessSyncArgs(['--nope'])).toThrow(
      /Unknown option for 'harness sync': --nope/
    );
  });
});

/** Write a project-scoped installed plugin (`.dork/plugins/<name>`) with one skill. */
function writeInstalledPlugin(root: string, name: string, skill: string): void {
  const plugin = path.join(root, '.dork', 'plugins', name);
  fs.mkdirSync(path.join(plugin, '.dork'), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'plugin',
      description: 'A fixture plugin',
      layers: ['skills'],
    })
  );
  fs.mkdirSync(path.join(plugin, 'skills', skill), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
}

/**
 * A project-scoped plugin shipping all three layers a sync projects — a skill,
 * a slash command and a hook — so uninstalling it leaves an orphan in every
 * directory the sweep touches.
 */
function writeFullInstalledPlugin(root: string, name: string): void {
  const plugin = path.join(root, '.dork', 'plugins', name);
  fs.mkdirSync(path.join(plugin, '.dork'), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'plugin',
      description: 'A fixture plugin',
      layers: ['skills', 'hooks', 'commands'],
    })
  );
  fs.mkdirSync(path.join(plugin, 'skills', 'greet'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills', 'greet', 'SKILL.md'), '# greet\n');
  fs.mkdirSync(path.join(plugin, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, 'commands', 'hello.md'),
    '---\ndescription: Say hello\n---\n\nSay hello.\n'
  );
  fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }] })
  );
}

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

    it('names the directory it searched so a wrong-folder run is obvious', async () => {
      writeFixtureRepoWithoutManifest(tmpDir);
      process.chdir(tmpDir);

      await runHarnessSync(syncArgs({ check: true, fix: false }));

      // fs.realpath: macOS temp dirs are symlinked (/var -> /private/var), and the
      // command reports the cwd Node resolved.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(fs.realpathSync(tmpDir)));
      // The exported constant rather than a literal typed here, so this stays one
      // claim about one string — which DOR-1851 made a forward-slash path on every
      // platform, since this line is read by a person.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(HARNESS_MANIFEST_PATH));
    });

    it('is read-only in the default (bare, no-flag) mode too', async () => {
      writeFixtureRepoWithoutManifest(tmpDir);
      process.chdir(tmpDir);
      const before = snapshotTree(tmpDir);

      const result = await runHarnessSync(syncArgs({ check: false, fix: false }));

      expect(snapshotTree(tmpDir)).toEqual(before);
      expect(result.exitCode).toBe(1);
    });

    it('is read-only when narrowed with --harness', async () => {
      writeFixtureRepoWithoutManifest(tmpDir);
      process.chdir(tmpDir);
      const before = snapshotTree(tmpDir);

      // Previously exited 0 here — a "clean" report that had just written a file.
      const result = await runHarnessSync(syncArgs({ check: true, fix: false, harness: 'codex' }));

      expect(snapshotTree(tmpDir)).toEqual(before);
      expect(result.exitCode).toBe(1);
    });

    it('reports drift without writing when a manifest IS present', async () => {
      writeFixtureRepo(tmpDir);
      process.chdir(tmpDir);
      const before = snapshotTree(tmpDir);

      const result = await runHarnessSync(syncArgs({ check: true, fix: false }));

      expect(snapshotTree(tmpDir)).toEqual(before);
      expect(result.exitCode).toBe(1);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Drift detected'));
    });
  });

  it('rejects an unknown --harness without writing anything', async () => {
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

  it('auto-scaffolds then realizes the projection on --fix', async () => {
    writeFixtureRepoWithoutManifest(tmpDir);
    process.chdir(tmpDir);
    const fix = await runHarnessSync(syncArgs({ check: false, fix: true }));

    // The manifest was scaffolded and the plan applied with no conflicts: the
    // Claude instruction pointer and codex hooks now exist on disk.
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'harness.manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fix.exitCode).toBe(0);

    // A second run sees the manifest already present (no re-scaffold message) and
    // is clean.
    logSpy.mockClear();
    const second = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(second.exitCode).toBe(0);
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('No manifest found; wrote a default')
    );
  });

  it('returns exit code 1 when both --check and --fix are passed', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    const result = await runHarnessSync(syncArgs({ check: true, fix: true }));
    expect(result.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not both'));
  });

  it('reports drift on an unprojected fixture (--check) then applies and is idempotent (--fix)', async () => {
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

  it('projects a project-scoped installed plugin when the dork home is empty (regression)', async () => {
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

  it('tells the operator WHY a scheduled plugin skill is linked where no enabled harness reads (DOR-1518)', async () => {
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

  it('does not let the shared-link summary line read as "Codex is enabled"', async () => {
    // Every action must name a harness, and the unconditional `.agents/skills`
    // link is attributed to Codex — whose directory that is. On a Claude-Code-only
    // project that put a bare `codex: 1 symlink` line in the summary, which says
    // Codex is on to anybody who has not read the projector.
    fs.mkdirSync(path.join(tmpDir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code'] }, null, 2)
    );
    writeInstalledPlugin(tmpDir, 'acme', 'greet');
    process.chdir(tmpDir);

    await runHarnessSync(syncArgs({ check: true }));

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    const codexLine = printed.split('\n').find((line) => line.trim().startsWith('codex:'));
    expect(codexLine).toBeDefined();
    expect(codexLine).toContain('(not enabled — carries the shared .agents/skills link)');
    // The harness that IS enabled keeps a clean line.
    const claudeLine = printed.split('\n').find((line) => line.trim().startsWith('claude-code:'));
    expect(claudeLine).toBeDefined();
    expect(claudeLine).not.toContain('not enabled');
  });

  it('prints what a rotted plugin hooks.json lost during salvage (DOR-1724)', async () => {
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

  it('names what a rotted hooks.json lost BESIDE the withheld block, before the decision', async () => {
    // Both, and the order matters. The withheld block lists what the reader
    // could recover; the salvage warning names what it could not. A person
    // deciding whether to allow this package needs both halves BEFORE they
    // answer — reporting the loss only once the package was allowed meant
    // deciding from a list that quietly omitted the damaged part (DOR-1724,
    // DOR-1849).
    writeFixtureRepo(tmpDir);
    writeInstalledPlugin(tmpDir, 'acme', 'greet');
    const hooksDir = path.join(tmpDir, '.dork', 'plugins', 'acme', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        Stop: [{ hooks: [{ command: 'still-good.sh' }] }, { hooks: 'rotted' }],
      })
    );
    process.chdir(tmpDir);

    const fix = await runHarnessSync(syncArgs({ fix: true }));
    expect(fix.exitCode).toBe(0);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain(
      'hook "acme:Stop": .dork/plugins/acme/hooks/hooks.json declares one or more unusable matcher groups under "Stop"'
    );
    expect(printed).toContain('Withheld: hooks from "acme" were not installed');
    expect(printed).toContain('still-good.sh');
    // Withheld means withheld: the readable half did not install either.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('prints no salvage warning when every plugin hooks.json is readable (DOR-1724)', async () => {
    writeFixtureRepo(tmpDir);
    writeInstalledPlugin(tmpDir, 'acme', 'greet');
    const hooksDir = path.join(tmpDir, '.dork', 'plugins', 'acme', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({ Stop: [{ hooks: [{ command: 'fine.sh' }] }] })
    );
    process.chdir(tmpDir);

    await runHarnessSync(syncArgs({ check: false, fix: true }));

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('hooks/hooks.json declares');
    expect(printed).not.toContain('could not be read');
  });

  /** Write a hooks file DorkOS did not write, at one of the paths it generates. */
  function writeHandWrittenHooks(root: string, rel: string, command: string): string {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const body = `${JSON.stringify({ version: 1, hooks: { stop: [{ type: 'command', command }] } }, null, 2)}\n`;
    fs.writeFileSync(abs, body);
    return body;
  }

  it('--fix names a hooks file it stepped over, says there is nothing to fix, and still exits 0', async () => {
    // Cursor is not in this fixture's manifest, so nothing is planned for
    // `.cursor/hooks.json`. A person who keeps their own file there has blocked
    // nothing, so a sync must not start failing for them.
    writeFixtureRepo(tmpDir);
    const mine = writeHandWrittenHooks(tmpDir, '.cursor/hooks.json', 'echo MINE');
    process.chdir(tmpDir);

    const fix = await runHarnessSync(syncArgs({ check: false, fix: true }));

    expect(fix.exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Left alone — files DorkOS did not write');
    expect(printed).toContain('.cursor/hooks.json  (cursor)');
    expect(printed).toContain('Nothing to fix.');
    expect(fs.readFileSync(path.join(tmpDir, '.cursor', 'hooks.json'), 'utf8')).toBe(mine);
  });

  it('--check exits 0 when the only news is a file it stepped over', async () => {
    writeFixtureRepo(tmpDir);
    writeHandWrittenHooks(tmpDir, '.cursor/hooks.json', 'echo MINE');
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ check: false, fix: true })); // project everything first
    logSpy.mockClear();

    const check = await runHarnessSync(syncArgs({ check: true, fix: false }));

    expect(check.exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Left alone — files DorkOS did not write');
    expect(printed).toContain('No drift');
  });

  it('--check names a blocked projection and exits 1', async () => {
    // Codex IS in the manifest and the fixture has an authored Stop hook, so the
    // plan wants `.codex/hooks.json` — and cannot have it. That is a fault, and
    // it has to be reported as one.
    writeFixtureRepo(tmpDir);
    writeHandWrittenHooks(tmpDir, '.codex/hooks.json', 'echo MINE');
    process.chdir(tmpDir);

    const check = await runHarnessSync(syncArgs({ check: true, fix: false }));

    expect(check.exitCode).toBe(1);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('blocked');
    expect(printed).toContain('.codex/hooks.json');
    expect(printed).toContain('.claude/settings.json');
  });

  it('--check reports a dead link at a generated file as drift instead of crashing', async () => {
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

  it('--check names a link whose skill is gone, and --fix sweeps it', async () => {
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

  it('--check --harness withholds orphans, because --fix --harness cannot sweep them', async () => {
    // The sweep runs only on a full plan. Naming an orphan under a filter meant
    // `--check --harness codex` exited 1 and told the person to run a `--fix`
    // that exits 0 and leaves the link — forever, with no way out but a flag the
    // report never mentioned.
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ check: false, fix: true }));
    fs.rmSync(path.join(tmpDir, '.agents', 'skills', 'demo'), { recursive: true, force: true });
    const orphan = path.join(tmpDir, '.claude', 'skills', 'demo');
    logSpy.mockClear();

    const scoped = await runHarnessSync(syncArgs({ check: true, fix: false, harness: 'codex' }));

    expect(scoped.exitCode).toBe(0);
    const scopedOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(scopedOutput).not.toContain('Orphaned projections');
    expect(scopedOutput).toContain('No drift');

    // The filtered --fix it would have recommended really does leave the link,
    // which is why the filtered --check must not report it.
    const scopedFix = await runHarnessSync(syncArgs({ check: false, fix: true, harness: 'codex' }));
    expect(scopedFix.exitCode).toBe(0);
    expect(fs.lstatSync(orphan).isSymbolicLink()).toBe(true);

    // Unfiltered, it is named and it is swept.
    logSpy.mockClear();
    const full = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(full.exitCode).toBe(1);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Orphaned projections');
    await runHarnessSync(syncArgs({ check: false, fix: true }));
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('--check names every path an uninstalled plugin left, and --fix removes exactly those', async () => {
    // Before DOR-1889 this exited 0 and said nothing: `checkPlan` answered for
    // one sweep of six, so a tree a `--fix` was about to take nine files out of
    // read clean. `--allow-hooks` is here because the plugin ships hooks and
    // nobody has said yes to them yet — without it the hook projections never
    // land, and the case would prove less than the whole sweep.
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
    expect(checkOutput).toContain(
      [
        'Orphaned projections — what they came from is gone (9):',
        '  .agents/skills/acme__greet',
        '  .claude/commands/acme/.gitignore',
        '  .claude/commands/acme/hello.md',
        '  .claude/settings.local.json',
        '  .claude/skills/acme__greet',
        '  .codex/hooks.json',
        '  .codex/hooks.json.dorkos-generated',
        '  .opencode/commands/.gitignore',
        '  .opencode/commands/acme-hello.md',
      ].join('\n')
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
    // The same nine, under the sweep's own heading: the report a person reads
    // after the command says what the report before it promised.
    expect(fixOutput).toContain(
      [
        'Swept 9 orphaned projection(s) — what they came from is gone:',
        '  .agents/skills/acme__greet',
        '  .claude/skills/acme__greet',
        '  .codex/hooks.json',
        '  .codex/hooks.json.dorkos-generated',
        '  .claude/commands/acme/.gitignore',
        '  .claude/commands/acme/hello.md',
        '  .opencode/commands/.gitignore',
        '  .opencode/commands/acme-hello.md',
        '  .claude/settings.local.json',
      ].join('\n')
    );
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'acme'))).toBe(false);
    // And the tree is clean afterwards, so the report cannot come straight back.
    expect((await runHarnessSync(syncArgs({ check: true, fix: false }))).exitCode).toBe(0);
  });

  it('--check --harness withholds the widened orphan set too', async () => {
    // The guard has to travel with the set it guards. A plan narrowed to Codex
    // has never seen the Claude or OpenCode projections, so every one of them
    // looks orphaned to it — nine paths this run cannot act on, since the
    // matching `--fix --harness` refuses to sweep at all.
    fs.mkdirSync(path.join(tmpDir, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents', 'harness.manifest.json'),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex', 'opencode'] }, null, 2)
    );
    writeFullInstalledPlugin(tmpDir, 'acme');
    process.chdir(tmpDir);
    await runHarnessSync(syncArgs({ check: false, fix: true, allowHooks: ['acme'] }));
    fs.rmSync(path.join(tmpDir, '.dork', 'plugins', 'acme'), { recursive: true, force: true });
    logSpy.mockClear();

    const scoped = await runHarnessSync(syncArgs({ check: true, fix: false, harness: 'codex' }));

    expect(scoped.exitCode).toBe(0);
    const scopedOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(scopedOutput).not.toContain('Orphaned projections');
    expect(scopedOutput).toContain('No drift');

    // Unfiltered, on the same tree in the same state, all nine are named.
    logSpy.mockClear();
    const full = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(full.exitCode).toBe(1);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Orphaned projections — what they came from is gone (9):'
    );
  });

  it('points at LOG_LEVEL=debug for the stack, and prints it when asked', async () => {
    writeFixtureRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.agents', 'harness.manifest.json'), '{ not json');
    process.chdir(tmpDir);

    const quiet = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(quiet.exitCode).toBe(1);
    const quietErrors = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(quietErrors).toContain('Re-run with LOG_LEVEL=debug to see the stack.');
    expect(quietErrors).not.toContain('\n    at ');

    errorSpy.mockClear();
    vi.stubEnv('LOG_LEVEL', 'debug');
    const loud = await runHarnessSync(syncArgs({ check: true, fix: false }));
    expect(loud.exitCode).toBe(1);
    const loudErrors = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(loudErrors).toContain('\n    at ');
    expect(loudErrors).not.toContain('Re-run with LOG_LEVEL=debug');
  });

  it('turns an engine failure into one line, not a stack trace', async () => {
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

  it('--harness narrows the left-alone list to that harness', async () => {
    writeFixtureRepo(tmpDir);
    writeHandWrittenHooks(tmpDir, '.cursor/hooks.json', 'echo MINE cursor');
    writeHandWrittenHooks(tmpDir, '.github/hooks/copilot-hooks.json', 'echo MINE copilot');
    process.chdir(tmpDir);

    await runHarnessSync(syncArgs({ check: true, fix: false, harness: 'cursor' }));

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('.cursor/hooks.json');
    expect(printed).not.toContain('copilot-hooks.json');
  });

  it('narrows the plan with --harness and rejects an unknown harness', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);

    const scoped = await runHarnessSync(syncArgs({ check: true, fix: false, harness: 'codex' }));
    expect(scoped.exitCode).toBe(1); // codex still has the generated hooks drift

    const bogus = await runHarnessSync(syncArgs({ check: true, fix: false, harness: 'bogus' }));
    expect(bogus.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness'));
  });
});

/**
 * The CLI hole DOR-1849 closed: `dorkos harness sync --fix` used to pass no gate
 * and consult no record, so it installed every hook on disk including a
 * package's somebody had turned down. It now withholds, says so command by
 * command, and installs only what a person allowed — which it also RECORDS, into
 * the same list the approval card writes (contract D5).
 */
describe('runHarnessSync — withholding a package’s hooks', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  /** Everything the run printed, joined so a block can be asserted verbatim. */
  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** Everything the run printed to stderr. */
  const errors = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /**
   * The project path the command itself will see.
   *
   * macOS temp dirs are symlinked (`/var` -> `/private/var`) and `process.cwd()`
   * answers with the resolved path, which is what the stored digest covers.
   */
  const repoRoot = (): string => fs.realpathSync(tmpDir);

  /** What the config file holds, or `undefined` when the run never made one. */
  function storedHarness(): { approvedHooks?: string[]; refusedHooks?: string[] } | undefined {
    const configPath = path.join(homeDir, 'config.json');
    if (!fs.existsSync(configPath)) return undefined;
    return (JSON.parse(fs.readFileSync(configPath, 'utf8')) as { harness?: never }).harness;
  }

  /** Add a `hooks/hooks.json` to an already-written installed plugin. */
  function writePluginHooks(name: string, hooks: unknown): void {
    const hooksDir = path.join(tmpDir, '.dork', 'plugins', name, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(hooks));
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeFixtureRepo(tmpDir);
    writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');
    writePluginHooks('acme-tools', {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ./guard.mjs' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'bash scripts/notify.sh' }] }],
    });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('holds the hooks back, names every command and the exact re-run, and exits 0', async () => {
    const fix = await runHarnessSync(syncArgs({ fix: true }));

    // Exit 0 is the decision, not an oversight: a withheld hook is a recorded
    // answer being obeyed, and failing a mostly-done sync teaches bootstrap
    // scripts `|| true` (contract D5).
    expect(fix.exitCode).toBe(0);
    const out = printed();
    expect(out).toContain('Withheld: hooks from "acme-tools" were not installed');
    expect(out).toContain('PreToolUse (matcher: Bash)  ->  node ./guard.mjs');
    expect(out).toContain('Stop                        ->  bash scripts/notify.sh');
    expect(out).toContain('You have not allowed this package yet.');
    expect(out).toContain('To install them: dorkos harness sync --fix --allow-hooks acme-tools');
    expect(out).toContain('2 hooks withheld from 1 package');

    // And the commands really did not land, while the rest of the package did.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, '.codex', 'hooks.json'), 'utf8')).not.toContain(
      'guard.mjs'
    );
    expect(
      fs.lstatSync(path.join(tmpDir, '.claude', 'skills', 'acme-tools__greet')).isSymbolicLink()
    ).toBe(true);
  });

  it('says the same thing on --check, without touching disk', async () => {
    const check = await runHarnessSync(syncArgs({ check: true }));

    expect(printed()).toContain('Withheld: hooks from "acme-tools" were not installed');
    // Reporting a hook it is not going to install is not drift, so the withheld
    // block never changes what --check says about the tree.
    expect(check.exitCode).toBe(1); // the unprojected fixture really is drifted
    expect(fs.existsSync(path.join(homeDir, 'config.json'))).toBe(false);
  });

  it('--strict exits 1, and still applies everything else first', async () => {
    const strict = await runHarnessSync(syncArgs({ fix: true, strict: true }));

    expect(strict.exitCode).toBe(1);
    expect(printed()).toContain('--strict: exiting 1 because hooks were withheld.');
    // Everything that was not held back still landed.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
  });

  it('--strict exits 0 once the package is allowed', async () => {
    await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme-tools'] }));
    logSpy.mockClear();

    const strict = await runHarnessSync(syncArgs({ fix: true, strict: true }));
    expect(strict.exitCode).toBe(0);
    expect(printed()).not.toContain('withheld');
  });

  it('--allow-hooks installs the commands AND records the same entry the card writes', async () => {
    const fix = await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme-tools'] }));

    expect(fix.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.local.json'), 'utf8')).toContain(
      'node ./guard.mjs'
    );
    expect(fs.readFileSync(path.join(tmpDir, '.codex', 'hooks.json'), 'utf8')).toContain(
      'bash scripts/notify.sh'
    );
    expect(printed()).not.toContain('Withheld:');

    // Not a per-run override: the exact `<package>@<digest>` entry, in the one
    // store the app reads too.
    const entry = hookApprovalEntry({
      projectPath: repoRoot(),
      packageName: 'acme-tools',
      hooks: [
        { event: 'PreToolUse', matcher: 'Bash', command: 'node ./guard.mjs' },
        { event: 'Stop', command: 'bash scripts/notify.sh' },
      ],
    });
    expect(storedHarness()?.approvedHooks).toEqual([entry]);

    // A second run needs no flag: the record is what carries the answer.
    logSpy.mockClear();
    await runHarnessSync(syncArgs({ fix: true }));
    expect(printed()).not.toContain('Withheld:');
  });

  it('--allow-hooks clears a refusal for the same hooks', async () => {
    // Both halves of "one store, one digest": the entry moves rather than being
    // added, so a package is never approved and refused at once.
    const entry = hookApprovalEntry({
      projectPath: repoRoot(),
      packageName: 'acme-tools',
      hooks: [
        { event: 'PreToolUse', matcher: 'Bash', command: 'node ./guard.mjs' },
        { event: 'Stop', command: 'bash scripts/notify.sh' },
      ],
    });
    fs.writeFileSync(
      path.join(homeDir, 'config.json'),
      JSON.stringify({
        version: 1,
        harness: { autoSync: true, approvedHooks: [], refusedHooks: [entry] },
      })
    );

    // Refused first, so the block says which decision is being obeyed.
    await runHarnessSync(syncArgs({ fix: true }));
    expect(printed()).toContain('You turned this package down earlier.');

    logSpy.mockClear();
    await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme-tools'] }));
    expect(storedHarness()?.approvedHooks).toEqual([entry]);
    expect(storedHarness()?.refusedHooks).toEqual([]);
  });

  it('withholds a package whose entry a hand-edit put in BOTH lists', async () => {
    // Both leaves are `operator-only` so that a person can edit
    // `~/.dork/config.json` themselves, and a hand-edit is how one entry ends up
    // on both lists. Measured before the fix: the command installed itself with
    // no withheld block at all.
    const entry = hookApprovalEntry({
      projectPath: repoRoot(),
      packageName: 'acme-tools',
      hooks: [
        { event: 'PreToolUse', matcher: 'Bash', command: 'node ./guard.mjs' },
        { event: 'Stop', command: 'bash scripts/notify.sh' },
      ],
    });
    fs.writeFileSync(
      path.join(homeDir, 'config.json'),
      JSON.stringify({
        version: 1,
        harness: { autoSync: true, approvedHooks: [entry], refusedHooks: [entry] },
      })
    );

    const fix = await runHarnessSync(syncArgs({ fix: true }));

    expect(fix.exitCode).toBe(0);
    expect(printed()).toContain('You turned this package down earlier.');
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, '.codex', 'hooks.json'), 'utf8')).not.toContain(
      'guard.mjs'
    );
  });

  describe('when config.json itself cannot be read', () => {
    /** A truncated settings file — a mid-write, or a hand-edit that lost a brace. */
    function writeTruncatedConfig(): void {
      fs.writeFileSync(path.join(homeDir, 'config.json'), '{ "version": 1, "harness": {');
    }

    it('says the file could not be read instead of "you have not allowed this yet"', async () => {
      writeTruncatedConfig();

      const fix = await runHarnessSync(syncArgs({ fix: true }));

      expect(fix.exitCode).toBe(0);
      const out = printed();
      expect(out).toContain('Withheld: hooks from "acme-tools" were not installed');
      expect(out).toContain(`DorkOS could not read ${path.join(homeDir, 'config.json')}`);
      expect(out).toContain('Fix the file before allowing hooks.');
      // The two things it must NOT say: a claim about what was decided, and the
      // command whose corrupt-recovery would replace every setting with defaults.
      expect(out).not.toContain('You have not allowed this package yet.');
      expect(out).not.toContain('--allow-hooks acme-tools');
      // Still fail-closed, and the file is left exactly as it was.
      expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
      expect(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).toBe(
        '{ "version": 1, "harness": {'
      );
    });

    it('says the same on --check', async () => {
      writeTruncatedConfig();

      await runHarnessSync(syncArgs({ check: true }));

      expect(printed()).toContain(`DorkOS could not read ${path.join(homeDir, 'config.json')}`);
      expect(printed()).not.toContain('You have not allowed this package yet.');
    });

    it('refuses --allow-hooks rather than opening the store over it', async () => {
      // `initConfigManager` on an unreadable file runs conf's corrupt-recovery,
      // which backs it up and resets EVERY setting to defaults. The refusal is
      // what keeps a person's telemetry, login and accounts where they left them.
      writeTruncatedConfig();

      const result = await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme-tools'] }));

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain(`DorkOS could not read ${path.join(homeDir, 'config.json')}`);
      expect(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).toBe(
        '{ "version": 1, "harness": {'
      );
      expect(fs.readdirSync(homeDir)).toEqual(['config.json']);
    });

    it('a schema-invalid harness block is unreadable too, not "nothing decided"', async () => {
      fs.writeFileSync(
        path.join(homeDir, 'config.json'),
        JSON.stringify({ version: 1, harness: { autoSync: true, approvedHooks: 'oops' } })
      );

      await runHarnessSync(syncArgs({ fix: true }));

      expect(printed()).toContain('not in a shape DorkOS understands');
      expect(printed()).not.toContain('You have not allowed this package yet.');
    });

    it('an ABSENT file is still just "not allowed yet" — that one is honest', async () => {
      expect(fs.existsSync(path.join(homeDir, 'config.json'))).toBe(false);

      await runHarnessSync(syncArgs({ fix: true }));

      expect(printed()).toContain('You have not allowed this package yet.');
      expect(printed()).not.toContain('could not read');
    });
  });

  it('refuses --allow-hooks without --fix, naming the fix', async () => {
    const result = await runHarnessSync(syncArgs({ check: true, allowHooks: ['acme-tools'] }));

    expect(result.exitCode).toBe(1);
    expect(errors()).toContain("--allow-hooks installs a package's hooks, so it needs --fix.");
    expect(errors()).toContain('dorkos harness sync --fix --allow-hooks acme-tools');
    expect(fs.existsSync(path.join(homeDir, 'config.json'))).toBe(false);
  });

  it('refuses a package name that declares no hooks here, and writes nothing', async () => {
    // A typo must not half-record a decision and leave the person working out
    // which half landed, so every name is checked before anything is written.
    const result = await runHarnessSync(
      syncArgs({ fix: true, allowHooks: ['acme-tools', 'no-such-pkg'] })
    );

    expect(result.exitCode).toBe(1);
    expect(errors()).toContain("No installed package here declares hooks under 'no-such-pkg'");
    expect(errors()).toContain('Packages with hooks in this project: acme-tools');
    expect(fs.existsSync(path.join(homeDir, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('counts merge actions in the summary (VC-02)', async () => {
    // The one kind that writes into a file the person owns —
    // `.claude/settings.local.json` — and the only one the summary used to skip.
    await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme-tools'] }));

    expect(printed()).toMatch(/claude-code: .*\d+ merge/);
  });

  it('shows an unreadable-hook warning under --harness codex (VC-02)', async () => {
    // The loss happened at read time, ahead of every harness, so a filter that
    // hid it for every id but `claude-code` was hiding the only report of it.
    writePluginHooks('acme-tools', {
      Stop: [{ hooks: [{ type: 'command', command: 'fine.sh' }] }],
      PostToolUse: [{ hooks: [{ type: 'command' }] }],
    });
    await runHarnessSync(syncArgs({ fix: true, harness: 'codex', allowHooks: ['acme-tools'] }));

    const out = printed();
    expect(out).toContain('plugin layers:');
    expect(out).toContain(
      'hook "acme-tools:PostToolUse": .dork/plugins/acme-tools/hooks/hooks.json declares "PostToolUse" in a shape this reader cannot use'
    );
  });

  it('shows a plugin-layer drop under --harness cursor, headed "plugin layers" (VC-02)', async () => {
    // A non-portable layer has no home in ANY harness, so filing it under
    // `codex:` was wrong in a project that runs Codex and invisible in one that
    // does not.
    const manifestPath = path.join(
      tmpDir,
      '.dork',
      'plugins',
      'acme-tools',
      '.dork',
      'manifest.json'
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { layers: string[] };
    manifest.layers = [...manifest.layers, 'extensions'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    await runHarnessSync(syncArgs({ check: true, harness: 'cursor' }));

    const out = printed();
    expect(out).toContain('plugin layers:');
    expect(out).toContain('plugin "acme-tools:extensions"');
    expect(out).not.toContain('codex:');
  });

  it('says the Codex hooks file changed and is held for review, once (HK-10)', async () => {
    await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme-tools'] }));

    const first = printed();
    expect(first).toContain('Codex hooks changed (.codex/hooks.json).');
    expect(first).toContain('Codex only runs these in a project you have trusted');
    expect(first).toContain('review queue');
    expect(first).toContain('https://learn.chatgpt.com/docs/hooks');

    // A second identical --fix rewrites the same bytes, so Codex's trust record
    // has not moved and there is nothing to say. This is what makes AP-01
    // load-bearing rather than merely tidy.
    logSpy.mockClear();
    await runHarnessSync(syncArgs({ fix: true }));
    expect(printed()).not.toContain('Codex hooks changed');
  });
});

/** `dorkos harness hooks` — the first surface for a record nothing could show (VC-05). */
describe('runHarnessHooks', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const errors = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /**
   * The entry the fixture package would produce in this project right now.
   *
   * `realpathSync` because macOS temp dirs are symlinked and `process.cwd()`
   * answers with the resolved path, which is what the stored digest covers.
   */
  function localEntry(): string {
    return hookApprovalEntry({
      projectPath: fs.realpathSync(tmpDir),
      packageName: 'acme-tools',
      hooks: [{ event: 'Stop', command: 'bash scripts/notify.sh' }],
    });
  }

  function writeStored(harness: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(homeDir, 'config.json'),
      JSON.stringify({ version: 1, harness: { autoSync: true, ...harness } })
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeFixtureRepo(tmpDir);
    writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');
    fs.mkdirSync(path.join(tmpDir, '.dork', 'plugins', 'acme-tools', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.dork', 'plugins', 'acme-tools', 'hooks', 'hooks.json'),
      JSON.stringify({
        Stop: [{ hooks: [{ type: 'command', command: 'bash scripts/notify.sh' }] }],
      })
    );
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('parses --list and --revoke, and defaults a bare invocation to --list', () => {
    expect(parseHarnessHooksArgs([])).toEqual({ list: true, revoke: undefined });
    expect(parseHarnessHooksArgs(['--list'])).toEqual({ list: true, revoke: undefined });
    expect(parseHarnessHooksArgs(['--revoke', 'acme-tools'])).toEqual({
      list: false,
      revoke: 'acme-tools',
    });
    expect(() => parseHarnessHooksArgs(['--nope'])).toThrow(
      /Unknown option for 'harness hooks': --nope/
    );
  });

  it('--list says nothing is stored, and creates no config file doing it', async () => {
    const result = await runHarnessHooks({ list: true });

    expect(result.exitCode).toBe(0);
    expect(printed()).toContain('No hook decisions stored yet.');
    // The read path must not open the config store: `conf`'s constructor writes
    // the file and the directory around it (DOR-678's rule, a different route).
    expect(fs.existsSync(path.join(homeDir, 'config.json'))).toBe(false);
  });

  it('--list names each package and whether the decision is about this project', async () => {
    writeStored({
      approvedHooks: [localEntry()],
      refusedHooks: ['other-pkg@0000000000000000000000000000000000000000000000000000000000000000'],
    });

    const result = await runHarnessHooks({ list: true });

    expect(result.exitCode).toBe(0);
    const out = printed();
    expect(out).toContain('Allowed to run commands:');
    expect(out).toContain('acme-tools — matches the hooks installed in this project');
    expect(out).toContain('Turned down:');
    expect(out).toContain(
      'other-pkg — from another project, or from before this package changed its hooks'
    );
  });

  it('--list says the file could not be read rather than "nothing stored yet"', async () => {
    fs.writeFileSync(path.join(homeDir, 'config.json'), '{ "version": 1, "harness": {');

    const result = await runHarnessHooks({ list: true });

    expect(result.exitCode).toBe(1);
    expect(errors()).toContain(`DorkOS could not read ${path.join(homeDir, 'config.json')}`);
    expect(printed()).not.toContain('No hook decisions stored yet.');
  });

  it('--revoke forgets a package and says the next sync will ask again', async () => {
    writeStored({ approvedHooks: [localEntry()], refusedHooks: [] });

    const result = await runHarnessHooks({ list: false, revoke: 'acme-tools' });

    expect(result.exitCode).toBe(0);
    expect(printed()).toContain('Forgot 1 decision for "acme-tools":');
    expect(printed()).toContain('was: allowed');
    const stored = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')) as {
      harness: { approvedHooks: string[]; refusedHooks: string[] };
    };
    expect(stored.harness.approvedHooks).toEqual([]);

    // And the next sync really does hold the package back again.
    logSpy.mockClear();
    await runHarnessSync(syncArgs({ fix: true }));
    expect(printed()).toContain('Withheld: hooks from "acme-tools" were not installed');
  });

  it('--revoke of a package with nothing stored exits 1 and points at --list', async () => {
    writeStored({ approvedHooks: [], refusedHooks: [] });

    const result = await runHarnessHooks({ list: false, revoke: 'acme-tools' });

    expect(result.exitCode).toBe(1);
    expect(errors()).toContain("Nothing stored for 'acme-tools'.");
    expect(errors()).toContain('dorkos harness hooks --list');
  });

  it('is reachable through the dispatcher, and its help text names it', async () => {
    expect(await runHarnessDispatcher('hooks', ['--list'])).toBe(0);
    logSpy.mockClear();
    expect(await runHarnessDispatcher(undefined, [])).toBe(0);
    expect(printed()).toContain('hooks [options]');
    expect(printed()).toContain('--allow-hooks <pkg>');
    expect(printed()).toContain('--revoke <pkg>');
    expect(printed()).toContain('--strict');
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

  it('prints help for `harness sync --help` instead of an unknown-option error', async () => {
    expect(await runHarnessDispatcher('sync', ['--help'])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: dorkos harness'));
    // Must NOT have reached the strict arg parser and reported --help as unknown.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('prints help for `harness sync -h`', async () => {
    expect(await runHarnessDispatcher('sync', ['-h'])).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns exit code 1 for an unknown subcommand', async () => {
    expect(await runHarnessDispatcher('bogus', [])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness subcommand'));
  });
});

/**
 * TR-11, AP-09 and AP-15 at the CLI: a harness added after the manifest was
 * written, the `.gitignore` lines the projections need, and what a gitignored
 * `.agents/` means for everyone else.
 *
 * All three are NOTICES. None of them changes an exit code, and the first test
 * of each half is the one that says so — a standing failing command for a
 * harness somebody runs elsewhere, or for a `.gitignore` line, is how people
 * learn to stop reading a report.
 */
describe('runHarnessSync — a harness added later, and the .gitignore contract', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  /** Everything the run printed, joined so a block can be asserted verbatim. */
  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** Everything the run printed to stderr. */
  const errors = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** The manifest's exact bytes. */
  const manifestText = (): string =>
    fs.readFileSync(path.join(tmpDir, HARNESS_MANIFEST_PATH), 'utf8');

  /** Make the fixture look like a git checkout, so the gitignore half applies. */
  function makeGitRepo(gitignore?: string): void {
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    if (gitignore !== undefined) fs.writeFileSync(path.join(tmpDir, '.gitignore'), gitignore);
  }

  /** The month-later change: somebody starts using Cursor here. */
  function addCursorDir(): void {
    fs.mkdirSync(path.join(tmpDir, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cursor', 'rules', 'x.mdc'), '# rules\n');
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  describe('--enable', () => {
    it('is parsed repeatably, beside --write-gitignore', () => {
      const args = parseHarnessSyncArgs([
        '--fix',
        '--enable',
        'cursor',
        '--enable',
        'gemini',
        '--write-gitignore',
      ]);
      expect(args.enable).toEqual(['cursor', 'gemini']);
      expect(args.writeGitignore).toBe(true);
    });

    it('refuses --check --enable, naming the command to run, and writes nothing', async () => {
      const before = snapshotTree(tmpDir);

      const result = await runHarnessSync(syncArgs({ check: true, enable: ['cursor'] }));

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain(
        '--enable turns a harness on in your manifest, so it needs --fix.'
      );
      expect(errors()).toContain('dorkos harness sync --fix --enable cursor');
      expect(snapshotTree(tmpDir)).toEqual(before);
    });

    it('refuses --check --write-gitignore the same way', async () => {
      const before = snapshotTree(tmpDir);

      const result = await runHarnessSync(syncArgs({ check: true, writeGitignore: true }));

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain('--write-gitignore adds lines to your .gitignore');
      expect(snapshotTree(tmpDir)).toEqual(before);
    });

    it('rejects an unknown harness id before anything is written', async () => {
      const before = manifestText();

      const result = await runHarnessSync(syncArgs({ fix: true, enable: ['bogus'] }));

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain("Unknown harness: 'bogus'");
      expect(manifestText()).toBe(before);
      expect(fs.existsSync(path.join(tmpDir, '.cursor', 'hooks.json'))).toBe(false);
    });

    it('reports the typo, not the missing --fix, when both are wrong', async () => {
      // Order matters to the person: being sent to re-run `--fix --enable curser`
      // is being sent to make the same mistake with a longer command.
      const result = await runHarnessSync(syncArgs({ check: true, enable: ['curser'] }));

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain("Unknown harness: 'curser'");
      expect(errors()).not.toContain('needs --fix');
    });

    it('refuses to enable a harness in a run narrowed to a different one', async () => {
      // It would write the manifest and then project nothing for what it just
      // turned on — the half-done job nobody would think to check for.
      const before = manifestText();

      const result = await runHarnessSync(
        syncArgs({ fix: true, enable: ['cursor'], harness: 'codex' })
      );

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain('does not take --harness');
      expect(manifestText()).toBe(before);
    });

    it('adds the harnesses key to a manifest that leaves it to the default', async () => {
      // A manifest of `{"version": 1}` is valid and means `["claude-code"]`, so
      // the notice fires for it — and the command it names has to work.
      fs.writeFileSync(path.join(tmpDir, HARNESS_MANIFEST_PATH), '{\n  "version": 1\n}\n');
      addCursorDir();

      const result = await runHarnessSync(syncArgs({ fix: true, enable: ['cursor'] }));

      expect(result.exitCode).toBe(0);
      expect(manifestText()).toBe(
        '{\n  "version": 1,\n  "harnesses": ["claude-code", "cursor"]\n}\n'
      );
      expect(fs.existsSync(path.join(tmpDir, '.cursor', 'hooks.json'))).toBe(true);
    });

    it('refuses a manifest the engine would reject, and leaves it alone', async () => {
      const body = '{\n  "version": 1,\n  "harnesses": ["codex"],\n  "sharedSkills": ["a"]\n}\n';
      fs.writeFileSync(path.join(tmpDir, HARNESS_MANIFEST_PATH), body);

      const result = await runHarnessSync(syncArgs({ fix: true, enable: ['cursor'] }));

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain('sharedSkills');
      expect(manifestText()).toBe(body);
    });

    it('says the harness was already on, and leaves the file byte-identical', async () => {
      const before = manifestText();

      const result = await runHarnessSync(syncArgs({ fix: true, enable: ['codex'] }));

      expect(result.exitCode).toBe(0);
      expect(printed()).toContain(`Codex was already enabled in ${HARNESS_MANIFEST_PATH}`);
      expect(manifestText()).toBe(before);
    });
  });

  describe('a harness that appeared after the manifest was written (TR-11)', () => {
    it('says nothing when every harness on disk is enabled', async () => {
      await runHarnessSync(syncArgs({ check: true }));
      expect(printed()).not.toContain('is not enabled');
    });

    it('prints the notice and keeps the exit code it had before', async () => {
      // The same repo, twice: the only difference is the `.cursor/` directory,
      // so the exit code is the control and the notice is the change.
      const withoutCursor = await runHarnessSync(syncArgs({ fix: true }));
      logSpy.mockClear();

      addCursorDir();
      const withCursor = await runHarnessSync(syncArgs({ check: true }));

      expect(withCursor.exitCode).toBe(withoutCursor.exitCode);
      expect(withCursor.exitCode).toBe(0);
      expect(printed()).toContain(
        `.cursor/ found; Cursor is not enabled — add it to ${HARNESS_MANIFEST_PATH} ` +
          'or run dorkos harness sync --fix --enable cursor'
      );
    });

    it('is not repeated by a --harness run about a different harness', async () => {
      addCursorDir();

      await runHarnessSync(syncArgs({ check: true, harness: 'codex' }));

      expect(printed()).not.toContain('is not enabled');
    });

    it('enables Cursor, projects to it in the same run, and then goes quiet', async () => {
      await runHarnessSync(syncArgs({ fix: true }));
      addCursorDir();
      const before = manifestText();
      logSpy.mockClear();

      const enable = await runHarnessSync(syncArgs({ fix: true, enable: ['cursor'] }));

      expect(enable.exitCode).toBe(0);
      expect(printed()).toContain(`Enabled Cursor in ${HARNESS_MANIFEST_PATH}`);
      // One element added, every other byte where it was.
      expect(manifestText()).toBe(before.replace('"codex"', '"codex",\n    "cursor"'));
      // The SAME run projected Cursor's hooks file — no second command.
      expect(fs.existsSync(path.join(tmpDir, '.cursor', 'hooks.json'))).toBe(true);

      logSpy.mockClear();
      const after = await runHarnessSync(syncArgs({ check: true }));
      expect(after.exitCode).toBe(0);
      expect(printed()).not.toContain('is not enabled');
    });
  });

  describe('the .gitignore contract (AP-09)', () => {
    it('says nothing at all outside a git checkout', async () => {
      writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');

      await runHarnessSync(syncArgs({ fix: true }));

      expect(printed()).not.toContain('gitignore:');
    });

    it('names the lines a fresh repo is missing, in both modes, without writing them', async () => {
      // The seeded case: `--fix` in a git repo with an installed plugin left
      // `.claude/skills/acme-tools__greet` untracked and said nothing.
      makeGitRepo();
      writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');

      const fix = await runHarnessSync(syncArgs({ fix: true }));

      expect(fix.exitCode).toBe(0);
      expect(printed()).toContain('gitignore:');
      expect(printed()).toContain('  .dork/plugins/');
      expect(printed()).toContain('  .claude/skills/*__*');
      expect(printed()).toContain('`dorkos harness sync --fix --write-gitignore`');
      expect(fs.existsSync(path.join(tmpDir, '.gitignore'))).toBe(false);

      logSpy.mockClear();
      const check = await runHarnessSync(syncArgs({ check: true }));
      expect(check.exitCode).toBe(0);
      expect(printed()).toContain('  .dork/plugins/');
    });

    it('appends them behind the flag, preserves the file, and then goes quiet', async () => {
      makeGitRepo('node_modules/\n');
      writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');

      const result = await runHarnessSync(syncArgs({ fix: true, writeGitignore: true }));

      expect(result.exitCode).toBe(0);
      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
      expect(gitignore).toBe(
        'node_modules/\n\n# DorkOS harness sync — ephemeral projections\n' +
          '.dork/plugins/\n.agents/skills/*__*\n.claude/skills/*__*\n.codex/hooks.json\n' +
          '.codex/hooks.json.dorkos-generated\n'
      );
      expect(printed()).toContain('gitignore: added 5 line(s) to .gitignore:');

      logSpy.mockClear();
      await runHarnessSync(syncArgs({ check: true }));
      expect(printed()).not.toContain('gitignore:');
    });

    it('accepts a broader rule the person already wrote', async () => {
      makeGitRepo('.claude/\n.dork/\n.agents/skills/*__*\n.codex/\n');
      writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');

      await runHarnessSync(syncArgs({ fix: true }));

      expect(printed()).not.toContain('gitignore:');
    });

    it('says nothing when a re-include means git tracks a projection anyway', async () => {
      // `dir/*` plus a re-include is a common idiom, and git really does track
      // `.claude/skills/pkg__skill` under it — so the repo that most needs the
      // warning is the one a negation-blind matcher called covered.
      makeGitRepo('.claude/*\n!.claude/skills/\n.dork/\n.agents/skills/*__*\n.codex/\n');
      writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');

      await runHarnessSync(syncArgs({ fix: true }));

      expect(printed()).toContain('  .claude/skills/*__*');
    });

    it('extends its own block instead of stamping a second heading', async () => {
      // Two runs is the ordinary case, not a corner: a narrowed sync followed by
      // a full one, or a plugin installed after the first `--write-gitignore`.
      makeGitRepo('node_modules/\n');
      await runHarnessSync(syncArgs({ fix: true, writeGitignore: true }));
      writeInstalledPlugin(tmpDir, 'acme-tools', 'greet');
      await runHarnessSync(syncArgs({ fix: true, writeGitignore: true }));

      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
      expect(gitignore.split('\n').filter((line) => line.startsWith('# DorkOS'))).toHaveLength(1);
      expect(gitignore).toBe(
        'node_modules/\n\n# DorkOS harness sync — ephemeral projections\n' +
          '.codex/hooks.json\n.codex/hooks.json.dorkos-generated\n' +
          '.dork/plugins/\n.agents/skills/*__*\n.claude/skills/*__*\n'
      );
      // And a third run, with nothing left to add, changes nothing at all.
      logSpy.mockClear();
      await runHarnessSync(syncArgs({ fix: true, writeGitignore: true }));
      expect(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8')).toBe(gitignore);
      expect(printed()).not.toContain('gitignore:');
    });
  });

  describe('a gitignored .agents/ (AP-15)', () => {
    it('explains what it means for anyone who clones the project', async () => {
      makeGitRepo('node_modules/\n.agents/\n');

      const result = await runHarnessSync(syncArgs({ fix: true }));

      expect(result.exitCode).toBe(0);
      expect(printed()).toContain('.agents/ is ignored by .gitignore');
      expect(printed()).toContain('links pointing at files git does not have');
      expect(printed()).toContain('Either stop ignoring .agents/ in .gitignore');
    });

    it('names the .agents/.gitignore when that is the file doing it', async () => {
      // "Stop ignoring it" is advice nobody can act on until they know which
      // file to open, and this is the one people forget they wrote.
      makeGitRepo('node_modules/\n');
      fs.writeFileSync(path.join(tmpDir, '.agents', '.gitignore'), '*\n');

      await runHarnessSync(syncArgs({ fix: true }));

      expect(printed()).toContain('.agents/ is ignored by .agents/.gitignore');
    });

    it('is not triggered by the installed-projection patterns inside it', async () => {
      makeGitRepo('.agents/skills/*__*\n.claude/skills/*__*\n');

      await runHarnessSync(syncArgs({ fix: true }));

      expect(printed()).not.toContain('.agents/ is ignored by');
    });
  });
});
