import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  runDelegatedLogin,
  pipeSecretToChild,
  delegateRuntimeLogin,
  type SpawnFn,
} from '../delegated-login.js';

/**
 * Minimal ChildProcess double: an EventEmitter (for `once('exit'|'error')`) plus
 * a stderr emitter, a stdin sink, and a `kill` spy. Enough for the login helpers.
 */
class FakeChild extends EventEmitter {
  stdin = { end: vi.fn() };
  stderr = new EventEmitter();
  kill = vi.fn();
}

/** A spawn double that records its args and hands back a controllable child. */
function fakeSpawn(child: FakeChild): {
  spawn: SpawnFn;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, calls };
}

describe('runDelegatedLogin', () => {
  it('resolves ok when the login CLI exits 0', async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const p = runDelegatedLogin({ binary: '/bin/codex', args: ['login'] }, { spawn });
    child.emit('exit', 0);
    await expect(p).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual({ cmd: '/bin/codex', args: ['login'] });
  });

  it('resolves an honest failure when the CLI exits non-zero', async () => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child);
    const p = runDelegatedLogin({ binary: '/bin/codex', args: ['login'] }, { spawn });
    child.stderr.emit('data', Buffer.from('authentication cancelled\nmore detail'));
    child.emit('exit', 1);
    const result = await p;
    expect(result.ok).toBe(false);
    // Condensed to the first line, no raw multi-line dump.
    expect(result.error).toContain('authentication cancelled');
    expect(result.error).not.toContain('more detail');
  });

  it('resolves an honest failure on spawn error', async () => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child);
    const p = runDelegatedLogin({ binary: '/bin/nope', args: ['login'] }, { spawn });
    child.emit('error', new Error('ENOENT'));
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('bounds a hung login by the timeout, kills the child, and degrades honestly', async () => {
      const child = new FakeChild();
      const { spawn } = fakeSpawn(child);
      const p = runDelegatedLogin(
        { binary: '/bin/codex', args: ['login'] },
        { spawn, timeoutMs: 1000 }
      );
      // Never emit 'exit' — simulate a login the user never completes.
      vi.advanceTimersByTime(1000);
      const result = await p;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out/i);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });
});

describe('pipeSecretToChild', () => {
  it('writes the secret to stdin — never to argv — and resolves ok on exit 0', async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const secret = 'sk-super-secret-value';
    const p = pipeSecretToChild(
      { binary: '/bin/codex', args: ['login', '--with-api-key'] },
      secret,
      { spawn }
    );
    child.emit('exit', 0);
    await expect(p).resolves.toEqual({ ok: true });
    // Secret reached stdin, and NEVER appeared on the command line.
    expect(child.stdin.end).toHaveBeenCalledWith(secret);
    expect(calls[0].args.join(' ')).not.toContain(secret);
  });

  it('resolves an honest failure when the apply exits non-zero', async () => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child);
    const p = pipeSecretToChild(
      { binary: '/bin/codex', args: ['login', '--with-api-key'] },
      's3cret',
      { spawn }
    );
    child.stderr.emit('data', Buffer.from('invalid api key'));
    child.emit('exit', 1);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid api key');
  });
});

describe('delegateRuntimeLogin', () => {
  it('returns an honest not-available state when the CLI cannot be resolved', async () => {
    const result = await delegateRuntimeLogin('codex', {
      resolveCommand: async () => null,
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('codex') });
  });

  it('spawns the resolved command and detects completion', async () => {
    // resolveCommand is async, so the spawn (and its listeners) attach a tick
    // later — schedule the exit from the spawn itself so it never races ahead.
    const child = new FakeChild();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    }) as unknown as SpawnFn;

    const result = await delegateRuntimeLogin('claude-code', {
      spawn,
      resolveCommand: async () => ({ binary: '/bin/claude', args: ['auth', 'login'] }),
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toEqual({ cmd: '/bin/claude', args: ['auth', 'login'] });
  });
});
