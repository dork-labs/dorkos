/**
 * The supervised `codex app-server` processes DorkOS runs (spec
 * `codex-app-server-transport` §5, ADR 261005-113107).
 *
 * - **One process per key**: (binary, `CODEX_HOME`, fingerprint of the
 *   environment). In practice two — the person's Codex home and the credits
 *   home. A changed binary or inheritance policy is a new key; the old process
 *   is drained (no new threads) and closed once nothing in it is live.
 * - **Lazy.** Spawned on the first turn that needs it, `initialize`d with the
 *   experimental API, shared by concurrent callers through one in-flight boot.
 *   Argv is always exactly `app-server --listen stdio://`: no `-c`, no secrets.
 * - **Crash.** An exit DorkOS did not ask for, a protocol fault or a broken
 *   pipe closes the connection; everything waiting on it hears why (the
 *   transport turns that into an honest error and one `done` per open turn).
 *   Three crashes inside a minute refuse a respawn for 30 s.
 * - **Idle reaping.** A process is live while anything holds it (an open turn,
 *   a pending server request) or a liveness probe reports work Codex is still
 *   running (a background terminal, `thread/backgroundTerminals/list`). One that
 *   is not live for 10 minutes is closed; one marked stale is closed as soon as
 *   it is not live. A replaced process is kept in a draining set until then,
 *   so the reaper and shutdown always see it.
 * - **Shutdown.** End stdin, wait 3 s, SIGTERM, wait 3 s, SIGKILL — only ever
 *   the PID this pool spawned (Hard Rule 7).
 *
 * @module services/runtimes/codex/app-server/process-pool
 */
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { logger } from '../../../../lib/logger.js';
import { CodexJsonRpcClient, lastLine, type CodexClientClose } from './json-rpc-client.js';
import { initializeCodexClient } from './handshake.js';

/** Consecutive failed liveness probes after which a process counts as idle. */
export const PROBE_FAILURE_LIMIT = 3;

/** The argv every app-server is spawned with. Nothing else, ever. */
export const APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'] as const;

/** A spawned child, as far as the pool uses it. */
export interface AppServerChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The spawn seam (tests pass the fake app-server host's). */
export type SpawnAppServer = (
  binary: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string | undefined }
) => AppServerChild;

/** What a process is for. */
export interface CodexProcessSpec {
  /** The `codex` binary. */
  readonly binary: string;
  /** The `CODEX_HOME` it runs on (also its working directory). */
  readonly codexHome: string;
  /** Its complete environment; nothing per turn is layered on it. */
  readonly env: Readonly<Record<string, string>>;
}

/** Raised when a home's process keeps crashing. */
export class CodexCrashLoopError extends Error {
  /** Construct with the copy a person reads. */
  constructor() {
    super('Codex keeps stopping. Try again in a minute.');
    this.name = 'CodexCrashLoopError';
  }
}

/** Timing knobs; tests shrink them. */
export interface CodexPoolTiming {
  /** Close a process with no hold after this long. */
  readonly idleMs: number;
  /** How often the reaper looks. */
  readonly reapIntervalMs: number;
  /** Crashes within this window count toward the loop guard. */
  readonly crashWindowMs: number;
  /** How many crashes in the window trip the guard. */
  readonly crashLimit: number;
  /** How long a tripped guard refuses a respawn. */
  readonly crashCooldownMs: number;
  /** Each shutdown step's wait. */
  readonly shutdownStepMs: number;
  /** Bound on `initialize`. */
  readonly initializeMs: number;
}

/** The defaults the spec names. */
export const CODEX_POOL_TIMING: CodexPoolTiming = {
  idleMs: 10 * 60_000,
  reapIntervalMs: 60_000,
  crashWindowMs: 60_000,
  crashLimit: 3,
  crashCooldownMs: 30_000,
  shutdownStepMs: 3_000,
  initializeMs: 15_000,
};

/**
 * The fingerprint half of a key: SHA-256 of the sorted `name=value` pairs, so
 * the key never holds a value (some are credentials).
 *
 * @param env - The process environment.
 */
export function environmentFingerprint(env: Readonly<Record<string, string>>): string {
  const pairs = Object.keys(env)
    .sort()
    .map((name) => `${name}=${env[name]}`)
    .join('\u0000');
  return createHash('sha256').update(pairs).digest('hex');
}

/**
 * A process key: binary, home and environment fingerprint.
 *
 * @param spec - What the process is for.
 */
export function processKeyOf(spec: CodexProcessSpec): string {
  return createHash('sha256')
    .update(`${spec.binary}\u0000${spec.codexHome}\u0000${environmentFingerprint(spec.env)}`)
    .digest('hex')
    .slice(0, 32);
}

/** One live `codex app-server`. */
export class CodexAppServerProcess {
  /** The connection. */
  readonly client: CodexJsonRpcClient;
  /** The binary's version from `initialize`, or `null`. */
  version: string | null = null;
  /** Marked when a loaded thread here no longer matches its config, or the key moved on. */
  stale = false;
  private readonly holds = new Set<symbol>();
  private idleSince: number;
  private exitRequested = false;
  private exited = false;
  private readonly exitListeners = new Set<(close: CodexClientClose) => void>();
  private readonly idleListeners = new Set<() => void>();
  private readonly livenessProbes = new Set<() => Promise<boolean>>();
  private probeFailures = 0;
  private readonly exitedPromise: Promise<void>;

  /**
   * Wrap a spawned child.
   *
   * @param key - The pool key.
   * @param spec - What it is for.
   * @param child - The spawned child.
   * @param now - The pool's clock.
   */
  constructor(
    readonly key: string,
    readonly spec: CodexProcessSpec,
    private readonly child: AppServerChild,
    private readonly now: () => number
  ) {
    this.idleSince = now();
    this.client = new CodexJsonRpcClient(child, {
      label: `pid ${child.pid ?? '?'}`,
      closeOnStdoutEnd: false,
    });
    let markExited!: () => void;
    this.exitedPromise = new Promise((resolve) => (markExited = resolve));
    child.once('exit', (code: number | null, signal: string | null) => {
      this.exited = true;
      markExited();
      const detail = `exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}`;
      this.client.close(
        this.exitRequested ? { kind: 'requested', detail } : { kind: 'exited', detail }
      );
    });
    child.once('error', (err: Error) => {
      this.client.close({ kind: 'exited', detail: err.message });
    });
    this.client.onClose((close) => {
      // A protocol fault or broken pipe leaves the child running: stop it.
      if (!this.exited && !this.exitRequested) this.kill('SIGTERM');
      for (const listener of [...this.exitListeners]) listener(close);
      this.exitListeners.clear();
    });
  }

  /** The PID this pool spawned. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether the connection is still usable. */
  get isOpen(): boolean {
    return !this.client.isClosed;
  }

  /** Whether anything holds this process. */
  get isLive(): boolean {
    return this.holds.size > 0;
  }

  /** When it last had no hold (ms clock). */
  get idleSinceMs(): number {
    return this.idleSince;
  }

  /**
   * Keep the process from being reaped until the returned release is called.
   * Turns, pending server requests and (later) background work each hold it.
   */
  hold(): () => void {
    const token = Symbol('hold');
    this.holds.add(token);
    return () => {
      if (this.holds.delete(token) && this.holds.size === 0) {
        this.idleSince = this.now();
        for (const listener of [...this.idleListeners]) listener();
      }
    };
  }

  /**
   * Be told each time the last hold is released.
   *
   * @param listener - Called with no arguments.
   */
  onIdle(listener: () => void): void {
    this.idleListeners.add(listener);
  }

  /**
   * Register a check the reaper runs before closing an unheld process: work
   * that lives in Codex rather than in a DorkOS hold (a background terminal
   * still running after its turn) keeps the process alive when it answers
   * `true`. A probe that throws counts as live (reaping is not the safe
   * guess), up to {@link PROBE_FAILURE_LIMIT} failures in a row.
   *
   * @param probe - Resolves whether something in the process is still live.
   */
  addLivenessProbe(probe: () => Promise<boolean>): void {
    this.livenessProbes.add(probe);
  }

  /**
   * Whether any liveness probe reports live work (see {@link addLivenessProbe}).
   * A probe that fails counts as live — but only {@link PROBE_FAILURE_LIMIT}
   * times in a row, so a Codex that stops answering cannot keep itself alive
   * for ever.
   */
  async hasLiveWork(): Promise<boolean> {
    for (const probe of this.livenessProbes) {
      try {
        if (await probe()) {
          this.probeFailures = 0;
          return true;
        }
      } catch {
        this.probeFailures += 1;
        return this.probeFailures < PROBE_FAILURE_LIMIT;
      }
    }
    this.probeFailures = 0;
    return false;
  }

  /**
   * Be told when the process goes away, for any reason (thread keys revoke).
   *
   * @param listener - Called once with why.
   */
  onExit(listener: (close: CodexClientClose) => void): () => void {
    if (this.client.isClosed) {
      const close = this.client.closedBecause!;
      queueMicrotask(() => listener(close));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Kill by the PID this pool holds. */
  private kill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  /**
   * Stop the process: end stdin, wait, SIGTERM, wait, SIGKILL.
   *
   * @param stepMs - Each wait.
   */
  async stop(stepMs: number): Promise<void> {
    this.exitRequested = true;
    this.client.close({ kind: 'requested', detail: 'stopped by DorkOS' });
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // A broken pipe is a stopped reader.
    }
    if (await this.waitForExit(stepMs)) return;
    this.kill('SIGTERM');
    if (await this.waitForExit(stepMs)) return;
    this.kill('SIGKILL');
    await this.waitForExit(stepMs);
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      void this.exitedPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Mark exited after a failed boot (the child was killed). */
  markBootFailed(): void {
    this.exitRequested = true;
    this.kill('SIGTERM');
  }
}

/** Construction options for {@link CodexAppServerPool}. */
export interface CodexAppServerPoolOptions {
  /** Spawn seam. */
  spawn?: SpawnAppServer;
  /** Clock seam. */
  now?: () => number;
  /** Timing overrides. */
  timing?: Partial<CodexPoolTiming>;
}

const defaultSpawn: SpawnAppServer = (binary, args, options) =>
  nodeSpawn(binary, [...args], { env: options.env, cwd: options.cwd, stdio: 'pipe' });

/** The pool of supervised app-server processes. */
export class CodexAppServerPool {
  private readonly spawn: SpawnAppServer;
  private readonly now: () => number;
  private readonly timing: CodexPoolTiming;
  private readonly processes = new Map<string, CodexAppServerProcess>();
  /**
   * Processes replaced by a newer one for their key or home, kept until
   * nothing in them is live and then closed. Never forgotten: the reaper,
   * `closeWhere` and `shutdown` walk these too, so no child is orphaned.
   */
  private readonly draining = new Set<CodexAppServerProcess>();
  private readonly booting = new Map<string, Promise<CodexAppServerProcess>>();
  private readonly crashes = new Map<string, number[]>();
  private readonly cooldownUntil = new Map<string, number>();
  private reaper: ReturnType<typeof setInterval> | undefined;
  /** Set by {@link shutdown} and never cleared: a stopped pool spawns nothing. */
  private shutDown = false;
  /** The last version a process reported, for the status card's note. */
  lastSeenVersion: string | null = null;

  /**
   * Construct an empty pool.
   *
   * @param options - Seams.
   */
  constructor(options: CodexAppServerPoolOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.now = options.now ?? Date.now;
    this.timing = { ...CODEX_POOL_TIMING, ...options.timing };
  }

  /**
   * The process for a spec, booting it when there is none.
   *
   * @param spec - What it is for.
   * @throws {CodexCrashLoopError} while the home's crash guard is tripped.
   */
  async acquire(spec: CodexProcessSpec): Promise<CodexAppServerProcess> {
    if (this.shutDown) throw new Error('DorkOS is shutting down.');
    const key = processKeyOf(spec);
    const existing = this.processes.get(key);
    if (existing?.isOpen && !existing.stale) return existing;
    const inFlight = this.booting.get(key);
    if (inFlight) return inFlight;
    // A process for the same home on an older key: drain it.
    for (const other of [...this.processes.values()]) {
      if (other.spec.codexHome === spec.codexHome && other.key !== key) {
        other.stale = true;
        this.processes.delete(other.key);
        this.draining.add(other);
        void this.closeIfIdle(other);
      }
    }
    const cooldown = this.cooldownUntil.get(spec.codexHome) ?? 0;
    if (this.now() < cooldown) throw new CodexCrashLoopError();
    const boot = this.boot(key, spec).finally(() => this.booting.delete(key));
    this.booting.set(key, boot);
    return boot;
  }

  private async boot(key: string, spec: CodexProcessSpec): Promise<CodexAppServerProcess> {
    const env: Record<string, string> = { RUST_LOG: 'warn', ...spec.env };
    const cwd = fs.existsSync(spec.codexHome) ? spec.codexHome : undefined;
    const child = this.spawn(spec.binary, APP_SERVER_ARGS, { env, cwd });
    const proc = new CodexAppServerProcess(key, spec, child, this.now);
    proc.onExit((close) => this.onProcessExit(proc, close));
    try {
      proc.version = await initializeCodexClient(proc.client, {
        experimentalApi: true,
        timeoutMs: this.timing.initializeMs,
      });
    } catch (err) {
      proc.markBootFailed();
      proc.client.close({
        kind: 'exited',
        detail: `initialize failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
    this.lastSeenVersion = proc.version;
    const replaced = this.processes.get(key);
    if (replaced && replaced !== proc) {
      replaced.stale = true;
      this.draining.add(replaced);
      void this.closeIfIdle(replaced);
    }
    this.processes.set(key, proc);
    // A stale process is closed the moment nothing in it is live (§5).
    proc.onIdle(() => {
      if (proc.stale) void this.closeIfIdle(proc);
    });
    this.ensureReaper();
    logger.info('[CodexAppServer] started', { pid: proc.pid, version: proc.version });
    return proc;
  }

  private onProcessExit(proc: CodexAppServerProcess, close: CodexClientClose): void {
    if (this.processes.get(proc.key) === proc) this.processes.delete(proc.key);
    this.draining.delete(proc);
    if (close.kind === 'requested') return;
    const home = proc.spec.codexHome;
    const now = this.now();
    const recent = [...(this.crashes.get(home) ?? []), now].filter(
      (at) => now - at <= this.timing.crashWindowMs
    );
    this.crashes.set(home, recent);
    logger.warn('[CodexAppServer] stopped unexpectedly', {
      pid: proc.pid,
      reason: close.kind,
      detail: close.detail,
      stderr: lastLine(proc.client.stderrTail()),
    });
    if (recent.length >= this.timing.crashLimit) {
      this.cooldownUntil.set(home, now + this.timing.crashCooldownMs);
      this.crashes.set(home, []);
      logger.warn('[CodexAppServer] crash loop; refusing a respawn for a while', {
        stderr: proc.client.stderrTail().slice(-2_000),
      });
    }
  }

  /** Every process this pool holds, current or draining (diagnostics and tests). */
  list(): CodexAppServerProcess[] {
    return [...this.processes.values(), ...this.draining];
  }

  private async closeIfIdle(proc: CodexAppServerProcess): Promise<void> {
    if (proc.isLive || !proc.isOpen) return;
    if (await proc.hasLiveWork()) return;
    if (!proc.isLive) await this.close(proc);
  }

  /**
   * One reaper pass: close stale processes with no hold, and any with no hold
   * for the idle window. Never touches a held (live) process, nor one whose
   * liveness probes report work still running in Codex (a background terminal).
   */
  async reapOnce(): Promise<void> {
    const now = this.now();
    const candidates = this.list().filter(
      (proc) => !proc.isLive && (proc.stale || now - proc.idleSinceMs >= this.timing.idleMs)
    );
    await Promise.all(candidates.map((proc) => this.closeIfIdle(proc)));
  }

  /**
   * Close processes matching a predicate (the credits home on unlink).
   *
   * @param predicate - Which processes.
   */
  async closeWhere(predicate: (proc: CodexAppServerProcess) => boolean): Promise<void> {
    await Promise.all(
      this.list()
        .filter(predicate)
        .map((proc) => this.close(proc))
    );
  }

  private async close(proc: CodexAppServerProcess): Promise<void> {
    if (this.processes.get(proc.key) === proc) this.processes.delete(proc.key);
    this.draining.delete(proc);
    await proc.stop(this.timing.shutdownStepMs);
  }

  /** Stop every process (server shutdown and admin restart). */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    await Promise.allSettled([...this.booting.values()]);
    await Promise.all(this.list().map((proc) => this.close(proc)));
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      void this.reapOnce().catch((err: unknown) =>
        logger.warn('[CodexAppServer] reaper failed', { err: String(err) })
      );
    }, this.timing.reapIntervalMs);
    this.reaper.unref?.();
  }
}

/** The process-wide pool; `shutdownServices()` stops it beside OpenCode's sidecar. */
export const codexAppServerPool = new CodexAppServerPool();
