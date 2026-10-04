/**
 * RunBroker: runs `allow.run` programs for an isolated extension (DOR-2686,
 * spec §6, design decision D3).
 *
 * `--allow-child-process` is all-or-nothing, so the child gets none, and the
 * host runs programs on its behalf:
 *
 * - **Which program.** The requested file must equal a declared `allow.run`
 *   entry, exactly. Each entry is resolved when the broker is created (the
 *   extension's start) with the same `resolveProgram` discovery uses, so a
 *   program inside extension files or a Windows `.cmd`/`.bat` script is never
 *   run, and a difference from what discovery showed the person is logged.
 *   Every spawn re-checks the resolved path still passes those rules, then
 *   runs that ABSOLUTE path with `shell: false`. `exec` and `shell: true`
 *   need `sh` (or `cmd`) declared, because that is what they run.
 * - **Where.** The working folder must be inside the extension's files folder
 *   or a project root it was given; the default is its files folder.
 * - **With what environment.** Exactly what the extension passes, plus the
 *   host's `PATH` (and `SystemRoot` on Windows, without which many programs
 *   cannot start). The extension cannot read the host's environment, so it
 *   cannot pass it along.
 * - **How many.** At most 8 at once.
 * - **Cleanup.** Each program leads its own process group on POSIX; stopping
 *   the extension kills every program it started that is still running (the
 *   group on POSIX, the tree on Windows). Only processes this broker spawned,
 *   tracked by the `ChildProcess` it holds, are ever signalled, and never
 *   after that process has been seen to exit (its id could belong to someone
 *   else by then).
 *
 * What this enforces is WHICH programs. What a permitted program then does is
 * outside every limit here: it runs with the person's full authority. The
 * consent card says so for shells and interpreters.
 *
 * @module services/extensions/isolation/run-broker
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionIsolation } from '@dorkos/extension-api';
import { killProcessTree } from '../../marketplace/lib/git/git-runner.js';
import {
  ISOLATION_LIMITS,
  RUN_DENIED_CODE,
  type HostMessage,
  type RunKillMessage,
  type RunSpawnMessage,
  type RunStdinMessage,
} from './ipc-protocol.js';
import { resolveProgram, type ResolveProgramOptions } from './resolve-program.js';

/** Refusal for a cwd outside what the extension can use. */
export const RUN_CWD_REFUSAL = 'That folder is outside what this extension can use.';

/** Refusal past the concurrency cap. */
export const RUN_TOO_MANY = 'Too many programs running at once.';

/**
 * Refusal for a program not in `allow.run`.
 *
 * @param name - The program asked for.
 */
export function runNotAllowed(name: string): string {
  return `${name} isn't in this extension's allow.run list.`;
}

/** Where the broker logs. */
export interface BrokerLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** What the broker needs. */
export interface RunBrokerOptions {
  /** The extension id, for log lines. */
  extensionId: string;
  /** The isolation view: `run` as declared and `resolvedRun` as discovery found it. */
  isolation: Pick<ExtensionIsolation, 'run' | 'resolvedRun'>;
  /** The extension's files folder (a working folder may be inside it). */
  filesDir: string;
  /** Project roots this extension may run programs in (later phases fill this). */
  projectRoots?: () => Promise<readonly string[]>;
  /** Sends one message to the child; returns `false` when the channel is backed up. */
  send: (message: HostMessage) => boolean;
  /** Resolves once a backed-up channel has caught up. */
  whenDrained: () => Promise<void>;
  /** How `allow.run` entries are resolved (DorkOS's data dir and refused folders). */
  resolve: ResolveProgramOptions;
  /** The log. */
  logger: BrokerLogger;
  /** The host environment `PATH` comes from (tests). */
  env?: NodeJS.ProcessEnv;
  /** The platform (tests). */
  platform?: NodeJS.Platform;
}

/** One running program. */
interface Running {
  child: ChildProcess;
  exited: boolean;
}

/**
 * Whether `child` is `root` or inside it.
 *
 * @param root - A folder.
 * @param child - A path.
 */
function isWithin(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The real path of a folder, or `null`.
 *
 * @param target - A path.
 */
async function realOf(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Runs declared programs for one isolated extension.
 */
export class RunBroker {
  private readonly running = new Map<number, Running>();
  /** Requests being checked (resolution and folder checks are asynchronous). */
  private pending = 0;
  private readonly startPaths = new Map<string, string | null>();
  private ready: Promise<void>;
  private stopped = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  /**
   * Resolve every declared program now (the extension's start).
   *
   * @param options - See {@link RunBrokerOptions}.
   */
  constructor(private readonly options: RunBrokerOptions) {
    // eslint-disable-next-line no-restricted-syntax -- PATH (and SystemRoot) are the live program environment, not app config
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.ready = this.resolveAll();
  }

  /** How many programs are running. */
  get size(): number {
    return this.running.size;
  }

  /** Resolve each `allow.run` entry, and log any difference from discovery. */
  private async resolveAll(): Promise<void> {
    for (const name of this.options.isolation.run) {
      const found = await resolveProgram(name, {
        ...this.options.resolve,
        env: this.env,
        platform: this.platform,
      });
      this.startPaths.set(name, found.path);
      const shown = this.options.isolation.resolvedRun.find((r) => r.name === name)?.path ?? null;
      if (shown !== found.path) {
        this.options.logger.warn(
          `[Extensions] ${this.options.extensionId}: allow.run "${name}" now resolves to ` +
            `${found.path ?? 'nothing'}, not ${shown ?? 'nothing'} as shown at approval`
        );
      }
    }
  }

  /**
   * Handle one `run-*` message from the child. Every field is re-checked.
   *
   * @param message - A `run-spawn`, `run-stdin` or `run-kill` message.
   */
  async handle(message: RunSpawnMessage | RunStdinMessage | RunKillMessage): Promise<void> {
    if (message.type === 'run-stdin') return this.stdin(message);
    if (message.type === 'run-kill') return this.kill(message);
    return this.spawn(message);
  }

  /**
   * Refuse a request.
   *
   * @param rid - The request.
   * @param message - Why.
   * @param code - The error code.
   */
  private refuse(rid: number, message: string, code: string = RUN_DENIED_CODE): void {
    this.options.send({ type: 'run-error', rid, code, message });
  }

  /**
   * Start a declared program.
   *
   * @param message - The request.
   */
  private async spawn(message: RunSpawnMessage): Promise<void> {
    const { rid } = message;
    if (this.stopped) return;
    if (this.running.has(rid)) return this.refuse(rid, 'That request id is in use.');
    if (this.running.size + this.pending >= ISOLATION_LIMITS.maxPrograms) {
      return this.refuse(rid, RUN_TOO_MANY);
    }
    this.pending++;
    try {
      await this.ready;
      if (!this.options.isolation.run.includes(message.file)) {
        return this.refuse(rid, runNotAllowed(message.file));
      }
      const startPath = this.startPaths.get(message.file) ?? null;
      // Re-check the file the extension started with still passes every rule
      // (exists, runnable, not in extension files, not a Windows script).
      const recheck = startPath
        ? await resolveProgram(startPath, {
            ...this.options.resolve,
            env: this.env,
            platform: this.platform,
          })
        : null;
      if (!startPath || !recheck || recheck.path === null) {
        const reason = recheck && recheck.path === null ? ` ${recheck.reason}` : '';
        return this.refuse(rid, `${message.file} can't run on this computer.${reason}`);
      }
      const cwd = await this.checkCwd(message.cwd);
      if (!cwd) return this.refuse(rid, RUN_CWD_REFUSAL);
      if (this.stopped) return;

      const env: NodeJS.ProcessEnv = { ...(message.env ?? {}) };
      const hostPath = this.platform === 'win32' ? (this.env.Path ?? this.env.PATH) : this.env.PATH;
      if (hostPath !== undefined) env.PATH = hostPath;
      if (this.platform === 'win32' && this.env.SystemRoot) env.SystemRoot = this.env.SystemRoot;

      const base = path.basename(startPath).toLowerCase();
      const child = spawn(startPath, message.args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        // cmd.exe parses its own command line; Node must not re-quote it.
        windowsVerbatimArguments:
          this.platform === 'win32' && (base === 'cmd.exe' || base === 'cmd'),
        // Its own process group on POSIX, so the whole tree can be stopped.
        detached: this.platform !== 'win32',
        stdio: [message.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      const entry: Running = { child, exited: false };
      this.running.set(rid, entry);
      this.pipe(rid, child);
    } finally {
      this.pending--;
    }
  }

  /**
   * Stream a program's output to the child and report how it ended.
   *
   * @param rid - The request.
   * @param child - The program.
   */
  private pipe(rid: number, child: ChildProcess): void {
    const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const delivered = this.options.send({
        type: 'run-data',
        rid,
        stream,
        chunk: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      });
      // Back-pressure: a backed-up channel pauses the program's output.
      if (!delivered) {
        const source = stream === 'stdout' ? child.stdout : child.stderr;
        source?.pause();
        void this.options.whenDrained().then(() => source?.resume());
      }
    };
    child.stdout?.on('data', forward('stdout'));
    child.stderr?.on('data', forward('stderr'));
    child.once('spawn', () => {
      if (child.pid !== undefined) this.options.send({ type: 'run-spawned', rid, pid: child.pid });
    });
    let reported = false;
    child.once('error', (err: NodeJS.ErrnoException) => {
      const entry = this.running.get(rid);
      if (entry) entry.exited = true;
      this.running.delete(rid);
      if (reported) return;
      reported = true;
      this.refuse(rid, err.message, err.code ?? 'ERR_EXTENSION_RUN_FAILED');
    });
    child.once('exit', () => {
      const entry = this.running.get(rid);
      if (entry) entry.exited = true;
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.running.delete(rid);
      if (reported) return;
      reported = true;
      this.options.send({ type: 'run-exit', rid, code, signal });
    });
  }

  /**
   * Check a requested working folder: inside the files folder or a project
   * root, by real path. `null` means the files folder.
   *
   * @param requested - The folder the extension asked for.
   * @returns The real folder to use, or `null` when refused.
   */
  private async checkCwd(requested: string | null): Promise<string | null> {
    const files = await realOf(this.options.filesDir);
    if (!files) return null;
    if (requested === null) return files;
    if (!path.isAbsolute(requested)) return null;
    const real = await realOf(requested);
    if (!real) return null;
    if (isWithin(files, real)) return real;
    const roots = (await this.options.projectRoots?.()) ?? [];
    for (const root of roots) {
      const realRoot = await realOf(root);
      if (realRoot && isWithin(realRoot, real)) return real;
    }
    return null;
  }

  /**
   * Write to, or close, a program's standard input.
   *
   * @param message - The request.
   */
  private stdin(message: RunStdinMessage): void {
    const stdin = this.running.get(message.rid)?.child.stdin;
    if (!stdin || stdin.destroyed) return;
    if (message.chunk === null) stdin.end();
    else stdin.write(Buffer.from(message.chunk));
  }

  /**
   * Signal a running program (its group on POSIX).
   *
   * @param message - The request.
   */
  private kill(message: RunKillMessage): void {
    const entry = this.running.get(message.rid);
    if (!entry || entry.exited || entry.child.pid === undefined) return;
    const signal =
      message.signal && Object.prototype.hasOwnProperty.call(osConstants.signals, message.signal)
        ? (message.signal as NodeJS.Signals)
        : 'SIGTERM';
    if (this.platform === 'win32') {
      entry.child.kill(signal);
      return;
    }
    try {
      process.kill(-entry.child.pid, signal);
    } catch {
      entry.child.kill(signal);
    }
  }

  /**
   * Stop every program this extension started that is still running, and
   * refuse anything further. Synchronous, so it can run while DorkOS exits.
   */
  killAll(): void {
    this.stopped = true;
    for (const entry of this.running.values()) {
      if (!entry.exited && entry.child.pid !== undefined) killProcessTree(entry.child.pid);
    }
  }
}
