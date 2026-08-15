/**
 * What may, and may not, cost a person their config file.
 *
 * The defect these cover: `conf` rethrows every load failure the same way, and
 * the recovery branch used to read any throw as proof of corruption — back the
 * file up, delete it, start again on defaults. A valid config was destroyed
 * that way during a burst of file-descriptor pressure, taking a person's
 * status-bar pins with it. The `.bak` it left behind parsed and validated
 * cleanly.
 *
 * Three claims are tested as one set, because a fix for any one of them can
 * break another:
 *
 * 1. A genuinely bad FILE is still replaced, and still salvaged from.
 * 2. A file the OS refused is never touched, however long the refusal lasts.
 * 3. A deterministic failure that is neither still recovers, rather than
 *    blocking every boot from here on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ConfigManager,
  ConfigUnreadableError,
  classifyConfigLoadFailure,
  CONFIG_LOAD_RETRY_DELAYS_MS,
} from '../config-manager.js';

/**
 * The retry staircase, with the waiting taken out.
 *
 * Same number of attempts, no real seconds spent. `sleepSync` parks the worker
 * thread, and at the shipped delays this suite held one for around thirty
 * seconds, which was enough to make timing-sensitive tests in other files
 * flake. The one test below that must prove the shipped schedule says so.
 */
const FAST_RETRIES = { retryDelaysMs: [0, 0, 0] } as const;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    // A test that made the file unreadable has to hand the permission back
    // before the tree can be removed.
    const configPath = path.join(dir, 'config.json');
    if (fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh temp data directory, cleaned up after the test. */
function makeDir(slug: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dorkos-${slug}-`));
  dirs.push(dir);
  return dir;
}

/**
 * Every backup of the config file in a data directory, oldest first.
 *
 * Matched by suffix rather than by the production module's own pattern, so a
 * change to the naming shows up here as a real result rather than being agreed
 * with. Backups are timestamped now (DOR-1221): a fixed `config.json.bak` was
 * overwritten by the NEXT recovery, so a machine that recovered twice kept only
 * the second wipe's evidence.
 */
function backupsIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.bak'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** An `fs` error carrying an errno code, the shape a real I/O failure has. */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${message}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Make reads of one path fail with an errno error.
 *
 * Spies on the shared `fs` object that `conf` itself calls through, which is
 * the only way to stage `EMFILE`: a test cannot exhaust the process's file
 * descriptors on purpose. Every other path reads normally, so the temp dir and
 * the rest of the suite are unaffected.
 *
 * @param configPath - The path whose reads should fail.
 * @param code - The errno code to raise.
 * @param options - `times` caps how many reads fail; `when` narrows further.
 * @returns A counter of how many reads were failed.
 */
function failReadsOf(
  configPath: string,
  code: string,
  options: { times?: number; when?: () => boolean } = {}
) {
  const { times = Number.POSITIVE_INFINITY, when } = options;
  const real = fs.readFileSync.bind(fs);
  const state = { failed: 0 };
  const fake = (file: unknown, fileOptions?: unknown): unknown => {
    const targeted = typeof file === 'string' && path.resolve(file) === configPath;
    if (targeted && state.failed < times && (when === undefined || when())) {
      state.failed++;
      throw errnoError(code, `injected by test, open '${file}'`);
    }
    return (real as (f: unknown, o?: unknown) => unknown)(file, fileOptions);
  };
  vi.spyOn(fs, 'readFileSync').mockImplementation(fake as unknown as typeof fs.readFileSync);
  return state;
}

describe('classifyConfigLoadFailure', () => {
  it('condemns the file outright only for the three failures that come from its bytes', () => {
    expect(classifyConfigLoadFailure(new SyntaxError('Unexpected end of JSON input'))).toBe(
      'corrupt'
    );
    expect(
      classifyConfigLoadFailure(new Error('Config schema violation: `server.port` must be integer'))
    ).toBe('corrupt');
    expect(classifyConfigLoadFailure(new Error('Failed to decrypt config data.'))).toBe('corrupt');
  });

  it('never condemns the file for an I/O failure, whatever the code', () => {
    // The exact class of error that destroyed a valid config. `io` is the one
    // verdict the retry loop refuses to escalate, no matter how long it lasts.
    for (const code of ['EMFILE', 'ENFILE', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'EAGAIN']) {
      expect(classifyConfigLoadFailure(errnoError(code, 'nope'))).toBe('io');
    }
  });

  it('holds an unrecognised failure for the retry loop to judge', () => {
    // Neither proven-about-the-file nor proven-about-the-OS. `conf` throws a
    // bare TypeError from inside its migration machinery, which really is
    // about the file, so this class cannot simply be treated as unreadable.
    expect(classifyConfigLoadFailure(new TypeError('Invalid Version: 0.5@.0'))).toBe('unknown');
    expect(classifyConfigLoadFailure('not even an error')).toBe('unknown');
    expect(classifyConfigLoadFailure(undefined)).toBe('unknown');
  });

  it('blames DorkOS, not the file, when a migration body threw', () => {
    // DOR-1221. This used to be `unknown`, which meant a bug in DorkOS's own
    // upgrade code failed four times, looked deterministic, and condemned a
    // perfectly good config. `conf` marks the case for us: everything thrown
    // inside its per-migration `try` comes back under this sentence.
    expect(
      classifyConfigLoadFailure(
        new Error('Something went wrong during the migration! Cannot read properties of undefined')
      )
    ).toBe('migration');
    // But an errno laundered through that same wrapper is still the machine's
    // fault, and must keep the never-replace protection it already had.
    expect(
      classifyConfigLoadFailure(
        new Error(
          "Something went wrong during the migration! EMFILE: too many open files, open '/x'"
        )
      )
    ).toBe('io');
  });

  it("does not mistake Node's ERR_ codes for a disk problem", () => {
    // `ERR_*` reports a bad call, not a refused syscall, so it must not buy
    // the never-replace protection that a real errno does.
    expect(classifyConfigLoadFailure(errnoError('ERR_INVALID_ARG_TYPE', 'bad call'))).toBe(
      'unknown'
    );
  });
});

describe('the shipped retry policy', () => {
  it('is a real staircase, not one a test quietly flattened', () => {
    // Every case below injects its own delays so the suite does not spend the
    // schedule in real time, which means NOTHING else would notice this being
    // set to [0, 0, 0]. The wall-clock assertion that used to cover it was
    // removed for being flaky under load; this is the non-flaky replacement.
    expect([...CONFIG_LOAD_RETRY_DELAYS_MS]).toEqual([50, 200, 500]);
  });
});

describe('a genuinely damaged config is still replaced', () => {
  it('backs up and resets a file whose JSON does not parse', () => {
    const dir = makeDir('load-syntax');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ "server": { "port": 5000 ');

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
    expect(manager.get('server').port).toBe(4242);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('does not let a second recovery overwrite what the first one saved', () => {
    // DOR-1221, and the seam the defect actually lived at: the manager's own
    // backup call. Everything else here asserts "a backup exists", which the old
    // single fixed `config.json.bak` satisfied identically — it just held the
    // WRONG settings by the time anyone looked. Five recoveries were logged on
    // one machine and one backup survived them, holding a config that had
    // already been replaced with defaults.
    const dir = makeDir('load-two-wipes');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        server: { port: 'the settings the person actually had' },
        auth: { enabled: true },
      })
    );

    new ConfigManager(dir, FAST_RETRIES);
    const [firstBackup] = backupsIn(dir);
    expect(firstBackup).toBeDefined();

    // The file is damaged a second time, days later as far as this cares.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, server: { port: 'damaged again, much later' } })
    );
    new ConfigManager(dir, FAST_RETRIES);

    // Two backups, two names, and — the point — the FIRST one still holds the
    // settings from before the FIRST wipe. Compared by value, not by bytes:
    // conf merges its defaults into the file before any of this code gets a
    // verdict, so the backup is the person's settings, not their file.
    const backups = backupsIn(dir);
    expect(backups).toHaveLength(2);
    expect(new Set(backups).size).toBe(2);
    const saved = JSON.parse(fs.readFileSync(firstBackup!, 'utf-8')) as {
      server: { port: string };
      auth: { enabled: boolean };
    };
    expect(saved.server.port).toBe('the settings the person actually had');
    expect(saved.auth.enabled).toBe(true);
  });

  it('salvages nothing from a truncated file, and lands on the safe defaults anyway', () => {
    // Salvage reads the doomed file with `JSON.parse`, so a file that fails to
    // parse has nothing to give. The protections still hold because a fresh
    // config already sits on the protective side; the carry-across is proved on
    // the schema-violation case below, where the file really is readable.
    const dir = makeDir('load-syntax-salvage');
    fs.writeFileSync(path.join(dir, 'config.json'), '{ truncated');

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(manager.get('telemetry').userHasDecided).toBe(false);
    expect(manager.get('telemetry').install).toBe(false);
    expect(manager.get('auth').enabled).toBe(false);
  });

  it('backs up, resets and salvages a file that parses but violates the schema', () => {
    const dir = makeDir('load-schema');
    const configPath = path.join(dir, 'config.json');
    // `server.port` must be an integer. The rest of the file is perfectly
    // readable, which is what makes salvage both possible and necessary.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        server: { port: 'not-a-port' },
        auth: { enabled: true },
        approvals: { trustWindowMinutes: 15 },
        telemetry: {
          userHasDecided: true,
          install: false,
          heartbeat: false,
          errorReporting: false,
          usage: false,
          linkAnalyticsToAccount: false,
          aiMetadata: false,
          lastPromptedVersion: '0.57.0',
        },
      })
    );

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(backupsIn(dir)).toHaveLength(1);
    expect(manager.get('server').port).toBe(4242);
    // DOR-584: a wipe may lose preferences, never a protection.
    expect(manager.get('auth').enabled).toBe(true);
    expect(manager.get('approvals').trustWindowMinutes).toBe(15);
    expect(manager.get('telemetry').userHasDecided).toBe(true);
    expect(manager.validate()).toEqual({ valid: true });
  });
});

/**
 * `conf` runs the migration chain inside its constructor, and feeds the file's
 * own `__internal__.migrations.version` straight into `semver`
 * (`_shouldPerformMigration`). Nothing validates that value first: it sits
 * outside the Ajv schema, and `conf` skips validation while migrating. So one
 * damaged byte in a file that is still valid JSON and still schema-valid throws
 * a bare `TypeError` from a place the load-failure allowlist never sees.
 *
 * Treating that as "could not read" would block every future boot while telling
 * the person their file was fine and to try again. These are the three shapes
 * that reproduce it.
 */
describe('a file that breaks the migration chain is recovered, not left to block boot', () => {
  const BROKEN_VERSIONS: Array<[string, unknown]> = [
    ['one flipped byte', '0.5@.0'],
    ['a number instead of a version', 57],
    ['a null', null],
  ];

  for (const [name, version] of BROKEN_VERSIONS) {
    it(`recovers from ${name} in __internal__.migrations.version`, () => {
      const dir = makeDir('load-migration');
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          auth: { enabled: true },
          __internal__: { migrations: { version } },
        })
      );

      const manager = new ConfigManager(dir, FAST_RETRIES);

      // Booted, backed up, and the protection carried across.
      expect(backupsIn(dir)).toHaveLength(1);
      expect(manager.validate()).toEqual({ valid: true });
      expect(manager.get('auth').enabled).toBe(true);
      // And the next boot is an ordinary one, rather than repeating this.
      expect(new ConfigManager(dir, FAST_RETRIES).get('auth').enabled).toBe(true);
    });
  }

  it('still loads a healthy migration version through a read failure that clears', () => {
    // The other side of the same file: nothing wrong with it, and a burst of
    // I/O failures on the way in. Recovering the case above must not turn this
    // one into a wipe.
    const dir = makeDir('load-migration-transient');
    const configPath = path.join(dir, 'config.json');
    new ConfigManager(dir, FAST_RETRIES).setDot('auth.enabled', true);
    const before = fs.readFileSync(configPath, 'utf-8');

    const injected = failReadsOf(configPath, 'EMFILE', { times: 1 });
    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(injected.failed).toBe(1);
    expect(manager.get('auth').enabled).toBe(true);
    expect(backupsIn(dir)).toEqual([]);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });
});

describe('a config the OS refused is left alone', () => {
  it('preserves the file byte for byte when every read fails with EMFILE', () => {
    const dir = makeDir('load-emfile');
    const configPath = path.join(dir, 'config.json');
    // The real report: a valid config, with pins the person had chosen, read
    // while the machine was out of file descriptors.
    new ConfigManager(dir, FAST_RETRIES).setDot('ui.statusBar.pins', ['permission']);
    const before = fs.readFileSync(configPath, 'utf-8');

    // The ONE case that runs the shipped schedule rather than the shortened
    // one, so the delays production actually uses are exercised end to end and
    // the retry-count assertion below is measured against them.
    const injected = failReadsOf(configPath, 'EMFILE');
    expect(() => new ConfigManager(dir)).toThrow(ConfigUnreadableError);
    vi.restoreAllMocks();

    // Untouched: same bytes, no backup, no replacement. This is the claim a
    // plain "it failed every time, so the file must be bad" rule would break.
    // The storm behind the real incident outlasted any boot-time backoff.
    //
    // Byte equality holds HERE only because `ConfigManager` wrote this fixture,
    // so it is already default-shaped and conf's `assert.deepEqual` skips the
    // write it would otherwise do. Do not read this as a general guarantee: on
    // an upgrade boot conf rewrites the file with its defaults merged in before
    // any of this code gets a verdict. What DorkOS promises is that it does not
    // replace or delete the file, which is what the message now says.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(backupsIn(dir)).toEqual([]);
    expect(new ConfigManager(dir, FAST_RETRIES).getDot('ui.statusBar.pins')).toEqual([
      'permission',
    ]);
    // Four attempts, one read each: the staircase ran, then gave up.
    expect(injected.failed).toBe(4);
  });

  it.skipIf(process.getuid?.() === 0)('preserves the file when the read fails with EACCES', () => {
    const dir = makeDir('load-eacces');
    const configPath = path.join(dir, 'config.json');
    new ConfigManager(dir, FAST_RETRIES).setDot('server.port', 5123);
    const before = fs.readFileSync(configPath, 'utf-8');

    // A real permission failure, no mock involved.
    fs.chmodSync(configPath, 0o000);
    expect(() => new ConfigManager(dir, FAST_RETRIES)).toThrow(ConfigUnreadableError);
    fs.chmodSync(configPath, 0o600);

    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(backupsIn(dir)).toEqual([]);
    expect(new ConfigManager(dir, FAST_RETRIES).getDot('server.port')).toBe(5123);
  });

  it('names the file and the real reason instead of throwing them away', () => {
    const dir = makeDir('load-message');
    const configPath = path.join(dir, 'config.json');
    new ConfigManager(dir, FAST_RETRIES);
    failReadsOf(configPath, 'EMFILE');

    let thrown: unknown;
    try {
      new ConfigManager(dir, FAST_RETRIES);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigUnreadableError);
    const error = thrown as ConfigUnreadableError;
    expect(error.configPath).toBe(configPath);
    expect(error.message).toContain(configPath);
    expect(error.message).toContain('EMFILE');
    expect(error.message).toContain('did not replace or delete your settings');
    expect((error.cause as NodeJS.ErrnoException).code).toBe('EMFILE');
    // A descriptor shortage really does pass, so "try again" is true advice.
    expect(error.advice).toContain('start DorkOS again');
  });

  it.skipIf(process.getuid?.() === 0)(
    'does not tell someone to retry a permission they lack',
    () => {
      // The one errno that never clears. "Both pass on their own, so start
      // DorkOS again" is a false diagnosis here and an instruction to loop, so
      // the advice branches on what the operating system actually said.
      const dir = makeDir('load-advice-eacces');
      const configPath = path.join(dir, 'config.json');
      new ConfigManager(dir, FAST_RETRIES);
      fs.chmodSync(configPath, 0o000);

      let thrown: unknown;
      try {
        new ConfigManager(dir, FAST_RETRIES);
      } catch (error) {
        thrown = error;
      }
      fs.chmodSync(configPath, 0o600);

      const advice = (thrown as ConfigUnreadableError).advice;
      expect(advice).not.toContain('pass on their own');
      expect(advice).not.toContain('start DorkOS again');
      // Both real ways out are named: fix the permission, or start fresh without
      // losing the old file.
      expect(advice).toContain('chmod u+rw');
      expect(advice).toContain('rename');
    }
  );

  it('rides out a read failure that clears, and loads the real settings', () => {
    const dir = makeDir('load-retry');
    const configPath = path.join(dir, 'config.json');
    new ConfigManager(dir, FAST_RETRIES).setDot('server.port', 5199);

    // One bad read, then the descriptors come back — the common shape of the
    // failure, and the reason a retry is worth the wait.
    const injected = failReadsOf(configPath, 'EMFILE', { times: 1 });
    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(injected.failed).toBe(1);
    expect(manager.getDot('server.port')).toBe(5199);
    expect(backupsIn(dir)).toEqual([]);
  });

  it('never replaces a file it could not read, even one it just condemned', () => {
    // The general guarantee, and the backstop behind the errno classification.
    // The file really is damaged, so every rule so far says replace it — but
    // the read that salvage depends on keeps failing, which means the machine
    // is in trouble too. Replacing now would destroy a file with no protection
    // carried across, on a verdict that could not be checked.
    const dir = makeDir('load-salvage-gate');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ truncated');
    const before = fs.readFileSync(configPath, 'utf-8');

    // conf reads once and raises a SyntaxError from the bytes; the salvage read
    // that follows is the one that fails.
    let reads = 0;
    failReadsOf(configPath, 'EMFILE', { when: () => ++reads > 1 });

    expect(() => new ConfigManager(dir, FAST_RETRIES)).toThrow(ConfigUnreadableError);
    vi.restoreAllMocks();

    expect(backupsIn(dir)).toEqual([]);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('recovers a damaged file even when the salvage read blips once', () => {
    // The other side of the gate. Refusing to replace an unreadable file is
    // right; refusing over one unlucky read would block boot on a file that
    // really is broken and really is readable. So the salvage read gets the
    // same staircase the load does. A truncated file makes conf throw on its
    // very first read, so the read after it is the salvage read.
    const dir = makeDir('load-salvage-retry');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ truncated');

    let reads = 0;
    const injected = failReadsOf(configPath, 'EMFILE', { when: () => ++reads === 2, times: 1 });

    const manager = new ConfigManager(dir, FAST_RETRIES);

    expect(injected.failed).toBe(1);
    expect(backupsIn(dir)).toHaveLength(1);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('stops rather than half-replacing when the backup copy is refused', () => {
    const dir = makeDir('load-copy-refused');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ truncated');

    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw errnoError('EACCES', `permission denied, copyfile '${configPath}'`);
    });

    // A raw errno escaping the constructor is what `origin/main` did; this has
    // to arrive as the typed error both callers know how to print.
    expect(() => new ConfigManager(dir, FAST_RETRIES)).toThrow(ConfigUnreadableError);
    vi.restoreAllMocks();

    expect(fs.existsSync(configPath)).toBe(true);
    expect(backupsIn(dir)).toEqual([]);
  });

  it('tells someone with a full disk to free up space, not to rename a file', () => {
    // The rename hatch is the fallback's whole offer, and it is useless here:
    // renaming does not let DorkOS write a new file onto a disk with no room.
    // Reachable through the backup copy on the recovery path.
    const dir = makeDir('load-no-space');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ truncated');

    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw errnoError('ENOSPC', `no space left on device, copyfile '${configPath}'`);
    });

    let thrown: unknown;
    try {
      new ConfigManager(dir, FAST_RETRIES);
    } catch (error) {
      thrown = error;
    }
    vi.restoreAllMocks();

    expect(thrown).toBeInstanceOf(ConfigUnreadableError);
    const advice = (thrown as ConfigUnreadableError).advice;
    expect(advice).toContain('Free up some disk space');
    expect(advice).not.toContain('rename');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('reports a fresh config that cannot be created as a typed error, not a bare one', () => {
    // The second leg of recovery. `cli.ts` and `index.ts` both print a
    // `ConfigUnreadableError` and rethrow anything else, so a bare error here
    // would reach the person as the stack trace that wrapping exists to avoid.
    const dir = makeDir('load-fresh-condemned');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ truncated');

    // Once the original is gone, hand conf bytes it cannot parse, so even the
    // replacement is condemned.
    const real = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, options?: unknown) => {
      if (typeof file === 'string' && path.resolve(file) === configPath) {
        if (!fs.existsSync(configPath)) return '{ still broken';
      }
      return (real as (f: unknown, o?: unknown) => unknown)(file, options);
    }) as unknown as typeof fs.readFileSync);

    let thrown: unknown;
    try {
      new ConfigManager(dir, FAST_RETRIES);
    } catch (error) {
      thrown = error;
    }
    vi.restoreAllMocks();

    expect(thrown).toBeInstanceOf(ConfigUnreadableError);
    const error = thrown as ConfigUnreadableError;
    // Guarded: `toContain(undefined)` would throw rather than fail cleanly, and
    // "no backup was written" is itself a result worth naming.
    const [backup] = backupsIn(dir);
    expect(backup).toBeDefined();
    expect(error.message).toContain(backup);
    // This is the one branch that reaches the fallback advice with a backup in
    // play: the condemning error carries no errno, so no errno branch fires.
    // The rename hatch must NOT be offered here. The person's settings are in
    // the `.bak` the message names three lines above, and renaming the failed
    // replacement would keep nothing at all.
    expect(error.advice).not.toContain('rename');
    // And it names the folder it could not write to, rather than gesturing at
    // one, so the advice is as actionable as the permission branch it mirrors.
    expect(error.advice).toContain('could not create a file in this folder');
    expect(error.advice).toContain(dir);
    expect(error.advice).toContain('start DorkOS again');
  });

  it('does not claim nothing was deleted when the file has already been replaced', () => {
    // The awkward leg: the file really was damaged, so it was copied to `.bak`
    // and removed, and only THEN did the OS refuse the replacement. The
    // reassuring message would be false here, and would send the person looking
    // for a file that is sitting next to it under another name.
    const dir = makeDir('load-recovery-leg');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ truncated, so the first load condemns it');
    const before = fs.readFileSync(configPath, 'utf-8');

    // Fires only once the original is gone, which is exactly the second leg.
    failReadsOf(configPath, 'EMFILE', { when: () => !fs.existsSync(configPath) });

    let thrown: unknown;
    try {
      new ConfigManager(dir, FAST_RETRIES);
    } catch (error) {
      thrown = error;
    }
    vi.restoreAllMocks();

    expect(thrown).toBeInstanceOf(ConfigUnreadableError);
    const message = (thrown as ConfigUnreadableError).message;
    const [backup] = backupsIn(dir);
    expect(backup).toBeDefined();
    expect(message).toContain(backup);
    expect(message).not.toContain('did not replace or delete your settings');
    // And the claim it does make is true: the old settings are in the backup.
    expect(fs.readFileSync(backup!, 'utf-8')).toBe(before);
  });
});
