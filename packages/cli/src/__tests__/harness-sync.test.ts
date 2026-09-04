import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { HARNESS_MANIFEST_PATH } from '@dorkos/harness';

import { runHarnessSync, parseHarnessSyncArgs } from '../harness-sync-command.js';
import { runHarnessDispatcher } from '../commands/harness-dispatcher.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-harness-sync-test-'));
}

/** Build a minimal but realistic two-harness fixture repo at `root`. */
function writeFixtureRepo(root: string): void {
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
    expect(args).toEqual({ check: false, fix: false, harness: undefined });
  });

  it('parses --check and --fix booleans', () => {
    expect(parseHarnessSyncArgs(['--check'])).toEqual({
      check: true,
      fix: false,
      harness: undefined,
    });
    expect(parseHarnessSyncArgs(['--fix'])).toEqual({
      check: false,
      fix: true,
      harness: undefined,
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

      const result = await runHarnessSync({ check: true, fix: false });

      expect(snapshotTree(tmpDir)).toEqual(before);
      expect(fs.existsSync(path.join(tmpDir, '.agents', 'harness.manifest.json'))).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('names the directory it searched so a wrong-folder run is obvious', async () => {
      writeFixtureRepoWithoutManifest(tmpDir);
      process.chdir(tmpDir);

      await runHarnessSync({ check: true, fix: false });

      // fs.realpath: macOS temp dirs are symlinked (/var -> /private/var), and the
      // command reports the cwd Node resolved.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(fs.realpathSync(tmpDir)));
      // The exported constant, not a literal: it is built with `join()`, so the
      // separator is a backslash on Windows.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(HARNESS_MANIFEST_PATH));
    });

    it('is read-only in the default (bare, no-flag) mode too', async () => {
      writeFixtureRepoWithoutManifest(tmpDir);
      process.chdir(tmpDir);
      const before = snapshotTree(tmpDir);

      const result = await runHarnessSync({ check: false, fix: false });

      expect(snapshotTree(tmpDir)).toEqual(before);
      expect(result.exitCode).toBe(1);
    });

    it('is read-only when narrowed with --harness', async () => {
      writeFixtureRepoWithoutManifest(tmpDir);
      process.chdir(tmpDir);
      const before = snapshotTree(tmpDir);

      // Previously exited 0 here — a "clean" report that had just written a file.
      const result = await runHarnessSync({ check: true, fix: false, harness: 'codex' });

      expect(snapshotTree(tmpDir)).toEqual(before);
      expect(result.exitCode).toBe(1);
    });

    it('reports drift without writing when a manifest IS present', async () => {
      writeFixtureRepo(tmpDir);
      process.chdir(tmpDir);
      const before = snapshotTree(tmpDir);

      const result = await runHarnessSync({ check: true, fix: false });

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

    const result = await runHarnessSync({ check: false, fix: true, harness: 'bogus' });

    expect(snapshotTree(tmpDir)).toEqual(before);
    expect(result.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness'));
  });

  it('auto-scaffolds then realizes the projection on --fix', async () => {
    writeFixtureRepoWithoutManifest(tmpDir);
    process.chdir(tmpDir);
    const fix = await runHarnessSync({ check: false, fix: true });

    // The manifest was scaffolded and the plan applied with no conflicts: the
    // Claude instruction pointer and codex hooks now exist on disk.
    expect(fs.existsSync(path.join(tmpDir, '.agents', 'harness.manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fix.exitCode).toBe(0);

    // A second run sees the manifest already present (no re-scaffold message) and
    // is clean.
    logSpy.mockClear();
    const second = await runHarnessSync({ check: true, fix: false });
    expect(second.exitCode).toBe(0);
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('No manifest found; wrote a default')
    );
  });

  it('returns exit code 1 when both --check and --fix are passed', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);
    const result = await runHarnessSync({ check: true, fix: true });
    expect(result.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not both'));
  });

  it('reports drift on an unprojected fixture (--check) then applies and is idempotent (--fix)', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);

    // --check on the un-projected fixture: drift present.
    const firstCheck = await runHarnessSync({ check: true, fix: false });
    expect(firstCheck.exitCode).toBe(1);

    // --fix realizes the plan with no conflicts.
    const fix = await runHarnessSync({ check: false, fix: true });
    expect(fix.exitCode).toBe(0);

    // The projected files now exist.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.lstatSync(path.join(tmpDir, '.claude', 'skills', 'demo')).isSymbolicLink()).toBe(
      true
    );
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks.json'))).toBe(true);

    // A second --check is clean.
    const secondCheck = await runHarnessSync({ check: false, fix: false });
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
    const check = await runHarnessSync({ check: true, fix: false });
    expect(check.exitCode).toBe(1);

    // --fix projects it: a namespaced symlink lands in the Codex skills dir.
    const fix = await runHarnessSync({ check: false, fix: true });
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

    const fix = await runHarnessSync({ check: false, fix: true });
    expect(fix.exitCode).toBe(0);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('.agents/skills/flow__drain');
    expect(printed).toMatch(/flow__drain.*—.*scheduler/);
  });

  it('prints what a rotted plugin hooks.json lost during salvage (DOR-1724)', async () => {
    // The salvage keeps what the file still says clearly and drops the rest
    // (DOR-646). The CLI path has no approval gate to re-ask through, so this
    // report is the ONLY place the person is told a hook stopped being installed.
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

    const fix = await runHarnessSync({ check: false, fix: true });
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

    await runHarnessSync({ check: false, fix: true });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('hooks/hooks.json declares');
    expect(printed).not.toContain('could not be read');
  });

  it('narrows the plan with --harness and rejects an unknown harness', async () => {
    writeFixtureRepo(tmpDir);
    process.chdir(tmpDir);

    const scoped = await runHarnessSync({ check: true, fix: false, harness: 'codex' });
    expect(scoped.exitCode).toBe(1); // codex still has the generated hooks drift

    const bogus = await runHarnessSync({ check: true, fix: false, harness: 'bogus' });
    expect(bogus.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown harness'));
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
