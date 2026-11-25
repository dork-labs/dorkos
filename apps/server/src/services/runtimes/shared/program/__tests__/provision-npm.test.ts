import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createNpmProvisioner, honestInstallError } from '../provision-npm.js';

// MOCK the spawned installer — never run a real npm install in CI. Each
// runtime's own provision test covers its package, folder and environment.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));

/** A fake npm child process the test drives (stdout/stderr streams + exit/error). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let child: FakeChild;
let installed: string | null;
const provision = createNpmProvisioner({
  runtime: 'codex',
  label: 'Example',
  logTag: '[Example]',
  dir: () => '/dork-home-test/runtimes/example',
  spec: () => 'example@1.0.0',
  installedBinary: () => installed,
});

/** Flush microtasks so the awaited mkdir resolves and listeners attach before we emit. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createNpmProvisioner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    child = new FakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    installed = '/dork-home-test/runtimes/example/node_modules/.bin/example';
  });

  it('de-dupes concurrent calls: a second install piggybacks instead of racing a second npm install', async () => {
    // Two provision calls arrive before the first settles (double-click, two tabs).
    const firstP = provision();
    const secondP = provision();
    await flush();

    // Only ONE npm install spawned; the second call piggybacked on the first, so
    // its failure cleanup (rm -rf) can never race the other's in-flight files.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    child.emit('exit', 0);

    const [first, second] = await Promise.all([firstP, secondP]);
    expect(first).toEqual({ ok: true, binaryPath: installed });
    expect(second).toEqual(first);
    expect(rm).not.toHaveBeenCalled();
  });

  it('cleans up and returns an honest error when the installer exits non-zero', async () => {
    const resultP = provision();
    await flush();
    child.stderr.emit('data', Buffer.from('npm ERR! network timeout'));
    child.emit('exit', 1);
    const result = await resultP;

    expect(result).toEqual({
      ok: false,
      error:
        'Could not install Example (npm ERR! network timeout). Check your network and try again.',
    });
    // The partial tree is removed so no binary is left resolvable.
    expect(rm).toHaveBeenCalledWith('/dork-home-test/runtimes/example', {
      recursive: true,
      force: true,
    });
  });

  it('treats an exit-0 with no resolvable binary as a failure and cleans up', async () => {
    installed = null; // installer "succeeded" but left nothing usable

    const resultP = provision();
    await flush();
    child.emit('exit', 0);
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install Example');
    expect(rm).toHaveBeenCalled();
  });

  it('cleans up and returns an honest error when the installer fails to spawn', async () => {
    const resultP = provision();
    await flush();
    child.emit('error', new Error('spawn npm ENOENT'));
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install Example (spawn npm ENOENT)');
    expect(rm).toHaveBeenCalled();
  });

  it('aborts before spawning when the scoped directory cannot be created', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('EACCES'));

    const result = await provision();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install Example');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('condenses an installer failure to its first non-blank line, or none', () => {
    expect(honestInstallError('Ollama', '\n  Error: no brew\nat stack')).toBe(
      'Could not install Ollama (Error: no brew). Check your network and try again.'
    );
    expect(honestInstallError('Ollama', undefined)).toBe(
      'Could not install Ollama. Check your network and try again.'
    );
  });
});
