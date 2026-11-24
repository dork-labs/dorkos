import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runHarnessSync } from '../../harness-sync-command.js';
import { runHarnessHooks } from '../../harness-hooks-command.js';
import { hookApprovalEntry } from '../../../server/services/harness/hook-consent.js';
import { scanHookRequests } from '../../../server/services/harness/project-with-consent.js';
import { runHarnessDispatcher } from '../../commands/harness-dispatcher.js';
import {
  createTempDir,
  pinEmptyClaudeRoot,
  syncArgs,
  writeFixtureRepo,
} from '../harness-fixtures.js';
import { writeInstalledPlugin } from '../harness-fixtures.js';

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

  /**
   * The entry a yes to `acme-tools`'s hooks records now: the commands, plus the
   * files they run as they are on disk (DOR-3403).
   */
  function pinnedAcmeEntry(): string {
    const request = scanHookRequests(repoRoot(), homeDir).find(
      (r) => r.packageName === 'acme-tools'
    );
    if (!request) throw new Error('acme-tools declares no hooks');
    return hookApprovalEntry(request);
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
    pinEmptyClaudeRoot(homeDir);
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

  it('HK-07: holds the hooks back, names every command and the exact re-run, and exits 0', async () => {
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

  it('--strict exits 1, and still applies everything else first', async () => {
    const strict = await runHarnessSync(syncArgs({ fix: true, strict: true }));

    expect(strict.exitCode).toBe(1);
    expect(printed()).toContain('--strict: exiting 1 because hooks were withheld.');
    // Everything that was not held back still landed.
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'CLAUDE.md'))).toBe(true);
  });

  it('HK-07, VC-05: --allow-hooks installs the commands AND records the same entry the card writes', async () => {
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
    // store the app reads too, with the files the hooks run pinned (DOR-3403).
    expect(storedHarness()?.approvedHooks).toEqual([pinnedAcmeEntry()]);

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
    expect(storedHarness()?.approvedHooks).toEqual([pinnedAcmeEntry()]);
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

  it('HK-10: says the Codex hooks file changed and is held for review, once', async () => {
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
    pinEmptyClaudeRoot(homeDir);
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

  it('--list says nothing is stored, and creates no config file doing it', async () => {
    const result = await runHarnessHooks({ list: true });

    expect(result.exitCode).toBe(0);
    expect(printed()).toContain('No hook decisions stored yet.');
    // The read path must not open the config store: `conf`'s constructor writes
    // the file and the directory around it (DOR-678's rule, a different route).
    expect(fs.existsSync(path.join(homeDir, 'config.json'))).toBe(false);
  });

  it('VC-05: --list names each package and whether the decision is about this project', async () => {
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

  it('--list names a global package\u2019s decision as one about every session (DOR-2306)', async () => {
    // Purpose: the same lists hold a person's yes for a globally installed
    // package's programs; reading it as "another project" would be false.
    writeStored({
      approvedHooks: [`globex@global-${'a'.repeat(64)}`],
      refusedHooks: [],
    });

    await runHarnessHooks({ list: true });

    expect(printed()).toContain('globex — for the globally installed package, in every chat');
  });

  it('VC-05: --revoke forgets a package and says the next sync will ask again', async () => {
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
