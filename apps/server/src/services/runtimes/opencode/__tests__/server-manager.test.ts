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
import { resolveOpenCodeBinaryPath } from '../providers/check-dependencies.js';
import { configManager } from '../../../core/config-manager.js';
import { resolveOpenCodeProviderEnv } from '../../../core/credential-env.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(),
}));

vi.mock('../providers/check-dependencies.js', () => ({
  resolveOpenCodeBinaryPath: vi.fn(),
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
  },
}));

vi.mock('../../../core/credential-env.js', () => ({
  resolveOpenCodeProviderEnv: vi.fn(),
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

/**
 * Flush the microtask that lets `boot()`'s `await resolveOpenCodeBinaryPath()`
 * resolve so `spawn` runs and the fake child is registered. Binary resolution is
 * async (T0), so spawn no longer happens synchronously within `getClient()`.
 */
async function flushBoot(): Promise<void> {
  // A boot awaits the binary, then its plan, then the provider env: one
  // microtask each, and a few more for the async planners behind them.
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
}

function mockRuntimesConfig(
  opencode: UserConfig['runtimes']['opencode'] = {
    enabled: true,
    binaryPath: null,
    port: 0,
    provider: null,
    baseURL: null,
  }
) {
  const runtimes: UserConfig['runtimes'] = {
    default: 'claude-code',
    opencode,
    codex: { enabled: true, binaryPath: null, credentialRef: null },
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
  await flushBoot();
  const child = children[children.length - 1]!;
  child.emitReady(url);
  return { client: await pending, child };
}

describe('OpenCodeServerManager', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_API_KEY', 'synthetic-server-token');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-nango-key');
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.clearAllMocks();
    vi.useFakeTimers();
    children = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    vi.mocked(resolveOpenCodeBinaryPath).mockResolvedValue(BINARY);
    vi.mocked(createOpencodeClient).mockImplementation(
      () => ({ marker: Symbol('opencode-client') }) as unknown as OpencodeClient
    );
    vi.mocked(resolveOpenCodeProviderEnv).mockResolvedValue({});
    mockRuntimesConfig();
  });

  afterEach(() => {
    try {
      for (let index = 0; index < vi.mocked(spawn).mock.calls.length; index++) {
        expect(spawnEnv(index)).not.toHaveProperty('MCP_API_KEY');
        expect(spawnEnv(index)).not.toHaveProperty('NANGO_ENCRYPTION_KEY');
        expect(spawnEnv(index).DO_NOT_TRACK).toBe('1');
      }
    } finally {
      vi.unstubAllEnvs();
    }
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

    it('carries the resolved provider credential in the sidecar spawn env (ADR-0315)', async () => {
      // The credential seam resolves a stored reference into real provider env
      // vars; the sidecar must spawn with them alongside its control vars.
      vi.mocked(resolveOpenCodeProviderEnv).mockResolvedValue({
        OPENROUTER_API_KEY: 'sk-or-resolved',
        OPENAI_BASE_URL: 'https://proxy.example/v1',
      });
      const manager = new OpenCodeServerManager();
      await bootReady(manager);

      const env = spawnEnv();
      expect(env.OPENROUTER_API_KEY).toBe('sk-or-resolved');
      expect(env.OPENAI_BASE_URL).toBe('https://proxy.example/v1');
      // Provider env must never clobber the sidecar's own control vars.
      expect(env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual(OPENCODE_SIDECAR_CONFIG);
    });

    it('spawns with no extra provider env when no provider credential resolves', async () => {
      const manager = new OpenCodeServerManager();
      await bootReady(manager);

      const env = spawnEnv();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    });

    it('passes a configured fixed port straight through', async () => {
      mockRuntimesConfig({
        enabled: true,
        binaryPath: null,
        port: 4242,
        provider: null,
        baseURL: null,
      });
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
      await flushBoot();
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
      await flushBoot();
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

    it('does not resurrect a stopped manager when the async binary resolve loses the shutdown race', async () => {
      // resolveOpenCodeBinaryPath() is async, so shutdown() can interleave with
      // it. If it then resolves to null, boot()'s null-binary path must NOT reset
      // phase to 'idle' over a 'stopped' set by shutdown() — otherwise a later
      // getClient() would spawn a sidecar after shutdown.
      let resolveBinary!: (v: string | null) => void;
      vi.mocked(resolveOpenCodeBinaryPath).mockReturnValue(
        new Promise<string | null>((r) => {
          resolveBinary = r;
        })
      );
      const manager = new OpenCodeServerManager();

      const pending = manager.getClient('/repo');
      const rejects = expect(pending).rejects.toThrow();

      // shutdown() runs while boot() is awaiting the binary resolve…
      await manager.shutdown();
      // …then the resolve loses the race and returns null (the not-found path).
      resolveBinary(null);
      await rejects;

      // The manager stayed stopped: a later getClient rejects as shut-down and
      // never spawns a sidecar.
      await expect(manager.getClient('/repo')).rejects.toThrow(/shut down/);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects getClient when the sidecar exits before the ready line, with its output', async () => {
      const manager = new OpenCodeServerManager();
      const pending = manager.getClient('/repo');
      const assertion = expect(pending).rejects.toThrow(
        /exited before ready \(code 1\).*bad config/s
      );

      await flushBoot();
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
      await flushBoot();
      children[0]!.pid = undefined;
      children[0]!.emit('error', new Error('spawn opencode ENOENT'));

      await assertion;
    });

    it('rejects getClient and kills the child when readiness times out', async () => {
      const manager = new OpenCodeServerManager();
      const pending = manager.getClient('/repo');
      const assertion = expect(pending).rejects.toThrow(/did not become ready/);

      await flushBoot();
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
      mockRuntimesConfig({
        enabled: true,
        binaryPath: null,
        port: 4242,
        provider: null,
        baseURL: null,
      });
      const manager = new OpenCodeServerManager();
      const first = manager.getClient('/repo');
      const firstRejects = expect(first).rejects.toThrow(/did not become ready/);

      await flushBoot();
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
      await flushBoot();
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
      await flushBoot();
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

  describe('recycle (first-ever-credential reboot)', () => {
    it('is a no-op when the sidecar never booted', async () => {
      const manager = new OpenCodeServerManager();
      await manager.recycle();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('SIGTERMs the running sidecar, drops the client synchronously, and reboots fresh on next use', async () => {
      const manager = new OpenCodeServerManager();
      const { child } = await bootReady(manager);
      expect(manager.peekClient()).not.toBeNull();

      const recycling = manager.recycle();
      // State flips before the kill is awaited: a getClient racing the teardown
      // must never receive the stale client.
      expect(manager.peekClient()).toBeNull();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emitExit(0, 'SIGTERM');
      await recycling;

      // Next use boots a brand-new sidecar (with whatever env now resolves).
      const { client } = await bootReady(manager);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.peekClient()).toBe(client);
    });

    it('does not schedule a crash-restart for the recycled child', async () => {
      const manager = new OpenCodeServerManager();
      const { child } = await bootReady(manager);

      const recycling = manager.recycle();
      child.emitExit(0, 'SIGTERM');
      await recycling;

      // The detached exit must not enter the backoff ladder — no eager respawn.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('stays a no-op (and stopped) after shutdown', async () => {
      const manager = new OpenCodeServerManager();
      await manager.shutdown();
      await manager.recycle();
      await expect(manager.getClient('/repo')).rejects.toThrow(/shut down/);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('DorkOS credits (ADR 261002-221210)', () => {
    const MODEL = {
      id: 'md_1',
      displayName: 'Model one',
      contextWindow: 1000,
      maxOutputTokens: 100,
      supports: { tools: true, promptCaching: false, streaming: true, thinking: false },
    };
    const creditsPlan = (models = [MODEL]) => ({
      mode: 'credits' as const,
      fingerprint: `credits:${models.map((m) => m.id).join(',')}`,
      models,
    });
    const OWN = { mode: 'own' as const, fingerprint: 'own', models: [] };

    /** A relay stand-in that records the keys it issued and revoked. */
    function fakeRelay() {
      let next = 0;
      const live = new Set<string>();
      return {
        live,
        issue: vi.fn(() => {
          next += 1;
          const key = `relay-key-${next}`;
          live.add(key);
          return { baseUrl: 'http://127.0.0.1:9/relay/openai-chat-completions', key };
        }),
        revoke: vi.fn((key: string) => live.delete(key)),
      };
    }

    /** Make every fake child exit as soon as it is told to stop, so a recycle settles. */
    function exitOnKill(child: FakeChild): void {
      child.kill.mockImplementation((signal) => {
        queueMicrotask(() => child.emitExit(0, (signal as NodeJS.Signals) ?? 'SIGTERM'));
        return true;
      });
    }

    /** A manager on credits with a fake relay installed. */
    function creditsManager(
      over: {
        planSidecar?: () => Promise<unknown>;
        planTurn?: () => Promise<unknown>;
        runsOnCredits?: () => boolean;
      } = {}
    ) {
      const relay = fakeRelay();
      const manager = new OpenCodeServerManager({
        runsOnCredits: over.runsOnCredits ?? (() => true),
      });
      manager.usePlanners({
        planSidecar: (over.planSidecar ?? (async () => creditsPlan())) as never,
        planTurn: (over.planTurn ?? (async () => creditsPlan())) as never,
        relay,
      });
      return { manager, relay };
    }

    it('boots a credits sidecar pointed at the relay, with no credits token and none of the person’s keys', async () => {
      vi.mocked(resolveOpenCodeProviderEnv).mockResolvedValue({
        OPENROUTER_API_KEY: 'sk-or-person',
      });
      vi.stubEnv('OPENAI_API_KEY', 'person-openai-key');
      const { manager, relay } = creditsManager();
      await bootReady(manager);
      const env = spawnEnv();
      expect(resolveOpenCodeProviderEnv).not.toHaveBeenCalled();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(Object.keys(env).filter((name) => name.startsWith('DORKOS_CREDITS_TOKEN'))).toEqual(
        []
      );
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
      expect(config.permission).toEqual(OPENCODE_SIDECAR_CONFIG.permission);
      expect(config.enabled_providers).toEqual(['dorkos-credits']);
      expect(config.provider['dorkos-credits'].options).toEqual({
        baseURL: 'http://127.0.0.1:9/relay/openai-chat-completions',
        apiKey: 'relay-key-1',
        includeUsage: true,
      });
      expect(relay.live).toEqual(new Set(['relay-key-1']));
    });

    it('fails closed with no relay or planners installed: a person on credits gets a sidecar that pays for nothing', async () => {
      vi.mocked(resolveOpenCodeProviderEnv).mockResolvedValue({ OPENROUTER_API_KEY: 'sk-or' });
      const manager = new OpenCodeServerManager({ runsOnCredits: () => true });
      await bootReady(manager);
      const env = spawnEnv();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
      expect(config).toEqual({ ...OPENCODE_SIDECAR_CONFIG, enabled_providers: ['dorkos-credits'] });
      await expect(manager.prepareTurn(false)).rejects.toMatchObject({
        code: 'credits_unavailable',
      });
    });

    it('refuses a credits turn with the credits card when no relay is running', async () => {
      const manager = new OpenCodeServerManager({ runsOnCredits: () => true });
      manager.usePlanners({
        planSidecar: async () => creditsPlan(),
        planTurn: async () => creditsPlan(),
      });
      await expect(manager.prepareTurn(false)).rejects.toMatchObject({
        code: 'credits_unavailable',
        reason: 'unreachable',
      });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('revokes a boot’s relay key when that sidecar stops, and issues a fresh one to the next', async () => {
      const { manager, relay } = creditsManager();
      const { child } = await bootReady(manager);
      exitOnKill(child);
      await manager.recycle();
      expect(relay.revoke).toHaveBeenCalledWith('relay-key-1');
      await bootReady(manager);
      expect(relay.live).toEqual(new Set(['relay-key-2']));
    });

    it('never hands out a sidecar on the other side of the person’s choice', async () => {
      const choice = { credits: false };
      const { manager } = creditsManager({
        planSidecar: async () => (choice.credits ? creditsPlan() : OWN),
        planTurn: async () => (choice.credits ? creditsPlan() : OWN),
        runsOnCredits: () => choice.credits,
      });
      const { child } = await bootReady(manager);
      exitOnKill(child);
      choice.credits = true;
      const pending = manager.getClient('/repo');
      await vi.waitFor(() => expect(children.length).toBe(2));
      children[1]!.emitReady();
      await pending;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(JSON.parse(spawnEnv(1).OPENCODE_CONFIG_CONTENT!).enabled_providers).toEqual([
        'dorkos-credits',
      ]);
    });

    it('boots a turn on the plan it asked for, and refuses with nothing spawned when credits cannot pay', async () => {
      const refusing = new OpenCodeServerManager({
        planTurn: async () => {
          throw Object.assign(new Error('no'), { code: 'credits_unavailable' });
        },
      });
      await expect(refusing.prepareTurn(false)).rejects.toMatchObject({
        code: 'credits_unavailable',
      });
      expect(spawn).not.toHaveBeenCalled();

      const { manager } = creditsManager({ planSidecar: async () => OWN });
      await manager.prepareTurn(false);
      await bootReady(manager);
      expect(
        JSON.parse(spawnEnv().OPENCODE_CONFIG_CONTENT!).provider['dorkos-credits']
      ).toBeDefined();
    });

    it('never restarts for a new token, and keeps a busy sidecar when only the model list moved', async () => {
      let models = [MODEL];
      const { manager } = creditsManager({
        planSidecar: async () => creditsPlan(models),
        planTurn: async () => creditsPlan(models),
      });
      const { child } = await bootReady(manager);
      exitOnKill(child);
      // Same plan (a new token changes nothing the sidecar holds): kept.
      await manager.prepareTurn(false);
      expect(child.kill).not.toHaveBeenCalled();
      // A new model list while another turn runs: kept, not restarted under it.
      models = [MODEL, { ...MODEL, id: 'md_2' }];
      expect((await manager.prepareTurn(true)).fingerprint).toBe('credits:md_1');
      expect(child.kill).not.toHaveBeenCalled();
      // Idle: recycled onto the new list.
      expect((await manager.prepareTurn(false)).fingerprint).toBe('credits:md_1,md_2');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('recycles at once across sides when nothing else is running', async () => {
      const choice = { credits: true };
      const { manager } = creditsManager({
        planSidecar: async () => (choice.credits ? creditsPlan() : OWN),
        planTurn: async () => (choice.credits ? creditsPlan() : OWN),
        runsOnCredits: () => choice.credits,
      });
      const { child } = await bootReady(manager);
      exitOnKill(child);
      choice.credits = false;
      expect((await manager.prepareTurn(false)).mode).toBe('own');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('never ends or re-bills a running turn: a switch across sides waits for it, and says so', async () => {
      const choice = { credits: false };
      let running = 1;
      const { manager } = creditsManager({
        planSidecar: async () => (choice.credits ? creditsPlan() : OWN),
        planTurn: async () => (choice.credits ? creditsPlan() : OWN),
        runsOnCredits: () => choice.credits,
      });
      manager.setBusyProbe(() => running > 0);
      const { child, client } = await bootReady(manager);
      exitOnKill(child);
      choice.credits = true;

      await manager.syncToChoice();
      expect(await manager.getClient('/repo')).toBe(client);
      await expect(manager.prepareTurn(true)).rejects.toMatchObject({
        code: 'runtime_switch_pending',
        message: expect.stringContaining(
          "still finishing a reply on your own sign-in, so it can't move to DorkOS credits yet"
        ),
      });
      expect(child.kill).not.toHaveBeenCalled();

      running = 0;
      await manager.turnSettled();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await bootReady(manager);
      expect(JSON.parse(spawnEnv(1).OPENCODE_CONFIG_CONTENT!).enabled_providers).toEqual([
        'dorkos-credits',
      ]);
    });

    it('drops a credits sidecar on unlink or a new link, and follows a changed choice', async () => {
      const choice = { credits: true };
      const { manager } = creditsManager({
        planSidecar: async () => (choice.credits ? creditsPlan() : OWN),
        runsOnCredits: () => choice.credits,
      });
      const first = await bootReady(manager);
      exitOnKill(first.child);
      await manager.recycleIfOnCredits();
      expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.peekClient()).toBeNull();

      const second = await bootReady(manager);
      exitOnKill(second.child);
      await manager.syncToChoice();
      expect(second.child.kill).not.toHaveBeenCalled();
      choice.credits = false;
      await manager.syncToChoice();
      expect(second.child.kill).toHaveBeenCalledWith('SIGTERM');

      const third = await bootReady(manager);
      await manager.recycleIfOnCredits();
      expect(third.child.kill).not.toHaveBeenCalled();
    });
  });
});
