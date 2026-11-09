import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimDataDirectory } from '../data-directory.js';
import { createServerRefs } from '../../server-refs.js';
import { PERSON_ONLY_DATA_PATHS } from '../../../services/runtimes/shared/policy/protected-paths.js';
import { collapseProtectedPaths } from '../../../services/runtimes/codex/policy/collapse-protected-paths.js';
import { refuseMissingWritableTargets } from '../../../services/runtimes/codex/policy/writable-missing-targets.js';

vi.mock('../../../lib/logger.js', () => ({
  initLogger: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../lib/instance-lock.js', () => ({
  acquireInstanceLock: vi.fn(() => ({ acquired: true, release: vi.fn() })),
  isInstanceLockEnabled: () => false,
}));
vi.mock('../../../services/runtimes/claude-code/sessions/warm-process-ledger.js', () => ({
  PREDECESSOR_EXIT_WAIT_MS: 0,
  reapOrphanedWarmProcesses: vi.fn(async () => {}),
}));
vi.mock('../../../services/runtimes/claude-code/messaging/background-work-ledger.js', () => ({
  sharedBackgroundWorkLedger: () => ({ readLeftover: () => [] }),
}));
vi.mock('../../../services/core/cloud/community-move-upload.js', () => ({
  initMoveStaging: vi.fn(async () => {}),
}));

let home: string;
let target: string;
beforeEach(async () => {
  home = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'shell-guard-startup-')));
  vi.stubEnv('DORK_HOME', home);
  target = path.join(home, 'cache', 'shell-guard');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

const boot = () =>
  claimDataDirectory(
    {
      ...createServerRefs(),
      stopDocDelivery: undefined,
      testComposioFixture: undefined,
      docNotificationCleanup: undefined,
    },
    { PORT: 0 }
  );

// Exercise the literal protected target and Linux launch gate together, without
// unrelated first-install files hiding this regression behind another refusal.
function checkLinuxFull() {
  const entry = PERSON_ONLY_DATA_PATHS.find((entry) => entry.path === 'cache/shell-guard');
  expect(entry).toMatchObject({ kind: 'folder', deny: 'write' });
  const missing: string[] = [];
  const protectedPaths = collapseProtectedPaths(
    { [path.join(home, entry!.path)]: 'read' },
    [home],
    (file) => missing.push(file)
  );
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  refuseMissingWritableTargets({ permissionMode: 'bypassPermissions' }, missing);
  return protectedPaths;
}

describe('shell-check folder at startup', () => {
  it('creates a private protected folder on a fresh home and allows the Linux Full check', async () => {
    await expect(fs.lstat(path.join(home, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => checkLinuxFull()).toThrow('protected files are missing');
    vi.restoreAllMocks();
    await boot();
    const stat = await fs.lstat(target);
    expect(stat.isDirectory()).toBe(true);
    if (process.getuid) expect(stat.uid).toBe(process.getuid());
    if (process.platform !== 'win32') expect(stat.mode & 0o7777).toBe(0o700);
    expect(checkLinuxFull()[target]).toBe('read');
    await boot();
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it('tightens an existing server-owned folder to 0700', async () => {
    await fs.mkdir(target, { recursive: true });
    await fs.chmod(target, 0o755);
    await boot();
    if (process.platform !== 'win32') expect((await fs.lstat(target)).mode & 0o7777).toBe(0o700);
  });

  it('aborts startup on mkdir failure and keeps Linux Full refused', async () => {
    vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' })
    );
    await expect(boot()).rejects.toThrow(`Could not secure shell-check folder: ${target}`);
    expect(() => checkLinuxFull()).toThrow('protected files are missing');
  });

  it('refuses a pre-planted symlink without changing its destination', async () => {
    const outside = path.join(home, 'outside');
    await fs.mkdir(outside, { mode: 0o755 });
    await fs.mkdir(path.dirname(target));
    await fs.symlink(outside, target, 'dir');
    await expect(boot()).rejects.toThrow('Could not secure shell-check folder');
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(!process.getuid)('refuses a foreign-owned folder', async () => {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args);
      Object.defineProperty(stat, 'uid', { value: process.getuid!() + 1 });
      return stat;
    });
    await expect(boot()).rejects.toThrow('Could not secure shell-check folder');
  });
});
