/**
 * A signed-out Claude account signed in again from the command line is noticed
 * by a change to its CLI config file, and probed (DOR-4425 step 2).
 *
 * Each of security's three conditions has its own block: the registry names the
 * file and a symlink is never followed, a burst of events asks for at most one
 * probe per floor window, and the whole watch is off under the test runtime.
 * The file watch, `lstat` and the probe are injected, so no case touches a real
 * account folder; the one real-filesystem block uses a made-up file under the
 * OS temp folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeAccount } from '../../../../core/usage/runtime-accounts.js';
import {
  accountSigninState,
  recordAccountSignin,
} from '../../../../observability/account-signin-state.js';
import {
  noteSigninProven,
  noteSigninRepaired,
  resetSigninEpisodes,
} from '../../../../observability/index.js';
import { PROBE_FLOOR_MS, type AccountProbeOutcome } from '../account-probe.js';
import {
  CLI_CONFIG_FILE_NAME,
  CREDENTIAL_CHANGE_DEBOUNCE_MS,
  startSigninCredentialWatch,
  type CliConfigFileFacts,
  type CliConfigWatchFactory,
  type SigninCredentialWatchDeps,
} from '../signin-credential-watch.js';

/** A made-up account folder. Nothing reads or writes it: every fs call is a fake. */
const ROOT = '/nonexistent-dorkos-signin-watch/work';
const FILE = path.join(ROOT, CLI_CONFIG_FILE_NAME);

/** One registered account, as the registry would return it. */
function account(overrides: Partial<RuntimeAccount> = {}): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id: 'work',
    path: ROOT,
    canonicalPath: ROOT,
    label: 'Work',
    color: '#888888',
    storedColor: null,
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: 'work',
    ...overrides,
  };
}

/** Fakes for every collaborator, plus a way to rewrite the file. */
function harness(extra: Partial<SigninCredentialWatchDeps> = {}) {
  const listeners: Array<(eventType: string) => void> = [];
  const close = vi.fn();
  const watch = vi.fn<CliConfigWatchFactory>((_file, onEvent) => {
    listeners.push(onEvent);
    return { close };
  });
  let mtimeMs = 1_000;
  let facts: CliConfigFileFacts | null = { isSymbolicLink: false, isFile: true, mtimeMs, size: 10 };
  const lstat = vi.fn((_file: string) => facts);
  const probe = vi.fn(async (_accountId: string) => ({ probe: 'failed' as AccountProbeOutcome }));
  const deps: SigninCredentialWatchDeps = {
    testRuntime: false,
    listAccounts: () => [account()],
    watch,
    lstat,
    probe,
    ...extra,
  };
  return {
    deps,
    watch,
    close,
    lstat,
    probe,
    /** Replace what `lstat` reports. */
    setFacts(next: CliConfigFileFacts | null): void {
      facts = next;
    },
    /** The CLI rewrote the file: a new change time, then one event. */
    change(eventType = 'change'): void {
      mtimeMs += 1;
      if (facts) facts = { ...facts, mtimeMs };
      listeners.at(-1)?.(eventType);
    },
    /** An event that changed nothing the watch compares. */
    touchless(): void {
      listeners.at(-1)?.('change');
    },
  };
}

let stops: Array<() => void> = [];

/** Start the watch and remember to stop it. */
function start(deps: SigninCredentialWatchDeps): () => void {
  const stop = startSigninCredentialWatch(deps);
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSigninEpisodes();
  stops = [];
});

afterEach(() => {
  for (const stop of stops) stop();
  resetSigninEpisodes();
  vi.useRealTimers();
});

describe('which accounts are watched', () => {
  it('watches the registry folder’s CLI config file when a registered account signs out', () => {
    const h = harness();
    start(h.deps);

    // Any spelling of the root finds the registered account.
    recordAccountSignin('claude-code', `${ROOT}/`, 'signed-out');

    expect(h.watch).toHaveBeenCalledOnce();
    expect(h.watch.mock.calls[0]?.[0]).toBe(FILE);
  });

  it('keeps one watch per signed-out account however many failures', () => {
    const h = harness();
    start(h.deps);

    for (let i = 0; i < 3; i += 1) recordAccountSignin('claude-code', ROOT, 'signed-out');

    expect(h.watch).toHaveBeenCalledOnce();
  });

  it('watches nothing for a healthy account, or another runtime', () => {
    const h = harness();
    start(h.deps);

    recordAccountSignin('claude-code', ROOT, 'signed-in');
    recordAccountSignin('codex', ROOT, 'signed-out');
    recordAccountSignin('claude-code', undefined, 'signed-out');

    expect(h.watch).not.toHaveBeenCalled();
  });

  it('skips an account whose CLI config file does not exist yet', () => {
    const h = harness();
    h.setFacts(null);
    start(h.deps);

    recordAccountSignin('claude-code', ROOT, 'signed-out');

    expect(h.watch).not.toHaveBeenCalled();
  });

  it('stops the watch the moment the account is signed in, by any route', () => {
    const h = harness();
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    noteSigninRepaired('claude-code', ROOT, 'login');

    expect(h.close).toHaveBeenCalledOnce();
    // A later failure watches again: the old watch is gone, not merely paused.
    recordAccountSignin('claude-code', ROOT, 'signed-out');
    expect(h.watch).toHaveBeenCalledTimes(2);
  });

  it('stops every watch on a reset', () => {
    const h = harness();
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    resetSigninEpisodes();

    expect(h.close).toHaveBeenCalledOnce();
  });

  it('stops every watch, and stops listening, at shutdown', () => {
    const h = harness();
    const stop = start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    stop();
    expect(h.close).toHaveBeenCalledOnce();

    recordAccountSignin('claude-code', ROOT, 'signed-in');
    recordAccountSignin('claude-code', ROOT, 'signed-out');
    expect(h.watch).toHaveBeenCalledOnce();
  });

  it('never throws into the turn when the watch cannot start', () => {
    const h = harness({
      watch: () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
    });
    start(h.deps);

    expect(() => recordAccountSignin('claude-code', ROOT, 'signed-out')).not.toThrow();
  });
});

describe('condition 1: the registry names the file, and a symlink is never followed', () => {
  it('starts no watch for a root the registry does not hold', () => {
    const h = harness();
    start(h.deps);

    // A path a turn or an agent could name, matching no registered account.
    recordAccountSignin('claude-code', '/nonexistent-dorkos-signin-watch/agent-made', 'signed-out');

    expect(h.watch).not.toHaveBeenCalled();
    expect(h.lstat).not.toHaveBeenCalled();
  });

  it('does not watch a CLI config file that is a symlink', () => {
    const h = harness();
    h.setFacts({ isSymbolicLink: true, isFile: false, mtimeMs: 1, size: 10 });
    start(h.deps);

    recordAccountSignin('claude-code', ROOT, 'signed-out');

    expect(h.lstat).toHaveBeenCalledWith(FILE);
    expect(h.watch).not.toHaveBeenCalled();
  });

  it('stops watching when the file is swapped for a symlink later', () => {
    const h = harness();
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    h.setFacts({ isSymbolicLink: true, isFile: false, mtimeMs: 2, size: 10 });
    h.touchless();

    expect(h.close).toHaveBeenCalledOnce();
  });

  it('reads metadata only: the module never reads the file or follows a link', async () => {
    const source = await fs.readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../signin-credential-watch.ts'),
      'utf8'
    );
    for (const pattern of [
      /readFile/,
      /createReadStream/,
      /\bopen(Sync)?\s*\(/,
      /\bstat(Sync)?\s*\(/,
      /realpath/,
    ]) {
      expect(source, String(pattern)).not.toMatch(pattern);
    }
    expect(source).toMatch(/lstatSync\(/);
  });

  describe('on a real folder under the OS temp folder', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'signin-watch-')));
    });

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('watches a regular file and refuses a symlinked one, with the real lstat', async () => {
      const real = harness({ listAccounts: () => [account({ path: dir, canonicalPath: dir })] });
      // The real `lstat`: only the watch and the probe are fakes here.
      delete real.deps.lstat;
      start(real.deps);

      await fs.writeFile(path.join(dir, 'elsewhere.json'), '{"made":"up"}');
      await fs.symlink(path.join(dir, 'elsewhere.json'), path.join(dir, CLI_CONFIG_FILE_NAME));
      recordAccountSignin('claude-code', dir, 'signed-out');
      expect(real.watch).not.toHaveBeenCalled();

      recordAccountSignin('claude-code', dir, 'signed-in');
      await fs.rm(path.join(dir, CLI_CONFIG_FILE_NAME));
      await fs.writeFile(path.join(dir, CLI_CONFIG_FILE_NAME), '{"made":"up"}');
      recordAccountSignin('claude-code', dir, 'signed-out');
      expect(real.watch).toHaveBeenCalledOnce();
    });
  });
});

describe('condition 2: at most one probe per floor window', () => {
  it('collapses 20 change events into one probe, and allows one more after the floor', async () => {
    const h = harness();
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    for (let i = 0; i < 20; i += 1) h.change();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_DEBOUNCE_MS);
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.probe).toHaveBeenCalledWith('work');

    await vi.advanceTimersByTimeAsync(PROBE_FLOOR_MS);
    expect(h.probe).toHaveBeenCalledOnce();

    h.change();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_DEBOUNCE_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it('holds a change inside the floor until the floor ends, then probes once', async () => {
    const h = harness();
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');
    h.change();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_DEBOUNCE_MS);
    expect(h.probe).toHaveBeenCalledOnce();

    // A sign-in seconds after the last probe is not lost, only held.
    for (let i = 0; i < 5; i += 1) h.change();
    await vi.advanceTimersByTimeAsync(PROBE_FLOOR_MS - 1);
    expect(h.probe).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it('asks for nothing on an event that changed neither size nor change time', async () => {
    const h = harness();
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    h.touchless();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_DEBOUNCE_MS);

    expect(h.probe).not.toHaveBeenCalled();
  });

  it('asks once more after the floor when the probe was throttled', async () => {
    const h = harness();
    h.probe.mockResolvedValueOnce({ probe: 'throttled' as const });
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    h.change();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_DEBOUNCE_MS);
    expect(h.probe).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(PROBE_FLOOR_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it('clears nothing from the event itself; only an ok probe clears, and ends the watch', async () => {
    const h = harness();
    // What the real probe does on `ok`: prove the account through its own path.
    h.probe.mockImplementationOnce(async () => {
      noteSigninProven('claude-code', ROOT, Date.now(), 'probe');
      return { probe: 'ok' as const };
    });
    start(h.deps);
    recordAccountSignin('claude-code', ROOT, 'signed-out');

    h.change();
    expect(accountSigninState('claude-code', ROOT)).toBe('signed-out');

    await vi.advanceTimersByTimeAsync(CREDENTIAL_CHANGE_DEBOUNCE_MS);
    expect(accountSigninState('claude-code', ROOT)).toBe('signed-in');
    expect(h.close).toHaveBeenCalledOnce();
  });
});

describe('condition 3: off under the test runtime', () => {
  it('watches nothing, stats nothing and probes nothing', async () => {
    const h = harness({ testRuntime: true });
    start(h.deps);

    recordAccountSignin('claude-code', ROOT, 'signed-out');
    await vi.advanceTimersByTimeAsync(PROBE_FLOOR_MS);

    expect(h.watch).not.toHaveBeenCalled();
    expect(h.lstat).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });
});
