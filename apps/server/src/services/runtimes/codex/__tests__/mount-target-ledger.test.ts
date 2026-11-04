import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mountTargetLedgerFile,
  readMountTargets,
  recordMountTargets,
} from '../policy/mount-target-ledger.js';
import {
  reconcileMountTargets,
  type MountReconcileGuard,
} from '../policy/reconcile-mount-targets.js';
import {
  assertNoLiveCodex,
  codexMountRegistry,
  withCodexRegistryLock,
} from '../policy/mount-target-guard.js';
import { codexProtectedConfig } from '../policy/protected-profile.js';

let root: string;
let data: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mount-ledger-')));
  data = path.join(root, 'data');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const pool = { list: () => [], closeIdleForReconcile: async () => {} };
const guard: MountReconcileGuard = {
  lock: async (action) => action('/synthetic-registry'),
  assertGone: () => {},
};

it('captures only missing literal targets from the actual renderer, never existing paths or globs', () => {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'host.key'), 'synthetic');
  const captured: string[] = [];
  codexProtectedConfig(
    home,
    {
      roots: { cwd: home, home, data, accounts: [], agentHomes: [], agentFolders: [home] },
      writable: [],
    },
    {},
    (targets) => {
      captured.push(...targets);
      recordMountTargets(data, targets);
    }
  );
  expect(captured).toContain(path.join(home, '.claude'));
  expect(captured).not.toContain(path.join(data, 'host.key'));
  expect(captured.every((file) => !file.includes('*'))).toBe(true);
  expect(readMountTargets(data)).toEqual([...new Set(captured)].sort());
  expect(fs.statSync(mountTargetLedgerFile(data)).mode & 0o777).toBe(0o600);
});

it('preserves the previous private ledger if atomic replacement fails', () => {
  const first = path.join(root, 'first');
  recordMountTargets(data, [first]);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('synthetic power loss');
  });
  expect(() => recordMountTargets(data, [path.join(root, 'second')])).toThrow('power loss');
  expect(readMountTargets(data)).toEqual([first]);
  expect(fs.readdirSync(path.dirname(mountTargetLedgerFile(data)))).toEqual([
    'codex-mount-targets.json',
  ]);
});

it('removes a listed empty owned file, preserving every unlisted, nonempty, linked or directory target', async () => {
  const files = ['empty', 'personal', 'link', 'directory', 'unlisted', 'hardlink'].map((name) =>
    path.join(root, name)
  );
  const [empty, personal, link, directory, unlisted, hardlink] = files as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  recordMountTargets(data, [empty, personal, link, directory, hardlink]);
  fs.writeFileSync(empty, '');
  fs.writeFileSync(personal, 'keep this');
  fs.writeFileSync(unlisted, '');
  fs.symlinkSync(unlisted, link);
  fs.mkdirSync(directory);
  fs.linkSync(unlisted, hardlink);
  expect(await reconcileMountTargets(data, pool, guard)).toEqual([empty]);
  expect(fs.readFileSync(personal, 'utf8')).toBe('keep this');
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.statSync(directory).isDirectory()).toBe(true);
  expect(fs.existsSync(unlisted)).toBe(true);
  expect(fs.existsSync(hardlink)).toBe(true);
});

it('refuses removal while an observed child remains, even when the OS guard would pass', async () => {
  const file = path.join(root, 'empty');
  recordMountTargets(data, [file]);
  fs.writeFileSync(file, '');
  const busy = { ...pool, list: () => [{}] };
  const assertGone = vi.fn();
  await expect(
    reconcileMountTargets(data, busy as unknown as typeof pool, { ...guard, assertGone })
  ).rejects.toThrow('running processes');
  expect(assertGone).not.toHaveBeenCalled();
  expect(fs.existsSync(file)).toBe(true);
});

it('fails closed on the marker/process guard and does not remove a listed file', async () => {
  const file = path.join(root, 'empty');
  recordMountTargets(data, [file]);
  fs.writeFileSync(file, '');
  await expect(
    reconcileMountTargets(data, pool, {
      ...guard,
      assertGone: () => {
        throw new Error('marker still live');
      },
    })
  ).rejects.toThrow('marker still live');
  expect(fs.existsSync(file)).toBe(true);
});

it('rechecks size under the lock and leaves a person’s intervening content intact', async () => {
  const file = path.join(root, 'empty');
  recordMountTargets(data, [file]);
  fs.writeFileSync(file, '');
  expect(
    await reconcileMountTargets(data, pool, {
      ...guard,
      assertGone: () => fs.writeFileSync(file, 'person wrote this'),
    })
  ).toEqual([]);
  expect(fs.readFileSync(file, 'utf8')).toBe('person wrote this');
});

it('does not forget absent targets that a live helper could still create', async () => {
  const file = path.join(root, 'not-created-yet');
  recordMountTargets(data, [file]);
  expect(await reconcileMountTargets(data, pool, guard)).toEqual([]);
  expect(readMountTargets(data)).toEqual([file]);
});

it('refuses a linked ledger or linked private directory', () => {
  recordMountTargets(data, [path.join(root, 'empty')]);
  const file = mountTargetLedgerFile(data);
  fs.renameSync(file, file + '.original');
  fs.symlinkSync(file + '.original', file);
  expect(() => readMountTargets(data)).toThrow();
  fs.unlinkSync(file);
  fs.renameSync(path.dirname(file), path.dirname(file) + '-original');
  fs.symlinkSync(path.dirname(file) + '-original', path.dirname(file));
  expect(() => readMountTargets(data)).toThrow();
});

it('a live marker PID prevents cleanup even with an otherwise empty synthetic process tree', () => {
  const registry = path.join(root, 'registry');
  const folder = path.join(registry, '0123456789abcdef');
  const proc = path.join(root, 'proc');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(proc);
  fs.writeFileSync(path.join(folder, String(process.pid)), 'synthetic');
  expect(() => assertNoLiveCodex(registry, proc)).toThrow('running processes');
});

it('a Codex executable without markers prevents cleanup', () => {
  const registry = path.join(root, 'registry');
  fs.mkdirSync(registry);
  const proc = path.join(root, 'proc');
  const pid = path.join(proc, String(process.pid));
  fs.mkdirSync(pid, { recursive: true });
  fs.symlinkSync('/synthetic/bin/codex', path.join(pid, 'exe'));
  expect(() => assertNoLiveCodex(registry, proc)).toThrow('running processes');
});

it('refuses a foreign-owned empty target even when every process guard passes', async () => {
  const file = path.join(root, 'foreign');
  recordMountTargets(data, [file]);
  fs.writeFileSync(file, '');
  const lstat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: fs.PathLike, options?: unknown) => {
    const stat = lstat(name, options as never);
    if (String(name) === file)
      Object.defineProperty(stat, 'uid', { value: (process.getuid?.() ?? 0) + 1 });
    return stat;
  }) as typeof fs.lstatSync);
  expect(await reconcileMountTargets(data, pool, guard)).toEqual([]);
  expect(fs.existsSync(file)).toBe(true);
});

it.skipIf(process.platform !== 'linux')(
  'holds Codex’s actual flock throughout the synchronous critical section',
  async () => {
    const result = await withCodexRegistryLock(() => {
      const other = spawnSync('/usr/bin/flock', [
        '--nonblock',
        path.join(codexMountRegistry(), 'lock'),
        '/usr/bin/true',
      ]);
      expect(other.status).toBe(1);
      return 'locked';
    });
    expect(result).toBe('locked');
  }
);

it('heals a listed parent file when an older record names its now-unreachable child', async () => {
  const parent = path.join(root, '.claude');
  recordMountTargets(data, [parent, path.join(parent, 'backups')]);
  fs.writeFileSync(parent, '');
  expect(await reconcileMountTargets(data, pool, guard)).toEqual([parent]);
  expect(fs.existsSync(parent)).toBe(false);
  expect(readMountTargets(data)).toEqual([]);
});
