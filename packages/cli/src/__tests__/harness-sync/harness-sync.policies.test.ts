import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HARNESS_MANIFEST_PATH } from '@dorkos/harness';
import { runHarnessSync } from '../../harness-sync-command.js';
import {
  createTempDir,
  pinEmptyClaudeRoot,
  syncArgs,
  writeFixtureRepo,
} from '../harness-fixtures.js';
import { snapshotTree, writeInstalledPlugin } from '../harness-fixtures.js';

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
    pinEmptyClaudeRoot(homeDir);
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

    it('TR-11: adds the harnesses key to a manifest that leaves it to the default', async () => {
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
  });

  describe('a harness that appeared after the manifest was written (TR-11)', () => {
    it('J-14, TR-11: enables Cursor, projects to it in the same run, and then goes quiet', async () => {
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
    it('AP-09: names the lines a fresh repo is missing, in both modes, without writing them', async () => {
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

    it('AP-09: appends them behind the flag, preserves the file, and then goes quiet', async () => {
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
  });
});

describe('runHarnessSync — the manifest lines that reach nothing (DOR-1858)', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let logSpy: MockInstance<typeof console.log>;

  /** Everything the run printed, joined so a block can be asserted verbatim. */
  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** Rewrite the fixture manifest; `harnesses` defaults to the fixture's two. */
  function writeManifest(extra: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(tmpDir, HARNESS_MANIFEST_PATH),
      JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'], ...extra }, null, 2)
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
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('VC-10: names every retired key still in the file, and still exits on the drift alone', async () => {
    // The four keys nothing ever read. There is no config migration for a
    // per-repo file, so this line IS the migration notice.
    writeManifest({
      skillWrappers: [{ target: 'codex', name: 'x' }],
      commandMappings: [],
      instructionProjections: [],
      skillBundles: [],
    });

    const check = await runHarnessSync(syncArgs({ check: true }));

    for (const key of [
      'skillWrappers',
      'commandMappings',
      'instructionProjections',
      'skillBundles',
    ]) {
      expect(printed()).toContain(
        `${key} in .agents/harness.manifest.json is no longer read — remove it`
      );
    }
    // Drift, from the unprojected fixture — never the notice.
    expect(check.exitCode).toBe(1);
  });

  it('HK-15: honours a hooks policy of none: no .codex/hooks.json is written, and the drop says why', async () => {
    // The behaviour half, through the real CLI: a `--fix` writes every other
    // projection and leaves the hooks file it was told not to write.
    writeManifest({ hookPolicies: [{ tool: 'codex', projection: 'none' }] });

    const fix = await runHarnessSync(syncArgs({ fix: true }));

    expect(fix.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(printed()).toContain(
      "hooks are not projected to Codex — your manifest's hookPolicies says none"
    );
  });

  it('HK-15, AP-07: names the hooks file a flipped policy just orphaned, and writes nothing (DOR-1889)', async () => {
    // The other half of honouring `none`: the file the engine wrote while the
    // policy was absent is now nobody's, and `--check` has to say a `--fix`
    // would remove it. Before DOR-1889 taught `checkPlan` to preview generated
    // orphans this tree reported clean and exited 0 over a live hooks file.
    writeManifest({ harnesses: ['claude-code', 'cursor'], hookPolicies: [] });
    await runHarnessSync(syncArgs({ fix: true }));
    const cursorHooks = path.join(tmpDir, '.cursor', 'hooks.json');
    expect(fs.existsSync(cursorHooks)).toBe(true);

    writeManifest({
      harnesses: ['claude-code', 'cursor'],
      hookPolicies: [{ tool: 'cursor', projection: 'none' }],
    });
    logSpy.mockClear();
    const check = await runHarnessSync(syncArgs({ check: true }));

    expect(check.exitCode).toBe(1);
    expect(printed()).toContain('Orphaned projections');
    expect(printed()).toContain('.cursor/hooks.json');
    expect(printed()).toContain('the orphaned paths above are removed');
    // `--check` never writes: the file it just named is still there.
    expect(fs.existsSync(cursorHooks)).toBe(true);
  });
});

describe('runHarnessSync — a durable yes for hooks a policy suppresses (DOR-1858 review)', () => {
  let tmpDir: string;
  let originalCwd: string;
  let homeDir: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const errors = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** Everything `~/.dork/config.json` records about hook decisions, or nothing. */
  function storedApprovals(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')) as {
        harness?: { approvedHooks?: string[] };
      };
      return raw.harness?.approvedHooks ?? [];
    } catch {
      return [];
    }
  }

  /** A project-scoped plugin that declares one Stop hook. */
  function writePluginWithHooks(name: string): void {
    const plugin = path.join(tmpDir, '.dork', 'plugins', name);
    fs.mkdirSync(path.join(plugin, '.dork'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name,
        version: '1.0.0',
        type: 'plugin',
        description: 'A fixture plugin',
        layers: ['hooks'],
      })
    );
    fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, 'hooks', 'hooks.json'),
      JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo plugin' }] }] })
    );
  }

  function writeManifest(shape: { harnesses: string[]; hookPolicies: unknown[] }): void {
    fs.writeFileSync(
      path.join(tmpDir, HARNESS_MANIFEST_PATH),
      JSON.stringify({ version: 1, ...shape }, null, 2)
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = createTempDir();
    homeDir = createTempDir();
    vi.stubEnv('DORK_HOME', homeDir);
    pinEmptyClaudeRoot(homeDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFixtureRepo(tmpDir);
    writePluginWithHooks('acme');
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('HK-15, HK-07: refuses, and records nothing, when every target is under a none policy', async () => {
    // The yes is durable and outlives the manifest. Recorded here it would sit in
    // config.json contradicting the drop line printed under it, install nothing,
    // and then install itself unprompted the day the policy line goes.
    writeManifest({
      harnesses: ['claude-code'],
      hookPolicies: [{ tool: 'claude-code', projection: 'none' }],
    });

    const result = await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme'] }));

    expect(result.exitCode).toBe(1);
    expect(storedApprovals()).toEqual([]);
    expect(errors()).toContain('nowhere to go here');
    expect(errors()).toContain('hookPolicies none for claude-code');
    expect(errors()).toContain('without asking again');
    // Nothing was applied either: the run stopped before the projection.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('HK-15, HK-07: does not let a refused allow become a silent install once the policy goes', async () => {
    // The whole reason the refusal exists, driven end to end.
    writeManifest({
      harnesses: ['claude-code'],
      hookPolicies: [{ tool: 'claude-code', projection: 'none' }],
    });
    await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme'] }));

    writeManifest({ harnesses: ['claude-code'], hookPolicies: [] });
    await runHarnessSync(syncArgs({ fix: true }));

    expect(fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);
    // Withheld and asked about again, which is the point: the refusal did not
    // leave a stored yes behind to fire the moment the policy stopped hiding it.
    expect(printed()).toContain('You have not allowed this package yet.');
    expect(printed()).toContain('dorkos harness sync --fix --allow-hooks acme');
  });

  it('HK-15, HK-07: refuses when no enabled agent has anywhere to receive hooks, policy or not', async () => {
    // The other route to the same latent yes, and it names no manifest line
    // because none is to blame: OpenCode has no declarative hook config at all,
    // so `Applied 0` was printed over a stored approval that would come true the
    // day somebody enabled Claude Code (DOR-1858 delta review, reproduced).
    writeManifest({ harnesses: ['opencode'], hookPolicies: [] });

    const result = await runHarnessSync(syncArgs({ fix: true, allowHooks: ['acme'] }));

    expect(result.exitCode).toBe(1);
    expect(storedApprovals()).toEqual([]);
    expect(errors()).toContain('nowhere to go here');
    expect(errors()).toContain('None of the agents this project uses (OpenCode)');
    expect(errors()).toContain('Turn on an agent that can take them');
    // No manifest line is blamed, because none is responsible.
    expect(errors()).not.toContain('hookPolicies');
  });
});
