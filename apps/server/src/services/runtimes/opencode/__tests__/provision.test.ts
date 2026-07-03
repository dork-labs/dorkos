import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { RuntimeProvisionProgress } from '@dorkos/shared/transport';
import { provisionOpenCode, resolveProvisionedOpenCodePath } from '../provision.js';

// MOCK the spawned installer — never run a real npm install in CI.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));
vi.mock('../../../../lib/dork-home.js', () => ({ resolveDorkHome: () => '/dork-home-test' }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logError: vi.fn(() => ({ error: '' })),
}));

/** A fake npm child process the test drives (stdout/stderr streams + exit/error). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let child: FakeChild;
function armSpawn(): void {
  child = new FakeChild();
  vi.mocked(spawn).mockReturnValue(child as never);
}

/** Flush microtasks so the awaited mkdir resolves and listeners attach before we emit. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('provisionOpenCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armSpawn();
  });

  it('installs successfully and resolves the provisioned binary (OpenCode flips to Ready)', async () => {
    vi.mocked(existsSync).mockReturnValue(true); // the installed binary is present
    const progress: RuntimeProvisionProgress[] = [];

    const resultP = provisionOpenCode((p) => progress.push(p));
    await flush();
    child.stdout.emit('data', Buffer.from('added 1 package'));
    child.emit('exit', 0);
    const result = await resultP;

    expect(result.ok).toBe(true);
    expect(result.binaryPath).toBe(resolveProvisionedOpenCodePath());
    // Installed into a dork-home-scoped location, never os.homedir().
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(
      expect.arrayContaining(['install', '--prefix', '/dork-home-test/runtimes/opencode'])
    );
    expect(progress.map((p) => p.stage)).toContain('starting');
    expect(progress.map((p) => p.stage)).toContain('done');
    // A successful install is not cleaned up.
    expect(rm).not.toHaveBeenCalled();
  });

  it('de-dupes concurrent calls: a second install piggybacks instead of racing a second npm install', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    // Two provision calls arrive before the first settles (double-click, two tabs).
    const firstP = provisionOpenCode();
    const secondP = provisionOpenCode();
    await flush();

    // Only ONE npm install spawned; the second call piggybacked on the first, so
    // its failure cleanup (rm -rf) can never race the other's in-flight files.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    child.stdout.emit('data', Buffer.from('added 1 package'));
    child.emit('exit', 0);

    const [first, second] = await Promise.all([firstP, secondP]);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first); // both callers resolve to the one shared result
    expect(rm).not.toHaveBeenCalled();
  });

  it('cleans up and returns an honest error when the installer exits non-zero', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const resultP = provisionOpenCode();
    await flush();
    child.stderr.emit('data', Buffer.from('npm ERR! network timeout'));
    child.emit('exit', 1);
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install OpenCode');
    // The partial tree is removed so no binary is left resolvable.
    expect(rm).toHaveBeenCalledWith('/dork-home-test/runtimes/opencode', {
      recursive: true,
      force: true,
    });
  });

  it('treats an exit-0 with no resolvable binary as a failure and cleans up', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // installer "succeeded" but left nothing

    const resultP = provisionOpenCode();
    await flush();
    child.emit('exit', 0);
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install OpenCode');
    expect(rm).toHaveBeenCalled();
  });

  it('cleans up and returns an honest error when the installer fails to spawn', async () => {
    const resultP = provisionOpenCode();
    await flush();
    child.emit('error', new Error('spawn npm ENOENT'));
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install OpenCode');
    expect(rm).toHaveBeenCalled();
  });

  it('aborts before spawning when the scoped directory cannot be created', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('EACCES'));

    const result = await provisionOpenCode();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install OpenCode');
    expect(spawn).not.toHaveBeenCalled();
  });
});
