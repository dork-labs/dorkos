/**
 * `dorkos harness global`, and the one-time question `dorkos harness sync
 * --global` asks before DorkOS ever writes into a home directory.
 *
 * Every case pins BOTH `$HOME` and `$CLAUDE_CONFIG_DIR` at temp directories it
 * owns, because the two user roots are resolved by different rules and pinning
 * one is not pinning the other. Nothing here can reach the developer's own home
 * folder, which matters more in this suite than in any other: the sweep it
 * drives is the only code in the repository that removes files from `~`.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runHarnessSync } from '../harness-sync-command.js';
import { runHarnessGlobal, parseHarnessGlobalArgs } from '../harness-global-command.js';
import { runHarnessDispatcher } from '../commands/harness-dispatcher.js';
import { createTempDir, pinHome, syncArgs } from './harness-fixtures.js';

describe('dorkos harness global — sharing your all-projects packages', () => {
  let dorkHome: string;
  let userHome: string;
  let claudeRoot: string;
  let originalCwd: string;
  let cwd: string;
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  /** Everything the run printed to stdout, in order. */
  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  /** Everything the run printed to stderr. */
  const errors = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  /** Where the user tier writes, resolved the way the command resolves it. */
  const agentsSkillsDir = (): string => path.join(userHome, '.agents', 'skills');
  const claudeSkillsDir = (): string => path.join(claudeRoot, 'skills');

  /** Install a package for all projects, holding the skills named. */
  function installGlobal(name: string, skills: readonly string[]): void {
    const dir = path.join(dorkHome, 'plugins', name);
    fs.mkdirSync(path.join(dir, '.dork'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dork', 'manifest.json'),
      JSON.stringify({ name, version: '1.0.0', type: 'plugin', description: name })
    );
    for (const skill of skills) {
      fs.mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: The ${skill} skill\n---\n\n# ${skill}\n`
      );
    }
  }

  /** The stored answer, read straight off the file this command writes. */
  function storedGlobal(): { harnesses: string[]; askedAt: string | null } | undefined {
    const file = path.join(dorkHome, 'config.json');
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      harness?: { global?: { harnesses: string[]; askedAt: string | null } };
    };
    return raw.harness?.global;
  }

  /** A `config.json` carrying exactly this answer, as a person who already answered would have. */
  function writeAnswer(harnesses: readonly string[], askedAt: string | null): void {
    fs.mkdirSync(dorkHome, { recursive: true });
    fs.writeFileSync(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({ version: 1, harness: { global: { harnesses, askedAt } } })
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    dorkHome = createTempDir();
    userHome = createTempDir();
    // The root a bare `claude` opens, pinned so no case reads the developer's.
    // Set directly rather than through `pinEmptyClaudeRoot`, because these cases
    // need to know the exact directory the links land in.
    claudeRoot = path.join(userHome, '.claude');
    cwd = createTempDir();
    vi.stubEnv('DORK_HOME', dorkHome);
    pinHome(userHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeRoot);
    process.chdir(cwd);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    for (const dir of [dorkHome, userHome, cwd]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins its own home directory, so nothing here can read the developer’s', () => {
    // The precondition every case below rests on, asserted rather than assumed:
    // `os.homedir()` answers `$HOME` before it asks the password database, and
    // this suite is the only one whose subject removes files from a home folder.
    expect(os.homedir()).toBe(userHome);
  });

  describe('case 6: the ask prints every link name and writes nothing', () => {
    it('prints the block, names each link, and leaves the settings file alone', async () => {
      installGlobal('globex', ['greet', 'wave']);
      const before = fs.existsSync(path.join(dorkHome, 'config.json'));

      const result = await runHarnessSync(syncArgs({ global: true }));

      // Zero, while the question is outstanding: this run's job was to ask it.
      expect(result.exitCode).toBe(0);
      const out = printed();
      expect(out).toContain(
        'Share the packages you installed for all your projects with your other agent tools?'
      );
      // Every link name, never a count. The list is what the person is agreeing
      // to, and a number is not.
      expect(out).toContain('  - globex__greet');
      expect(out).toContain('  - globex__wave');
      expect(out).toContain(
        `  ${agentsSkillsDir()}   read by Codex, OpenCode, Cursor, Gemini CLI and Copilot`
      );
      expect(out).toContain(`  ${claudeSkillsDir()}   read by Claude Code`);
      expect(out).toContain('  dorkos harness global --enable <tool>');

      // Seeded defect: write the config from the ask. The fixture's settings
      // file changes on a read-only run and this reds.
      expect(fs.existsSync(path.join(dorkHome, 'config.json'))).toBe(before);
      expect(storedGlobal()).toBeUndefined();
      // And nothing at all in the home directory.
      expect(fs.existsSync(agentsSkillsDir())).toBe(false);
      expect(fs.existsSync(claudeSkillsDir())).toBe(false);
    });

    it('--enable writes exactly one array element and stamps askedAt', async () => {
      installGlobal('globex', ['greet']);

      const result = await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));

      expect(result.exitCode).toBe(0);
      const stored = storedGlobal();
      expect(stored?.harnesses).toEqual(['codex']);
      expect(stored?.askedAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(stored?.askedAt ?? ''))).toBe(false);

      // And the links land where that tool looks, and nowhere else.
      expect(fs.lstatSync(path.join(agentsSkillsDir(), 'globex__greet')).isSymbolicLink()).toBe(
        true
      );
      expect(fs.existsSync(claudeSkillsDir())).toBe(false);
    });

    it('--enable a second tool adds one element and keeps the first', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'claude-code']));

      // Stored in `HARNESS_IDS` order, so the list reads the same way whatever
      // order somebody enabled things in.
      expect(storedGlobal()?.harnesses).toEqual(['claude-code', 'codex']);
      expect(fs.lstatSync(path.join(claudeSkillsDir(), 'globex__greet')).isSymbolicLink()).toBe(
        true
      );
    });

    it('--enable refuses a name that is not an agent tool, and writes nothing', async () => {
      const result = await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'emacs']));
      expect(result.exitCode).toBe(1);
      expect(errors()).toContain("'emacs' is not an agent tool DorkOS knows.");
      expect(storedGlobal()).toBeUndefined();
    });

    it('--list stamps nothing', async () => {
      installGlobal('globex', ['greet']);
      const result = await runHarnessGlobal(parseHarnessGlobalArgs(['--list']));
      expect(result.exitCode).toBe(0);
      expect(storedGlobal()).toBeUndefined();
      expect(printed()).toContain('DorkOS has not asked you yet.');
    });

    it('--list says which of the five tools DorkOS has actually tested', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'cursor']));
      logSpy.mockClear();

      await runHarnessGlobal(parseHarnessGlobalArgs(['--list']));
      const out = printed();
      expect(out).toContain('Cursor');
      // Six names in a list read as six measurements, and only one of them is.
      expect(out).toContain('DorkOS tested Codex on 2026-09-09 and it reads this folder.');
      expect(out).toContain('DorkOS has not tested them.');
    });
  });

  describe('a machine that never said yes is never read', () => {
    it('--fix --global does not touch a hand-built link in a home folder nobody shared with', async () => {
      // The reason a user root is resolved only for a tool that is enabled. The
      // roots are what the SWEEP scans, so resolving them unconditionally would
      // have every global run read two folders in a home directory on a machine
      // that never shared anything — and offer for removal a link a person
      // built there themselves, with exactly the text DorkOS uses.
      installGlobal('globex', ['greet']);
      const theirs = path.join(agentsSkillsDir(), 'globex__greet');
      fs.mkdirSync(agentsSkillsDir(), { recursive: true });
      fs.symlinkSync(
        path.relative(
          agentsSkillsDir(),
          path.join(dorkHome, 'plugins', 'globex', 'skills', 'greet')
        ),
        theirs
      );

      const result = await runHarnessSync(syncArgs({ fix: true, global: true }));

      expect(result.exitCode).toBe(0);
      expect(fs.lstatSync(theirs).isSymbolicLink()).toBe(true);
      expect(printed()).not.toContain('Removing');
    });
  });

  describe('case 7: a declined answer is remembered', () => {
    it('an empty list with askedAt set never asks again', async () => {
      installGlobal('globex', ['greet']);
      // Declined: asked, and said no to every tool.
      writeAnswer([], '2026-09-09T00:00:00.000Z');

      await runHarnessSync(syncArgs({ global: true }));

      // Seeded defect: treat an empty list as unasked. The block then prints on
      // every run, which is exactly the nagging a remembered no exists to stop.
      expect(printed()).not.toContain(
        'Share the packages you installed for all your projects with your other agent tools?'
      );
    });

    it('a --disable that empties the list leaves askedAt set', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));
      const stamped = storedGlobal()?.askedAt;

      await runHarnessGlobal(parseHarnessGlobalArgs(['--disable', 'codex']));

      expect(storedGlobal()?.harnesses).toEqual([]);
      expect(storedGlobal()?.askedAt).toEqual(expect.any(String));
      expect(stamped).toEqual(expect.any(String));

      // And the ask does not come back.
      logSpy.mockClear();
      await runHarnessSync(syncArgs({ global: true }));
      expect(printed()).not.toContain(
        'Share the packages you installed for all your projects with your other agent tools?'
      );
    });
  });

  describe('case 8: --disable sweeps the DIFFERENCE before it forgets the tool', () => {
    it('disabling one of two tools that share a folder removes NOTHING', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'cursor']));
      const link = path.join(agentsSkillsDir(), 'globex__greet');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      logSpy.mockClear();

      const result = await runHarnessGlobal(parseHarnessGlobalArgs(['--disable', 'cursor']));

      // Seeded defect two: sweep the whole directory rather than the difference.
      // Codex loses its skills when Cursor is disabled, and this reds.
      expect(result.exitCode).toBe(0);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(storedGlobal()?.harnesses).toEqual(['codex']);
      expect(printed()).toContain(
        '  Nothing to remove: the same links serve the other agent tools you share with.'
      );
    });

    it('disabling the LAST reader of a folder empties it of DorkOS links, and nothing else', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'cursor']));

      // A file the person put in the same folder themselves.
      const theirs = path.join(agentsSkillsDir(), 'my-own-skill');
      fs.mkdirSync(theirs, { recursive: true });
      fs.writeFileSync(path.join(theirs, 'SKILL.md'), '---\nname: mine\n---\nHands off.\n');

      await runHarnessGlobal(parseHarnessGlobalArgs(['--disable', 'cursor']));
      logSpy.mockClear();
      const result = await runHarnessGlobal(parseHarnessGlobalArgs(['--disable', 'codex']));

      // Seeded defect one: write the config first. The directory is then
      // untargeted, nothing scans it, the link is stranded, and this reds.
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(agentsSkillsDir(), 'globex__greet'))).toBe(false);
      expect(fs.readFileSync(path.join(theirs, 'SKILL.md'), 'utf8')).toContain('Hands off.');
      expect(storedGlobal()?.harnesses).toEqual([]);
    });

    it('prints every path before it removes it', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));
      const link = path.join(agentsSkillsDir(), 'globex__greet');
      logSpy.mockClear();

      // Console ORDER cannot answer this on its own: printing the promise after
      // the deletion still puts it above the receipt. So each line is recorded
      // with what was on disk AT THE MOMENT it was printed.
      const trace: { text: string; linkStillThere: boolean }[] = [];
      logSpy.mockImplementation((...args: unknown[]) => {
        trace.push({
          text: String(args[0]),
          linkStillThere: fs.lstatSync(link, { throwIfNoEntry: false }) !== undefined,
        });
      });

      await runHarnessGlobal(parseHarnessGlobalArgs(['--disable', 'codex']));

      const promise = trace.find((line) => line.text.includes(link));
      expect(promise, 'the path was never printed').toBeDefined();
      expect(promise?.linkStillThere, 'the path was printed after it was removed').toBe(true);
      // And the reason travels with it, so a list of deletions is never a bare
      // list of paths.
      expect(promise?.text).toMatch(/ — .+/);
    });

    it('disabling Claude Code always removes something, because that folder has one reader', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'claude-code']));
      const claudeLink = path.join(claudeSkillsDir(), 'globex__greet');
      const sharedLink = path.join(agentsSkillsDir(), 'globex__greet');

      await runHarnessGlobal(parseHarnessGlobalArgs(['--disable', 'claude-code']));

      expect(fs.existsSync(claudeLink)).toBe(false);
      // Codex is untouched: a different directory, a different reader.
      expect(fs.lstatSync(sharedLink).isSymbolicLink()).toBe(true);
    });

    it('refuses a tool that is not shared with, and changes nothing', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));

      const result = await runHarnessGlobal(parseHarnessGlobalArgs(['--disable', 'cursor']));

      expect(result.exitCode).toBe(1);
      expect(errors()).toContain('Not sharing with Cursor, so there is nothing to stop.');
      expect(storedGlobal()?.harnesses).toEqual(['codex']);
    });
  });

  describe('the boundary: a confined deployment is not asked and does not write in a home folder', () => {
    it('DORKOS_BOUNDARY set: the dork-home tier still runs, the user tier does not, and nobody is asked', async () => {
      installGlobal('globex', ['greet']);
      vi.stubEnv('DORKOS_BOUNDARY', '/workspace');

      const result = await runHarnessSync(syncArgs({ fix: true, global: true }));

      expect(result.exitCode).toBe(0);
      // Seeded defect: derive the answer from `initBoundary`, which the CLI
      // never calls. The links appear in the home directory and this reds.
      expect(fs.existsSync(agentsSkillsDir())).toBe(false);
      expect(fs.existsSync(claudeSkillsDir())).toBe(false);
      // The scheduled half is unaffected: `<dorkHome>` is DorkOS's own folder.
      expect(fs.lstatSync(path.join(dorkHome, 'skills', 'globex__greet')).isSymbolicLink()).toBe(
        true
      );
      const out = printed();
      expect(out).toContain(
        'Packages you installed for all your projects stay inside DorkOS on this machine.'
      );
      expect(out).toContain(
        'DorkOS is limited to /workspace, so it will not add links in your home folder.'
      );
      expect(out).not.toContain('Share the packages you installed for all your projects');
    });

    it('server.boundary in config and NO environment variable does the same', async () => {
      // The case a variable-only predicate gets wrong. `cli.ts` populates
      // `DORKOS_BOUNDARY` from config only AFTER the `harness` subcommand has
      // been intercepted, so inside this command the variable is still unset and
      // the config field is the only evidence there is.
      installGlobal('globex', ['greet']);
      fs.writeFileSync(
        path.join(dorkHome, 'config.json'),
        JSON.stringify({ version: 1, server: { boundary: '/workspace' } })
      );
      expect(process.env.DORKOS_BOUNDARY).toBeUndefined();

      const result = await runHarnessSync(syncArgs({ fix: true, global: true }));

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(agentsSkillsDir())).toBe(false);
      expect(printed()).toContain('DorkOS is limited to /workspace');
    });

    it('neither set: the user tier is planned, and the question is asked', async () => {
      installGlobal('globex', ['greet']);
      expect(process.env.DORKOS_BOUNDARY).toBeUndefined();

      await runHarnessSync(syncArgs({ global: true }));

      expect(printed()).toContain(
        'Share the packages you installed for all your projects with your other agent tools?'
      );
    });
  });

  describe('the sentence about what DorkOS has tested', () => {
    it('is said when the shared folder is in play, and not when only Claude Code is', async () => {
      installGlobal('globex', ['greet']);

      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'claude-code']));
      // Five tools none of this run touched. Saying it here would be a sentence
      // about a folder nothing was written to.
      expect(printed()).not.toContain('DorkOS tested Codex on 2026-09-09');
      logSpy.mockClear();

      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'codex']));
      expect(printed()).toContain('DorkOS tested Codex on 2026-09-09');
    });
  });

  describe('the restart caveat', () => {
    it('prints once when the run created a skills folder that was not there before', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'claude-code']));
      // The enable that CREATED the folder says it too, once.
      expect(printed().split('Claude Code needs a restart').length - 1).toBe(1);
      logSpy.mockClear();

      // The folder is gone again, so the next run creates it.
      fs.rmSync(claudeSkillsDir(), { recursive: true, force: true });
      await runHarnessSync(syncArgs({ fix: true, global: true }));

      const out = printed();
      const occurrences = out.split('Claude Code needs a restart').length - 1;
      expect(occurrences).toBe(1);
      expect(out).toContain('In Gemini CLI, run /skills reload.');
    });

    it('does not print when every folder was already there', async () => {
      installGlobal('globex', ['greet']);
      await runHarnessGlobal(parseHarnessGlobalArgs(['--enable', 'claude-code']));
      logSpy.mockClear();

      await runHarnessSync(syncArgs({ fix: true, global: true }));

      // A tool already reading a folder picks up a new link in it on its own.
      // Saying otherwise teaches people to restart for nothing.
      expect(printed()).not.toContain('Claude Code needs a restart');
    });
  });

  describe('the dispatcher', () => {
    it('routes `harness global`', async () => {
      installGlobal('globex', ['greet']);
      const code = await runHarnessDispatcher('global', ['--list']);
      expect(code).toBe(0);
      expect(printed()).toContain('Packages you installed for all your projects:');
    });

    it('prints help for `harness global --help` rather than a parse error', async () => {
      const code = await runHarnessDispatcher('global', ['--help']);
      expect(code).toBe(0);
      expect(printed()).toContain('Options (global):');
    });

    it('names `global` among the subcommands an unknown one is measured against', async () => {
      const code = await runHarnessDispatcher('nonsense', []);
      expect(code).toBe(1);
      expect(errors()).toContain('Usage: dorkos harness <sync|hooks|global> [options]');
    });
  });

  describe('argument parsing', () => {
    it('bare `global` means --list', () => {
      expect(parseHarnessGlobalArgs([])).toEqual({
        list: true,
        enable: undefined,
        disable: undefined,
      });
    });

    it('refuses --enable and --disable together', async () => {
      const result = await runHarnessGlobal({ list: false, enable: 'codex', disable: 'cursor' });
      expect(result.exitCode).toBe(1);
      expect(errors()).toContain('Pass either --enable or --disable, not both.');
    });

    it('rejects an unknown option by name', () => {
      expect(() => parseHarnessGlobalArgs(['--nope'])).toThrow(/--nope/);
    });
  });
});
