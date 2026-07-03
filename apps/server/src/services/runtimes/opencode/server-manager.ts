/**
 * OpenCode sidecar server-manager — owns the lifecycle of the single managed
 * `opencode serve` process (ADR-0308): lazy spawn on first use, stdout-line
 * readiness, per-boot basic-auth secret, conservative permission ruleset,
 * exponential-backoff restart on crash, and SIGTERM→SIGKILL teardown on
 * DorkOS shutdown.
 *
 * ONE sidecar serves every working directory: the OpenCode server routes each
 * request by its `directory` query/header and lazily boots an internal
 * instance per directory (NOTES.md §1), so no per-cwd process pool exists
 * here. The `cwd` argument on {@link OpenCodeServerManager.getClient} is
 * accepted (and ignored) so a future pool could key on it without changing
 * callers.
 *
 * The sidecar is spawned directly rather than via the SDK's
 * `createOpencodeServer` helper because the helper cannot inject env vars —
 * and `OPENCODE_SERVER_PASSWORD` (auth) plus `OPENCODE_CONFIG_CONTENT` (the
 * ask-ruleset safety boundary) are non-negotiable (NOTES.md §2–3).
 *
 * @module services/runtimes/opencode/server-manager
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { configManager } from '../../core/config-manager.js';
import { resolveOpenCodeProviderEnv } from '../../core/credential-env.js';
import { logger, logError } from '../../../lib/logger.js';
import { resolveOpenCodeBinaryPath } from './check-dependencies.js';
import type { OpenCodeClientProvider } from './session-mapper.js';

/** Loopback-only binding — the sidecar is never reachable off-machine (spec §Security). */
const SIDECAR_HOSTNAME = '127.0.0.1';

/** Basic-auth username enforced by `opencode serve` (`OPENCODE_SERVER_USERNAME` default). */
const SIDECAR_USERNAME = 'opencode';

/** `serve` prints this once listening; the URL carries the ACTUAL bound port. */
const READY_LINE_PATTERN = /opencode server listening on\s+(https?:\/\/\S+)/;

/**
 * Conservative sidecar permission ruleset injected via `OPENCODE_CONFIG_CONTENT`.
 * OpenCode's defaults are PERMISSIVE (most keys `allow`), so this ask-config is
 * the safety boundary: every edit/bash/webfetch raises a `permission.updated`
 * event that the adapter resolves per the session's DorkOS permission mode
 * (NOTES.md §2, task 3.6). Reads stay `allow`, mirroring Claude `default`
 * semantics — reads free, mutations gated.
 */
export const OPENCODE_SIDECAR_CONFIG = {
  permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
} as const;

/** @internal Exported for tests — lifecycle timing and backoff constants. */
export const SIDECAR_TIMING = {
  /** How long a booting sidecar may take to print its ready line. */
  startupTimeoutMs: 15_000,
  /** Grace window between SIGTERM and SIGKILL at shutdown. */
  shutdownGraceMs: 3_000,
  /** First crash-restart delay; doubles per consecutive attempt. */
  restartBaseDelayMs: 500,
  /** Ceiling on the exponential restart delay. */
  restartMaxDelayMs: 8_000,
  /** Consecutive restart attempts before giving up until the next explicit use. */
  maxRestartAttempts: 6,
  /** Uptime after which a crash is considered fresh (resets the backoff ladder). */
  backoffResetUptimeMs: 30_000,
} as const;

type SidecarPhase = 'idle' | 'starting' | 'ready' | 'stopped';

/**
 * Manages the single `opencode serve` sidecar and hands out a ready SDK
 * client. Implements {@link OpenCodeClientProvider}: `getClient()` lazily
 * boots (cold start never blocks callers that use `peekClient()`), and a
 * crashed sidecar restarts on an exponential-backoff ladder capped at
 * {@link SIDECAR_TIMING.maxRestartAttempts} consecutive attempts.
 */
export class OpenCodeServerManager implements OpenCodeClientProvider {
  private phase: SidecarPhase = 'idle';
  private child: ChildProcess | null = null;
  private client: OpencodeClient | null = null;
  private starting: Promise<OpencodeClient> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private readyAt = 0;

  /**
   * Client for the managed sidecar, booting it first when necessary.
   * Concurrent callers share one in-flight boot; during a crash-restart
   * backoff window callers wait for the scheduled restart rather than
   * spawning eagerly. Boot failures reject this promise — they never crash
   * the server.
   *
   * @param _cwd - Working directory of the requesting session. Unused today
   *   (one sidecar routes per-request by directory — NOTES.md §1); kept so a
   *   future per-cwd pool can key on it without changing callers.
   */
  async getClient(_cwd: string): Promise<OpencodeClient> {
    if (this.phase === 'stopped') {
      throw new Error('OpenCode sidecar manager has been shut down');
    }
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    return this.trackBoot(this.boot());
  }

  /** The running sidecar's client, or `null` when no sidecar is up. Never boots. */
  peekClient(): OpencodeClient | null {
    return this.client;
  }

  /**
   * Tear the sidecar down for good: cancel any pending restart, SIGTERM the
   * child, and escalate to SIGKILL after {@link SIDECAR_TIMING.shutdownGraceMs}
   * so DorkOS shutdown never leaves an orphan. Safe no-op when the sidecar
   * never booted; the manager rejects all further `getClient()` calls.
   */
  async shutdown(): Promise<void> {
    if (this.phase === 'stopped') return;
    this.phase = 'stopped';
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.client = null;
    this.starting = null;
    const child = this.child;
    this.child = null;
    if (child) {
      await this.killChild(child);
      logger.info('[OpenCode] sidecar stopped');
    }
  }

  /** Whether `shutdown()` has run. A method (not an inline compare) so async code paths can re-check after `await` without CFA narrowing lying to them. */
  private isStopped(): boolean {
    return this.phase === 'stopped';
  }

  /**
   * Record a boot as the shared in-flight attempt and clear it once settled,
   * so concurrent `getClient()` calls piggyback on one spawn and a failed
   * attempt never blocks the next one.
   */
  private trackBoot(boot: Promise<OpencodeClient>): Promise<OpencodeClient> {
    this.starting = boot;
    const clear = () => {
      if (this.starting === boot) this.starting = null;
    };
    boot.then(clear, clear);
    return boot;
  }

  /**
   * Spawn `opencode serve` and wait for its ready line. On success the SDK
   * client is constructed against the ACTUAL bound URL (with `--port=0` the
   * server picks 4096 or an ephemeral port and prints it — NOTES.md §3) using
   * the per-boot basic-auth secret.
   */
  private async boot(): Promise<OpencodeClient> {
    this.phase = 'starting';
    const binary = await resolveOpenCodeBinaryPath();
    if (!binary) {
      // resolveOpenCodeBinaryPath() is async, so shutdown() may have flipped the
      // phase to 'stopped' while we awaited it. Never resurrect a stopped manager
      // to 'idle' (mirrors the catch-block guard below), or a later getClient()
      // would spawn a sidecar after shutdown.
      if (!this.isStopped()) this.phase = 'idle';
      throw new Error(
        'OpenCode CLI not found — set runtimes.opencode.binaryPath or install it (npm i -g opencode-ai)'
      );
    }

    const { port } = configManager.get('runtimes').opencode;
    const password = randomBytes(32).toString('hex');
    // Resolve the selected provider's stored credential REFERENCE into real
    // env vars (e.g. OPENROUTER_API_KEY) for the sidecar at spawn (ADR-0315).
    // A missing/dangling reference yields `{}` — the sidecar keeps its own auth.
    const providerEnv = await resolveOpenCodeProviderEnv();
    const child = spawn(binary, ['serve', `--hostname=${SIDECAR_HOSTNAME}`, `--port=${port}`], {
      env: {
        // eslint-disable-next-line no-restricted-syntax -- the sidecar must inherit the full parent environment (PATH, provider API keys), not env.ts's parsed subset
        ...process.env,
        ...providerEnv,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(OPENCODE_SIDECAR_CONFIG),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    let url: string;
    try {
      url = await this.waitForReady(child);
      // The ready line and an immediate crash can land in the same tick; a
      // dead child must never be handed out as "ready".
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('OpenCode sidecar exited immediately after startup');
      }
      // shutdown() may have run while we awaited readiness: it SIGTERMs the
      // child, but the buffered ready line can be delivered BEFORE the exit
      // event is reaped — the success path must never resurrect a stopped
      // manager to 'ready'. (`this.child !== child` is belt-and-braces; only
      // shutdown() can detach the child mid-boot.)
      if (this.isStopped() || this.child !== child) {
        throw new Error('OpenCode sidecar manager has been shut down');
      }
    } catch (err) {
      // On the startup-timeout path the child is still ALIVE and still ours.
      // Releasing the phase/child latches (phase→'idle', child→null) while it
      // lingers lets a concurrent getClient() spawn a SECOND `opencode serve`
      // that races the dying one for the same fixed port (EADDRINUSE when
      // runtimes.opencode.port is non-zero). Confirm it is dead BEFORE clearing
      // state. When shutdown() has already detached the child
      // (`this.child !== child`) it owns the kill, and the exited-before-ready
      // and spawn-error paths have no live child to await, so all three reject
      // immediately.
      const weOwnLiveChild =
        this.child === child &&
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null;
      if (weOwnLiveChild) await this.killChild(child);
      if (this.child === child) this.child = null;
      // shutdown() may have flipped the phase to 'stopped' while we awaited
      // readiness — never resurrect to 'idle' then. (The method call also
      // defeats CFA narrowing, which cannot see cross-await mutation.)
      if (!this.isStopped()) this.phase = 'idle';
      throw err;
    }

    // Drain the pipes post-readiness (flowing mode with no listeners discards)
    // so the sidecar's own logging can never fill the pipe buffer and stall it.
    child.stdout?.resume();
    child.stderr?.resume();

    child.once('exit', (code, signal) => {
      if (this.phase === 'ready' && this.child === child) {
        this.handleUnexpectedExit(code, signal);
      }
    });

    const client = createOpencodeClient({
      baseUrl: url,
      headers: {
        Authorization: `Basic ${Buffer.from(`${SIDECAR_USERNAME}:${password}`).toString('base64')}`,
      },
    });
    this.client = client;
    this.phase = 'ready';
    this.readyAt = Date.now();
    logger.info(`[OpenCode] sidecar ready at ${url}`);
    return client;
  }

  /**
   * Resolve with the sidecar's base URL once the ready line appears on
   * stdout; reject on exit-before-ready, spawn error, or startup timeout.
   */
  private waitForReady(child: ChildProcess): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let output = '';
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `OpenCode sidecar did not become ready within ${SIDECAR_TIMING.startupTimeoutMs}ms`
            )
          )
        );
      }, SIDECAR_TIMING.startupTimeoutMs);

      const onStdout = (chunk: Buffer) => {
        output += chunk.toString();
        const match = READY_LINE_PATTERN.exec(output);
        if (match?.[1]) {
          const url = match[1];
          settle(() => resolve(url));
        }
      };
      const onStderr = (chunk: Buffer) => {
        output += chunk.toString();
      };
      const onExit = (code: number | null) => {
        const detail = output.trim() ? `: ${output.trim()}` : '';
        settle(() =>
          reject(new Error(`OpenCode sidecar exited before ready (code ${code})${detail}`))
        );
      };
      const onError = (err: Error) => {
        settle(() => reject(err));
      };

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  /** A ready sidecar died out from under us — clean up and enter the restart ladder. */
  private handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.client = null;
    this.child = null;
    this.phase = 'idle';
    // A long healthy run means this crash is fresh, not part of a loop.
    if (Date.now() - this.readyAt >= SIDECAR_TIMING.backoffResetUptimeMs) {
      this.restartAttempts = 0;
    }
    logger.warn(
      `[OpenCode] sidecar exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    );
    this.maybeScheduleRestart();
  }

  /**
   * Schedule the next restart on the exponential ladder, or give up after
   * {@link SIDECAR_TIMING.maxRestartAttempts} consecutive failures (the next
   * explicit `getClient()` then boots fresh). The pending restart is exposed
   * as the shared in-flight boot so `getClient()` callers wait for it instead
   * of spawning eagerly; a failed restart boot re-enters this method.
   */
  private maybeScheduleRestart(): void {
    if (this.phase === 'stopped') return;
    if (this.restartAttempts >= SIDECAR_TIMING.maxRestartAttempts) {
      logger.error(
        `[OpenCode] sidecar restart attempts exhausted (${SIDECAR_TIMING.maxRestartAttempts}) — giving up until the next use`
      );
      this.restartAttempts = 0;
      return;
    }
    const delay = Math.min(
      SIDECAR_TIMING.restartBaseDelayMs * 2 ** this.restartAttempts,
      SIDECAR_TIMING.restartMaxDelayMs
    );
    this.restartAttempts += 1;
    this.phase = 'starting';
    logger.warn(
      `[OpenCode] restarting sidecar in ${delay}ms (attempt ${this.restartAttempts}/${SIDECAR_TIMING.maxRestartAttempts})`
    );

    const restart = this.trackBoot(
      new Promise<OpencodeClient>((resolve, reject) => {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.boot().then(resolve, reject);
        }, delay);
      })
    );
    restart.catch((err: unknown) => {
      if (this.phase === 'stopped') return;
      logger.warn('[OpenCode] sidecar restart attempt failed', logError(err));
      this.maybeScheduleRestart();
    });
  }

  /** SIGTERM the child and escalate to SIGKILL after the grace window. */
  private async killChild(child: ChildProcess): Promise<void> {
    // Nothing to reap when the child already exited, or when spawn failed so no
    // OS process ever existed (`pid` undefined means no 'exit' will ever fire,
    // so awaiting one would hang). Returning here keeps this safe to await.
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      child.kill('SIGKILL');
    }, SIDECAR_TIMING.shutdownGraceMs);
    await exited;
    clearTimeout(escalation);
  }
}

/**
 * Singleton sidecar manager. The composition root (`index.ts`) awaits
 * `shutdown()` in its teardown path; the OpenCode runtime facade (task 3.6)
 * hands this instance to the session mapper / event subscriber as their
 * {@link OpenCodeClientProvider}. Construction is side-effect free — the
 * sidecar spawns lazily on the first `getClient()` call, never at import time.
 */
export const openCodeServerManager = new OpenCodeServerManager();
