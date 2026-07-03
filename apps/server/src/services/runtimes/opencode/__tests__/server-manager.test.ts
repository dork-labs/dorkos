/**
 * OpenCode sidecar server-manager lifecycle tests.
 *
 * The `opencode` binary is never spawned: `node:child_process.spawn` is mocked
 * with a scriptable fake child (stdout/stderr emitters, exit/kill control) and
 * all timing (startup timeout, backoff schedule, shutdown grace window) runs
 * on fake timers. See NOTES.md for the sidecar contract these tests pin down.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import type { UserConfig } from '@dorkos/shared/config-schema';
import {
  OpenCodeServerManager,
  OPENCODE_SIDECAR_CONFIG,
  SIDECAR_TIMING,
} from '../server-manager.js';
import { resolveOpenCodeBinaryPath } from '../check-dependencies.js';
import { configManager } from '../../../core/config-manager.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(),
}));

vi.mock('../check-dependencies.js', () => ({
  resolveOpenCodeBinaryPath: vi.fn(),
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
  },
}));

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: (err: unknown) => ({ error: String(err) }),
}));

const BINARY = '/usr/local/bin/opencode';

/** Stdout/stderr stand-in: an EventEmitter with the `resume()` drain hook. */
class FakeStdio extends EventEmitter {
  resume = vi.fn();
}

/** Scriptable `ChildProcess` stand-in: emits are driven by each test. */
class FakeChild extends EventEmitter {
  stdout = new FakeStdio();
  stderr = new FakeStdio();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  // A successful spawn yields a real OS pid; a spawn that errors (ENOENT)
  // leaves it undefined. killChild() keys on it to know whether an 'exit' is
  // ever coming, so tests set it to undefined to model a failed spawn.
  pid: number | undefined = 4242;
  killed = false;
  kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    return true;
  });

  emitReady(url = 'http://127.0.0.1:4096'): void {
    this.stdout.emit('data', Buffer.from(`opencode server listening on ${url}\n`));
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

let children: FakeChild[] = [];

function mockRuntimesConfig(
  opencode: { enabled: boolean; binaryPath: string | null; port: number } = {
    enabled: true,
    binaryPath: null,
    port: 0,
  }
) {
  const runtimes: UserConfig['runtimes'] = {
    default: 'claude-code',
    opencode,
    codex: { enabled: true, binaryPath: null },
  };
  vi.mocked(configManager.get).mockReturnValue(runtimes as never);
}

/** The env object the manager passed to spawn for the n-th child. */
function spawnEnv(index = 0): Record<string, string | undefined> {
  const options = vi.mocked(spawn).mock.calls[index]?.[2] as { env: Record<string, string> };
  return options.env;
}

/** Boot the manager to the ready state and return the resolved client. */
async function bootReady(
  manager: OpenCodeServerManager,
  url?: string
): Promise<{ client: OpencodeClient; child: FakeChild }> {
  const pending = manager.getClient('/repo');
  const child = children[children.length - 1]!;
  child.emitReady(url);
  return { client: await pending, child };
}

describe('OpenCodeServerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    children = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    vi.mocked(resolveOpenCodeBinaryPath).mockReturnValue(BINARY);
    vi.mocked(createOpencodeClient).mockImplementation(
      () => ({ marker: Symbol('opencode-client') }) as unknown as OpencodeClient
    );
    mockRuntimesConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('lazy spawn + peekClient', () => {
    it('spawns nothing at construction and peekClient never boots', () => {
      const manager = new OpenCodeServerManager();

      expect(manager.peekClient()).toBeNull();
      expect(manager.peekClient()).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('boots on first getClient with localhost binding, config port, password, and ask-config', async () => {
      const manager = new OpenCodeServerManager();
      const { client } = await bootReady(manager);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe(BINARY);
      expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
        'serve',
        '--hostname=127.0.0.1',
        '--port=0',
      ]);

      const env = spawnEnv();
      // Per-boot secret: 32 random bytes, hex-encoded.
      expect(env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
      // Conservative ask-ruleset — the safety boundary (NOTES.md §2).
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
        permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
      });
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual(OPENCODE_SIDECAR_CONFIG);

      // Client is constructed against the parsed URL with basic auth.
      const password = env.OPENCODE_SERVER_PASSWORD!;
      expect(createOpencodeClient).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.1:4096',
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        },
      });
      expect(manager.peekClient()).toBe(client);
    });

    it('passes a configured fixed port straight through', async () => {
      mockRuntimesConfig({ enabled: true, binaryPath: null, port: 4242 });
      const manager = new OpenCodeServerManager();
      await bootReady(manager);

      expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--port=4242');
    });

    it('parses the actual bound URL from the ready line (port 0 -> ephemeral)', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager, 'http://127.0.0.1:54321');

      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://127.0.0.1:54321' })
      );
    });

    it('handles a ready line split across stdout chunks', async () => {
      const manager = new OpenCodeServerManager();
      const pending = manager.getClient('/repo');
      const child = children[0]!;

      child.stdout.emit('data', Buffer.from('opencode server listen'));
      child.stdout.emit('data', Buffer.from('ing on http://127.0.0.1:49152\n'));

      await pending;
      expect(createOpencodeClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://127.0.0.1:49152' })
      );
    });

    it('shares one in-flight boot across concurrent getClient calls', async () => {
      const manager = new OpenCodeServerManager();
      const first = manager.getClient('/repo-a');
      const second = manager.getClient('/repo-b');
      children[0]!.emitReady();

      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('returns the cached client without respawning once ready', async () => {
      const manager = new OpenCodeServerManager();
      const { client } = await bootReady(manager);

      await expect(manager.getClient('/other')).resolves.toBe(client);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('startup failure', () => {
    it('rejects getClient when no opencode binary resolves (never spawns)', async () => {
      vi.mocked(resolveOpenCodeBinaryPath).mockReturnValue(null);
      const manager = new OpenCodeServerManager();

      await expect(manager.getClient('/repo')).rejects.toThrow(/OpenCode CLI not found/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects getClient when the sidecar exits before the ready line, with its output', async () => {
      const manager = new OpenCodeServerManager();
      const pending = manager.getClient('/repo');
      const assertion = expect(pending).rejects.toThrow(
        /exited before ready \(code 1\).*bad config/s
      );

      const child = children[0]!;
      child.stderr.emit('data', Buffer.from('bad config\n'));
      child.emitExit(1);

      await assertion;
      expect(manager.peekClient()).toBeNull();
    });

    it('rejects getClient when spawn itself errors (e.g. ENOENT)', async () => {
      const manager = new OpenCodeServerManager();
      const pending = manager.getClient('/repo');
      const assertion = expect(pending).rejects.toThrow('spawn opencode ENOENT');

      // A failed spawn never gets a pid and never emits 'exit'; the rejection
      // must surface immediately rather than await a reap that never comes.
      children[0]!.pid = undefined;
      children[0]!.emit('error', new Error('spawn opencode ENOENT'));

      await assertion;
    });

    it('rejects getClient and kills the child when readiness times out', async () => {
      const manager = new OpenCodeServerManager();
      const pending = manager.getClient('/repo');
      const assertion = expect(pending).rejects.toThrow(/did not become ready/);

      await vi.advanceTimersByTimeAsync(SIDECAR_TIMING.startupTimeoutMs);

      // The timed-out child is still alive, so it is SIGTERM'd and the boot
      // rejection is withheld until it is actually reaped, so the phase/child
      // latches never release while it lingers (no second-spawn race).
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
      children[0]!.emitExit(null, 'SIGTERM');

      await assertion;
    });

    it('withholds a second spawn until a timed-out child is reaped (fixed-port EADDRINUSE guard)', async () => {
      // A fixed port makes a premature second spawn race the dying child for it.
      mockRuntimesConfig({ enabled: true, binaryPath: null, port: 4242 });
      const manager = new OpenCodeServerManager();
      const first = manager.getClient('/repo');
      const firstRejects = expect(first).rejects.toThrow(/did not become ready/);

      await vi.advanceTimersByTimeAsync(SIDECAR_TIMING.startupTimeoutMs);
      // Timed out: SIGTERM'd but NOT yet exited, so the child is mid-death.
      expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');

      // A getClient arriving in the death window piggybacks on the still-pending
      // boot instead of spawning a second `opencode serve` for the same port.
      const second = manager.getClient('/repo');
      const secondRejects = expect(second).rejects.toThrow(/did not become ready/);
      expect(spawn).toHaveBeenCalledTimes(1);

      // Reap the child: both callers reject, and only now may a fresh boot run.
      children[0]!.emitExit(null, 'SIGTERM');
      await Promise.all([firstRejects, secondRejects]);
      expect(spawn).toHaveBeenCalledTimes(1);

      // The next explicit getClient boots exactly one fresh sidecar.
      const { client } = await bootReady(manager);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.peekClient()).toBe(client);
    });

    it('retries fresh on the next getClient after a startup failure', async () => {
      const manager = new OpenCodeServerManager();
      const failed = manager.getClient('/repo');
      const assertion = expect(failed).rejects.toThrow();
      children[0]!.emitExit(1);
      await assertion;

      const { client } = await bootReady(manager);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.peekClient()).toBe(client);
    });
  });

  describe('crash restart with exponential backoff', () => {
    it('restarts after a crash following the capped backoff schedule, then gives up', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager);

      // Immediate re-crashes never reach the uptime threshold, so attempts
      // escalate: base * 2^n capped at restartMaxDelayMs, then exhaustion.
      const expectedDelays = [500, 1000, 2000, 4000, 8000, 8000];
      expect(SIDECAR_TIMING.restartBaseDelayMs).toBe(500);
      expect(SIDECAR_TIMING.restartMaxDelayMs).toBe(8000);
      expect(SIDECAR_TIMING.maxRestartAttempts).toBe(expectedDelays.length);

      for (const [i, delay] of expectedDelays.entries()) {
        const spawnsSoFar = i + 1;
        children[children.length - 1]!.emitExit(1);

        // Not a moment before the scheduled delay…
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(spawn).toHaveBeenCalledTimes(spawnsSoFar);
        // …and exactly at it.
        await vi.advanceTimersByTimeAsync(1);
        expect(spawn).toHaveBeenCalledTimes(spawnsSoFar + 1);

        children[children.length - 1]!.emitReady();
        await vi.advanceTimersByTimeAsync(0);
      }

      // Attempts exhausted: the next crash schedules nothing.
      children[children.length - 1]!.emitExit(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawn).toHaveBeenCalledTimes(expectedDelays.length + 1);
      expect(manager.peekClient()).toBeNull();

      // …but an explicit getClient recovers on demand with a fresh boot.
      const { client } = await bootReady(manager);
      expect(spawn).toHaveBeenCalledTimes(expectedDelays.length + 2);
      expect(manager.peekClient()).toBe(client);
    });

    it('rotates the per-boot password on restart', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager);
      children[0]!.emitExit(1);
      await vi.advanceTimersByTimeAsync(SIDECAR_TIMING.restartBaseDelayMs);
      children[1]!.emitReady();
      await vi.advanceTimersByTimeAsync(0);

      expect(spawnEnv(1).OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
      expect(spawnEnv(1).OPENCODE_SERVER_PASSWORD).not.toBe(spawnEnv(0).OPENCODE_SERVER_PASSWORD);
    });

    it('makes getClient wait for a pending backoff restart instead of spawning immediately', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager);
      children[0]!.emitExit(1);

      const pending = manager.getClient('/repo');
      expect(spawn).toHaveBeenCalledTimes(1); // no eager respawn

      await vi.advanceTimersByTimeAsync(SIDECAR_TIMING.restartBaseDelayMs);
      expect(spawn).toHaveBeenCalledTimes(2);
      children[1]!.emitReady();

      const client = await pending;
      expect(client).toBe(manager.peekClient());
    });

    it('treats a failed restart boot as another attempt on the backoff ladder', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager);
      children[0]!.emitExit(1);

      // First restart attempt (500ms) spawns a child that dies before ready.
      await vi.advanceTimersByTimeAsync(500);
      expect(spawn).toHaveBeenCalledTimes(2);
      children[1]!.emitExit(1);
      await vi.advanceTimersByTimeAsync(0);

      // Second attempt escalates to 1000ms and succeeds.
      await vi.advanceTimersByTimeAsync(999);
      expect(spawn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawn).toHaveBeenCalledTimes(3);
      children[2]!.emitReady();
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.peekClient()).not.toBeNull();
    });

    it('resets the backoff ladder after a stable uptime window', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager);

      // Escalate two steps with immediate crashes: 500ms, then 1000ms.
      children[0]!.emitExit(1);
      await vi.advanceTimersByTimeAsync(500);
      children[1]!.emitReady();
      await vi.advanceTimersByTimeAsync(0);
      children[1]!.emitExit(1);
      await vi.advanceTimersByTimeAsync(1000);
      children[2]!.emitReady();
      await vi.advanceTimersByTimeAsync(0);

      // Stay healthy past the reset threshold, then crash: back to base delay.
      await vi.advanceTimersByTimeAsync(SIDECAR_TIMING.backoffResetUptimeMs);
      children[2]!.emitExit(1);
      await vi.advanceTimersByTimeAsync(SIDECAR_TIMING.restartBaseDelayMs - 1);
      expect(spawn).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawn).toHaveBeenCalledTimes(4);
    });
  });

  describe('shutdown', () => {
    it('is a no-op when the sidecar never booted', async () => {
      const manager = new OpenCodeServerManager();
      await manager.shutdown();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('SIGTERMs the sidecar and resolves once it exits', async () => {
      const manager = new OpenCodeServerManager();
      const { child } = await bootReady(manager);

      const closing = manager.shutdown();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emitExit(0, 'SIGTERM');
      await closing;

      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
      expect(manager.peekClient()).toBeNull();
    });

    it('escalates to SIGKILL after the grace window when SIGTERM is ignored', async () => {
      const manager = new OpenCodeServerManager();
      const { child } = await bootReady(manager);

      const closing = manager.shutdown();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(SIDECAR_TIMING.shutdownGraceMs);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      child.emitExit(null, 'SIGKILL');
      await closing;
    });

    it('does not restart a sidecar that exits during shutdown', async () => {
      const manager = new OpenCodeServerManager();
      const { child } = await bootReady(manager);

      const closing = manager.shutdown();
      child.emitExit(0, 'SIGTERM');
      await closing;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending backoff restart', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager);
      children[0]!.emitExit(1); // schedules a restart in 500ms

      await manager.shutdown();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('never resurrects after shutdown when the ready line lands before the exit event', async () => {
      const manager = new OpenCodeServerManager();
      const pending = manager.getClient('/repo');
      const assertion = expect(pending).rejects.toThrow(/shut down/);
      const child = children[0]!;

      // Shutdown while readiness is pending: SIGTERM is sent but the child
      // has not exited yet…
      const closing = manager.shutdown();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      // …and its buffered ready line is delivered BEFORE the exit event.
      child.emitReady();
      await assertion;

      // The manager must stay stopped — no client, no phase resurrection.
      expect(manager.peekClient()).toBeNull();

      child.emitExit(0, 'SIGTERM');
      await closing;

      await expect(manager.getClient('/repo')).rejects.toThrow(/shut down/);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('rejects getClient after shutdown', async () => {
      const manager = new OpenCodeServerManager();
      await manager.shutdown();

      await expect(manager.getClient('/repo')).rejects.toThrow(/shut down/);
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
