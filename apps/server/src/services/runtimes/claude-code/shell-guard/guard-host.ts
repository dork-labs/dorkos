/**
 * Runs the shell guard's child process and asks it about commands (DOR-3300).
 *
 * **It never fails open.** Each answer has a timer. A crash or a timeout gets one more try on a
 * fresh child, and then that command is `failed`, which refuses it; the next command gets a fresh
 * child. A child that can't get ready, twice, is `unavailable`: DorkOS has no check at all, and the
 * hook decides what that means at each level.
 *
 * One child answers one command at a time, so a stall holds up nobody else: a command that finds no
 * free child gets its own, up to a limit, and waits past it. One child stays warm for a while, so a
 * plain command costs about a millisecond.
 *
 * Only children this host forked are ever signalled, by the objects it holds.
 *
 * @module services/runtimes/claude-code/shell-guard/guard-host
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { answerFrom, isGuardReady, type GuardRequest, type WireRoots } from './guard-protocol.js';
import type { ShellCheckAnswer, ShellGuardRoots } from './shell-check.js';

/** What the host said about one command. */
export type ShellCheckResult =
  ({ outcome: 'checked' } & ShellCheckAnswer) | { outcome: 'failed' } | { outcome: 'unavailable' };

/** Asks about one command. Never rejects. */
export type ShellChecker = (
  command: string,
  roots: ShellGuardRoots,
  reads: boolean
) => Promise<ShellCheckResult>;

/** Timings and limits, overridable by tests. */
export interface GuardHostTuning {
  /** How long a child has to get ready. */
  startMs: number;
  /** How long a child has to answer. */
  answerMs: number;
  /** How long a command may wait for a free child, once the limit is reached. */
  queueMs: number;
  /** How many children may run at once. */
  maxChildren: number;
  /** How long the warm child stays once nothing is asked. */
  idleMs: number;
  /** How long after a failed start the next command waits before trying another. */
  startRetryMs: number;
  /** The heap limit, in MB. A command past it ends the child, which refuses the command. */
  heapMb: number;
}

const DEFAULTS: GuardHostTuning = {
  startMs: 5_000,
  answerMs: 5_000,
  queueMs: 15_000,
  maxChildren: 4,
  idleMs: 10 * 60_000,
  startRetryMs: 5_000,
  heapMb: 512,
};

/** Failed starts in a row before the person is told. */
const STARTS_BEFORE_NOTICE = 3;

/** What the host needs. */
export interface GuardHostOptions {
  /** The child file to fork. Rejecting counts as a failed start. */
  childFile: () => Promise<string>;
  /**
   * Called on the third failed start in a row, and again only after a check has worked. Never on a
   * crash: a child counts as started once it has answered about a plain command, so nothing an
   * agent writes can get here.
   */
  onUnavailable?: (level: { full: boolean }) => void;
  /** Called on this host's first working start, and when a check works again after a notice. */
  onRecovered?: () => void;
  /** Reports what happened: never a command, which may hold a token. */
  log: { warn(message: string, data: Record<string, unknown>): void };
  /** The binary to fork with; `process.execPath` by default. */
  execPath?: string;
  /** Whether the binary is Electron, run as plain Node. */
  electronRunAsNode?: boolean;
  /** Test timings. */
  tuning?: Partial<GuardHostTuning>;
}

/** A child, ready and free or answering one command. */
interface Worker {
  child: ChildProcess;
  gone: boolean;
}

/** Children of every host, so the server's exit can end them. */
const liveChildren = new Set<ChildProcess>();
let exitHooked = false;

/** Children end when the server does: the channel closing tells them, and this covers the rest. */
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const child of liveChildren) child.kill('SIGKILL');
  });
}

/** Only the variables a command names cross to the child: the launch's others may hold keys. */
function namedVariables(command: string, env: ShellGuardRoots['env']): WireRoots['env'] {
  return Object.fromEntries(Object.entries(env).filter(([name]) => command.includes(name)));
}

/** The folders as plain data, the agent list read now so a new agent is covered. */
function wireRoots(command: string, roots: ShellGuardRoots): WireRoots {
  const { agentHomes, env, ...folders } = roots;
  return { ...folders, env: namedVariables(command, env), agentHomes: agentHomes() };
}

/** Starts, watches and stops the guard's children. */
export class GuardHost {
  private readonly tuning: GuardHostTuning;
  private readonly live = new Set<Worker>();
  private warm: Worker | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private waiting: ((worker: Worker | null) => void)[] = [];
  private nextId = 1;
  private failedStarts = 0;
  private lastFailedStart = 0;
  private told = false;
  private everStarted = false;
  private lastAtFull = false;

  /**
   * Prepare a host; no child starts until a command is asked about.
   *
   * @param options - See {@link GuardHostOptions}.
   */
  constructor(private readonly options: GuardHostOptions) {
    this.tuning = { ...DEFAULTS, ...options.tuning };
  }

  /** Whether DorkOS currently has no check: the last start failed and none has worked since. */
  get unavailable(): boolean {
    return this.failedStarts > 0;
  }

  /** The warm child's process id, for measuring it. Never used to signal. */
  get warmPid(): number | undefined {
    return this.warm?.child.pid;
  }

  /**
   * Ask about one command. Never rejects.
   *
   * @param command - The command line.
   * @param roots - This launch's folders.
   * @param reads - Whether to check reads too.
   */
  readonly check: ShellChecker = async (command, roots, reads) => {
    this.lastAtFull = !reads;
    let wire: WireRoots;
    try {
      wire = wireRoots(command, roots);
    } catch (err) {
      // The agent list can't be read, so a check would miss homes.
      this.warn('the check could not read its folders', err);
      return { outcome: 'failed' };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const worker = await this.takeWorker();
      if (!worker) return { outcome: this.unavailable ? 'unavailable' : 'failed' };
      const answer = await this.ask(worker, command, wire, reads);
      if (answer) {
        this.release(worker);
        return { outcome: 'checked', ...answer };
      }
      this.end(worker);
    }
    return { outcome: 'failed' };
  };

  /** Stop every child, for the server's exit and for tests. */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const worker of [...this.live]) this.end(worker);
  }

  /** A free child: the warm one, a new one, or the next to come free. `null` when none can be had. */
  private async takeWorker(): Promise<Worker | null> {
    if (this.warm) {
      const worker = this.warm;
      this.warm = null;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      if (!worker.gone) return worker;
    }
    if (this.live.size >= this.tuning.maxChildren) return this.waitForWorker();
    // After a failed start, don't fork again on every command.
    if (this.unavailable && Date.now() - this.lastFailedStart < this.tuning.startRetryMs) {
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const worker = await this.start();
      if (worker) {
        this.startWorked();
        return worker;
      }
      this.startFailed();
    }
    return null;
  }

  /** Wait in line for a child, for a limited time. */
  private waitForWorker(): Promise<Worker | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((one) => one !== handOver);
        resolve(null);
      }, this.tuning.queueMs);
      const handOver = (worker: Worker | null): void => {
        clearTimeout(timer);
        resolve(worker);
      };
      this.waiting.push(handOver);
    });
  }

  /** Fork a child and wait until it says it is ready. `null` if it doesn't. */
  private async start(): Promise<Worker | null> {
    let file: string;
    try {
      file = await this.options.childFile();
    } catch (err) {
      this.warn('the check’s file is missing', err);
      return null;
    }
    hookExit();
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        // Nothing inherited: no loaders from the parent, no keys in the environment. It reads
        // every folder, because that is its job, and it can change nothing.
        child = fork(file, [], {
          execPath: this.options.execPath ?? process.execPath,
          execArgv: [
            '--permission',
            '--allow-fs-read=*',
            `--max-old-space-size=${this.tuning.heapMb}`,
          ],
          env:
            (this.options.electronRunAsNode ?? Boolean(process.versions.electron))
              ? { ELECTRON_RUN_AS_NODE: '1' }
              : {},
          cwd: path.parse(file).root,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        });
      } catch (err) {
        this.warn('the check could not start', err);
        resolve(null);
        return;
      }
      const worker: Worker = { child, gone: false };
      this.live.add(worker);
      liveChildren.add(child);
      child.once('exit', () => this.gone(worker));
      const finish = (ready: boolean): void => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onError);
        if (!ready) this.end(worker);
        else this.park(child);
        resolve(ready ? worker : null);
      };
      const timer = setTimeout(() => finish(false), this.tuning.startMs);
      const onMessage = (message: unknown): void => {
        if (isGuardReady(message)) finish(true);
      };
      const onExit = (): void => finish(false);
      const onError = (err: Error): void => {
        this.warn('the check could not start', err);
        finish(false);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  /** Ask one child. `null` for a timeout, a crash or anything that isn't an answer. */
  private ask(
    worker: Worker,
    command: string,
    roots: WireRoots,
    reads: boolean
  ): Promise<ShellCheckAnswer | null> {
    const { child } = worker;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const finish = (answer: ShellCheckAnswer | null): void => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onExit);
        this.park(child);
        resolve(answer);
      };
      const timer = setTimeout(() => finish(null), this.tuning.answerMs);
      const onMessage = (message: unknown): void => finish(answerFrom(message, id));
      const onExit = (): void => finish(null);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onExit);
      this.unpark(child);
      const request: GuardRequest = { id, command, roots, reads };
      try {
        child.send(request, (err) => {
          if (err) finish(null);
        });
      } catch {
        finish(null);
      }
    });
  }

  /** A child answered: hand it to whoever waits, keep it warm, or end it if one is already warm. */
  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) {
      next(worker);
      return;
    }
    if (this.warm) {
      this.end(worker);
      return;
    }
    this.warm = worker;
    this.idleTimer = setTimeout(() => {
      if (this.warm) this.end(this.warm);
    }, this.tuning.idleMs);
    this.idleTimer.unref();
  }

  /** End a child, and start a replacement for whoever waited on it. */
  private end(worker: Worker): void {
    if (!worker.gone) worker.child.kill('SIGKILL');
    this.gone(worker);
  }

  /** A child is no more: forget it, and let the next in line have its place. */
  private gone(worker: Worker): void {
    if (worker.gone) return;
    worker.gone = true;
    this.live.delete(worker);
    liveChildren.delete(worker.child);
    if (this.warm === worker) this.warm = null;
    const next = this.waiting.shift();
    if (next) void this.takeWorker().then(next);
  }

  /** While free, a child doesn't hold the server open. */
  private park(child: ChildProcess): void {
    child.channel?.unref();
    child.unref();
  }

  /** While answering, it does. */
  private unpark(child: ChildProcess): void {
    child.channel?.ref();
    child.ref();
  }

  private startFailed(): void {
    this.failedStarts += 1;
    this.lastFailedStart = Date.now();
    if (this.failedStarts >= STARTS_BEFORE_NOTICE && !this.told) {
      this.told = true;
      this.options.onUnavailable?.({ full: this.lastAtFull });
    }
  }

  private startWorked(): void {
    this.failedStarts = 0;
    if (this.told || !this.everStarted) {
      this.told = false;
      this.everStarted = true;
      this.options.onRecovered?.();
    }
  }

  private warn(message: string, err: unknown): void {
    this.options.log.warn(`[ShellGuard] ${message}`, {
      error: err instanceof Error ? err.name : 'unknown',
    });
  }
}
