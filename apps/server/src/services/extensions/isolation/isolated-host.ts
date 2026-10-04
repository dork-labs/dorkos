/**
 * IsolatedExtensionHost: start one isolated extension in its own Node process
 * with only the permissions the spec grants, or refuse (DOR-2686, spec §3, §4
 * and §9; design decisions D1 and D7).
 *
 * ## The fixed grants
 *
 * The child is forked with Node's permission model on and exactly these
 * grants, every path passed through `realpath` (grants must be real paths; on
 * macOS `/tmp` is `/private/tmp`):
 *
 * - read: its run folder (`{dorkHome}/cache/extensions/isolated/<id>`, staged
 *   fresh at every start with a copy of the bootstrap, the compiled bundle and
 *   the extension's `assets/`), and its own files folder. Exactly two read
 *   grants, on purpose: see step 3 of `start()` for the Node bug three or more
 *   would hit;
 * - write: its own files folder (`{dorkHome}/extension-data/<id>/files`);
 * - a V8 heap cap from `limits.memoryMb` (`--max-old-space-size`; Buffers and
 *   native memory are not counted).
 *
 * Never granted: `--allow-child-process`, `--allow-worker`, `--allow-addons`,
 * `--allow-wasi`, `--allow-inspector`. The parent's `execArgv` (tsx loaders in
 * development) is never inherited, and the environment is built from nothing:
 * locale and time zone, `HOME` and the temp variables pointing into the files
 * folder, the extension id, `SystemRoot`/`windir` on Windows (Winsock needs
 * them), and `ELECTRON_RUN_AS_NODE` inside the desktop app.
 * No `PATH`, no `NODE_OPTIONS`, no keys, no DorkOS tokens.
 *
 * A grant path containing `,` or `*` is refused before forking: older Node
 * releases split grants on commas and read `*` as a wildcard, and a grant
 * that silently means a parent folder would be a hole.
 *
 * ## Fail closed
 *
 * The child's first message reports what the permission model allows. Unless
 * the model is on, the child can read its own bootstrap (the control proving
 * the report is truthful), it can read neither `/`, the data directory nor any
 * folder above a grant, and writing `/`, child processes, workers, addons,
 * WASI and the inspector are all off, the child is killed and the start is refused with
 * `isolation_unavailable`. There is no fallback to running in-process.
 *
 * ## Running
 *
 * - **Watchdog.** A ping every 5 s; no pong for 15 s kills the child as
 *   `server_unresponsive`. So does a host-to-child backlog over 1,000
 *   unwritten messages.
 * - **Exit classification.** An exit the host asked for is `stopped`; V8's
 *   "heap out of memory" marker on stderr makes it `server_out_of_memory`; a
 *   watchdog kill is `server_unresponsive`; anything else is `server_crashed`.
 *   Restarting is the caller's decision (`RestartPolicy`).
 * - **The channel.** Every child message is checked for shape
 *   (`isChildMessage`), size (4 MB) and rate before it is read; at most 256
 *   requests may wait on the host at once.
 * - **ctx.** Given the extension's real ctx, the host routes every ctx message
 *   through a fresh `CtxDispatcher` per child, and closes it when the child's
 *   process ends, so nothing the child registered outlives it.
 * - **register().** After loading the bundle the child runs `register(router,
 *   ctx)` and reports `registered`; the host's load timer (measured here, not
 *   in the child) covers loading and `register()` together.
 * - **Output.** Forwarded to DorkOS's log, capped (`LogForwarder`).
 *
 * Only the child this host forked, and the programs its broker spawned, are
 * ever signalled: by the `ChildProcess` objects it holds, never by name or by
 * a process id found any other way.
 *
 * @module services/extensions/isolation/isolated-host
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionIsolation } from '@dorkos/extension-api';
import type { DataProviderContext } from '@dorkos/extension-api/server';
import { CtxDispatcher } from './ctx-dispatcher.js';
import {
  ISOLATION_LIMITS,
  isChildMessage,
  type ChildMessage,
  type HostMessage,
} from './ipc-protocol.js';
import { CHILD_ENTRY_FILE } from './child-entry.js';
import {
  ancestorsOf,
  buildChildEnv,
  findEscapingLink,
  isolatedFilesDir,
  isolatedRunDir,
  isWithin,
  selfCheckPassed,
} from './grants.js';
import { LogForwarder, type ForwardLogger } from './log-forwarder.js';
import { boundedMessageSize } from './message-size.js';
import { RunBroker } from './run-broker.js';
import { VirtualSocket } from './virtual-socket.js';
import { requirePersonCopy } from '../inbox/extension-inbox-context.js';

/** Why a start was refused, as a record's `serverError.code`. */
export type IsolatedStartErrorCode =
  'isolation_unavailable' | 'server_start_failed' | 'server_start_timeout';

/** The outcome of {@link IsolatedExtensionHost.start}. */
export type IsolatedStartResult =
  { ok: true } | { ok: false; code: IsolatedStartErrorCode; message: string };

/** How a running child ended. */
export type IsolatedExitReason =
  'stopped' | 'server_crashed' | 'server_out_of_memory' | 'server_unresponsive';

/** What {@link IsolatedHostOptions.onExit} is told. */
export interface IsolatedExit {
  reason: IsolatedExitReason;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** The log the host writes to. */
export interface HostLogger extends ForwardLogger {
  error(message: string): void;
}

/** Timings, overridable by tests so a hang is caught in seconds, not minutes. */
export interface IsolatedHostTimings {
  helloTimeoutMs: number;
  loadTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  stopGraceMs: number;
}

/** What {@link IsolatedExtensionHost} needs. */
export interface IsolatedHostOptions {
  /** The extension id. */
  extensionId: string;
  /** Its display name, for messages a person reads. */
  displayName: string;
  /** The compiled server bundle (CommonJS). */
  bundlePath: string;
  /** The folder the extension runs from (`record.runPath ?? record.path`): its `assets/` is readable. */
  extensionDir: string;
  /** DorkOS's data directory. */
  dorkHome: string;
  /** The isolation view from discovery. */
  isolation: ExtensionIsolation;
  /** DorkOS's own HTTP port, refused to the child on this computer's addresses. */
  dorkosPort: number;
  /** The bootstrap file to fork (`resolveChildEntry`). */
  bootstrapPath: string;
  /** The log. */
  logger: HostLogger;
  /** Called once when a running child exits, for any reason. */
  onExit?: (exit: IsolatedExit) => void;
  /**
   * The extension's REAL ctx (`createDataProviderContext`), which every ctx
   * message from the child is dispatched into. Without it, every ctx message
   * is refused.
   */
  ctx?: DataProviderContext;
  /** Project roots the broker may run programs in. */
  projectRoots?: () => Promise<readonly string[]>;
  /** The Node binary to fork with; `process.execPath` by default. */
  execPath?: string;
  /**
   * Whether `execPath` is an Electron binary that must run as plain Node
   * (`ELECTRON_RUN_AS_NODE=1`). Defaults to whether DorkOS itself runs inside
   * Electron; the packaged-desktop smoke sets it when it forks the app's own
   * helper binary from outside the app.
   */
  electronRunAsNode?: boolean;
  /** Timings (tests). */
  timings?: Partial<IsolatedHostTimings>;
  /**
   * Test seams. `omitPermission` starts the child without the permission model
   * (and its grants) to prove the self-check refuses; `probes` lets the host
   * call the bundle's exported probes.
   */
  testSeams?: { omitPermission?: boolean; probes?: boolean };
}

/** The default timings (spec §9). */
const DEFAULT_TIMINGS: IsolatedHostTimings = {
  helloTimeoutMs: ISOLATION_LIMITS.helloTimeoutMs,
  loadTimeoutMs: 15_000,
  pingIntervalMs: ISOLATION_LIMITS.pingIntervalMs,
  pongTimeoutMs: ISOLATION_LIMITS.pongTimeoutMs,
  stopGraceMs: ISOLATION_LIMITS.stopGraceMs,
};

/** V8's message when a process dies at its heap limit. */
const OOM_MARKER = /heap out of memory|Reached heap limit/i;

/** Messages a child may send per second before the rest are dropped. */
const MAX_MESSAGES_PER_SECOND = 5_000;

/** Below this backlog a paused program's output resumes. */
const DRAIN_LOW_WATER = 100;

/** Hosts with a live child, so DorkOS's own exit can stop them. */
const liveHosts = new Set<IsolatedExtensionHost>();
let exitHookInstalled = false;

/** Stop every live child when DorkOS's process exits (synchronous kills only). */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const host of liveHosts) host.killNow();
  });
}

/**
 * Whether an exit looks like V8's heap-limit abort (SIGABRT on POSIX; a
 * normalized abort code on Windows), so a child that merely PRINTS the marker and exits
 * is still reported as a crash.
 *
 * @param code - The exit code.
 * @param signal - The signal, if one ended it.
 */
function abortedLike(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal === 'SIGABRT' || signal === 'SIGTRAP' || signal === 'SIGILL') return true;
  // Node normalizes its Windows ABORT path to kAbort (134), not any nonzero exit.
  // https://github.com/nodejs/node/blob/v22.x/src/node_exit_code.h
  return process.platform === 'win32' && code === 134;
}

/**
 * Starts, watches and stops one isolated extension's child process.
 */
export class IsolatedExtensionHost {
  private child: ChildProcess | null = null;
  private broker: RunBroker | null = null;
  private stopRequested = false;
  private killReason: IsolatedExitReason | null = null;
  private sawOom = false;
  private exitPromise: Promise<void> | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private pingCount = 0;
  private backlog = 0;
  private drainWaiters: (() => void)[] = [];
  private outstanding = 0;
  private rateWindowStart = 0;
  private rateCount = 0;
  private rateWarned = false;
  private nextProbeId = 1;
  private readonly probes = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly timings: IsolatedHostTimings;
  private readonly filesDir: string;
  private dispatcher: CtxDispatcher | null = null;
  private lastDispatchCounts: Record<string, number> = {};
  private registeredCleanup = false;
  private serving = false;
  private nextCid = 1;
  private readonly connections = new Map<number, VirtualSocket>();

  /**
   * Prepare a host; nothing starts until {@link IsolatedExtensionHost.start}.
   *
   * @param options - See {@link IsolatedHostOptions}.
   */
  constructor(private readonly options: IsolatedHostOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.filesDir = isolatedFilesDir(options.dorkHome, options.extensionId);
  }

  /** The child's process id while it runs (diagnostics only; never used to signal). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Whether a child is running. */
  get running(): boolean {
    return this.child !== null;
  }

  /** Whether the running child's `register()` returned a cleanup function. */
  get hasCleanup(): boolean {
    return this.registeredCleanup;
  }

  /**
   * How many times each ctx member was reached through the real ctx by the
   * current child (or the last one, once it has exited).
   */
  ctxDispatchCounts(): Record<string, number> {
    return this.dispatcher?.dispatchCounts() ?? { ...this.lastDispatchCounts };
  }

  /** Listeners and reverse handlers the current child holds on the real ctx (0 once it exits). */
  get ctxRegistrations(): number {
    return this.dispatcher?.registrations ?? 0;
  }

  /**
   * Start the child. Resolves once its bundle has loaded, or with the reason
   * it was refused (the child, if any, is already killed then).
   */
  async start(): Promise<IsolatedStartResult> {
    if (this.child) throw new Error(`${this.options.extensionId} is already running.`);
    const name = this.options.displayName;
    const unavailable: IsolatedStartResult = {
      ok: false,
      code: 'isolation_unavailable',
      message: `${name} couldn't start with its limits on this computer, so DorkOS left it off.`,
    };

    // 1. The files folder (and its temp folder).
    await fs.mkdir(path.join(this.filesDir, '.tmp'), { recursive: true });
    const filesReal = await fs.realpath(this.filesDir);

    // 2. assets/: readable only when no link inside it leaves it.
    let assetsReal: string | null = null;
    const assetsDir = path.join(this.options.extensionDir, 'assets');
    const assetsStat = await fs.stat(assetsDir).catch(() => null);
    if (assetsStat?.isDirectory()) {
      const extensionReal = await fs.realpath(this.options.extensionDir);
      assetsReal = await fs.realpath(assetsDir);
      const escaping = isWithin(extensionReal, assetsReal)
        ? await findEscapingLink(assetsReal)
        : assetsDir;
      if (escaping) {
        this.options.logger.warn(
          `[Extensions] ${this.options.extensionId}: refused to start, ${escaping} links outside assets/`
        );
        return {
          ok: false,
          // The assets refusal is one way of not being able to run with its
          // limits, so it shares that code (and the app's copy for it), with
          // its own, more specific message.
          code: 'isolation_unavailable',
          message: `${name} couldn't start: its assets folder links outside itself.`,
        };
      }
    }

    // 3. Stage what the child may read into ONE run folder, and grant just
    //    that and the files folder. Node's permission tree (22.x and 24.x)
    //    has a bug: once two grants split at a shared folder, any later grant
    //    passing through that split marks the folder itself readable, so with
    //    three or more grants `/` (or the data directory) could be listed
    //    (`fs.readdirSync('/')` succeeds). Two grants never pass through a
    //    split, and the self-check below proves no ancestor is readable.
    const runDir = isolatedRunDir(this.options.dorkHome, this.options.extensionId);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    const runReal = await fs.realpath(runDir);
    const bootstrapReal = path.join(runReal, CHILD_ENTRY_FILE);
    const bundleReal = path.join(runReal, `${this.options.extensionId}.js`);
    await fs.copyFile(this.options.bootstrapPath, bootstrapReal);
    await fs.copyFile(this.options.bundlePath, bundleReal);
    if (assetsReal) {
      // Copied with links resolved: the scan above proved every link stays
      // inside assets/, and a copy carries no link out of the run folder.
      await fs.cp(assetsReal, path.join(runReal, 'assets'), { recursive: true, dereference: true });
    }
    const reads = [runReal, filesReal];
    if (reads.some((p) => p.includes(',') || p.includes('*'))) {
      this.options.logger.warn(
        `[Extensions] ${this.options.extensionId}: a folder name holds "," or "*", which Node's permission flags can't express safely`
      );
      return unavailable;
    }
    // The omitPermission seam drops the model and its grants together (a grant
    // without --permission is a startup error, which would never reach the
    // self-check the seam exists to prove).
    const execArgv = [
      ...(this.options.testSeams?.omitPermission
        ? []
        : [
            '--permission',
            ...reads.map((p) => `--allow-fs-read=${p}`),
            `--allow-fs-write=${filesReal}`,
          ]),
      `--max-old-space-size=${this.options.isolation.memoryMb}`,
    ];

    // 4. Fork with a scrubbed environment.
    const env = buildChildEnv(
      this.options.extensionId,
      filesReal,
      // eslint-disable-next-line no-restricted-syntax -- locale and time zone are copied from the live environment; nothing else is
      process.env,
      this.options.electronRunAsNode
    );
    this.stopRequested = false;
    this.killReason = null;
    this.sawOom = false;
    this.backlog = 0;
    // The data directory, then every folder above a grant, ride as arguments
    // so the child's self-check can confirm it can read NONE of them (the
    // grants must not have widened, by a Node bug or anything else).
    const dorkHomeReal = await fs
      .realpath(this.options.dorkHome)
      .catch(() => path.resolve(this.options.dorkHome));
    const child = fork(bootstrapReal, [dorkHomeReal, ...ancestorsOf(reads)], {
      execPath: this.options.execPath ?? process.execPath,
      execArgv,
      env,
      cwd: filesReal,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    liveHosts.add(this);
    installExitHook();

    const forwarder = new LogForwarder({
      extensionId: this.options.extensionId,
      logger: this.options.logger,
      onLine: (line, stream) => {
        if (stream === 'stderr' && OOM_MARKER.test(line)) this.sawOom = true;
      },
    });
    forwarder.attach(child.stdout, 'stdout');
    forwarder.attach(child.stderr, 'stderr');

    this.broker = new RunBroker({
      extensionId: this.options.extensionId,
      isolation: this.options.isolation,
      filesDir: filesReal,
      projectRoots: this.options.projectRoots,
      send: (message) => this.send(message),
      whenDrained: () => this.whenDrained(),
      resolve: {
        dorkHome: this.options.dorkHome,
        refusedRoots: [this.options.extensionDir],
      },
      logger: this.options.logger,
    });

    let settleStart: (result: IsolatedStartResult) => void = () => {};
    const started = new Promise<IsolatedStartResult>((resolve) => {
      settleStart = resolve;
    });
    let phase: 'hello' | 'load' | 'register' | 'running' = 'hello';
    const timer = setTimeout(() => {
      if (phase === 'hello') {
        this.options.logger.warn(
          `[Extensions] ${this.options.extensionId}: no self-check within ${this.timings.helloTimeoutMs} ms`
        );
        this.killNow();
        settleStart(unavailable);
      }
    }, this.timings.helloTimeoutMs);
    let loadTimer: NodeJS.Timeout | null = null;

    this.exitPromise = new Promise<void>((resolve) => {
      // 'close', not 'exit': stderr is fully read by then, so the OOM marker is seen.
      child.once('close', (code, signal) => {
        // First: nothing the child registered on the real ctx outlives it.
        if (this.dispatcher) {
          this.lastDispatchCounts = this.dispatcher.dispatchCounts();
          this.dispatcher.close();
          this.dispatcher = null;
        }
        this.registeredCleanup = false;
        // Every open request learns the child is gone: one still waiting for
        // its headers answers 503, one already streaming is cut off.
        this.serving = false;
        for (const socket of this.connections.values()) {
          socket.sever(new Error(`${name} stopped while answering.`));
        }
        this.connections.clear();
        clearTimeout(timer);
        if (loadTimer) clearTimeout(loadTimer);
        this.stopWatchdog();
        this.broker?.killAll();
        this.broker = null;
        this.child = null;
        liveHosts.delete(this);
        for (const waiter of this.drainWaiters.splice(0)) waiter();
        for (const [, probe] of this.probes) {
          probe.reject(new Error(`${name} stopped.`));
        }
        this.probes.clear();
        const reason: IsolatedExitReason = this.stopRequested
          ? 'stopped'
          : (this.killReason ??
            (this.sawOom && abortedLike(code, signal) ? 'server_out_of_memory' : 'server_crashed'));
        if (phase !== 'running') {
          // The first settlement wins: a refusal already reported stays the reason.
          settleStart(
            phase === 'hello'
              ? unavailable
              : {
                  ok: false,
                  code: 'server_start_failed',
                  message: `${name} stopped while starting.`,
                }
          );
        } else {
          this.options.onExit?.({ reason, code, signal });
        }
        resolve();
      });
    });

    child.on('message', (raw: unknown) => {
      if (!this.accept(raw)) return;
      const message = raw as ChildMessage;
      if (phase === 'hello') {
        if (message.type !== 'hello') return;
        clearTimeout(timer);
        if (!selfCheckPassed(message)) {
          this.options.logger.warn(
            `[Extensions] ${this.options.extensionId}: self-check failed on Node ${message.node}: ` +
              JSON.stringify(message.permission)
          );
          settleStart(unavailable);
          phase = 'load';
          this.killNow();
          return;
        }
        phase = 'load';
        if (this.options.ctx) {
          this.dispatcher = new CtxDispatcher({
            extensionId: this.options.extensionId,
            displayName: name,
            ctx: this.options.ctx,
            allowAgents: this.options.isolation.agents,
            send: (m) => this.send(m),
            slots: {
              acquire: () => {
                if (this.outstanding >= ISOLATION_LIMITS.maxOutstandingCalls) return false;
                this.outstanding++;
                return true;
              },
              release: () => {
                this.outstanding = Math.max(0, this.outstanding - 1);
              },
            },
            logger: this.options.logger,
          });
        }
        this.send({
          type: 'init',
          extensionId: this.options.extensionId,
          bundlePath: bundleReal,
          allowNet: [...this.options.isolation.net],
          allowRun: [...this.options.isolation.run],
          dorkosPort: this.options.dorkosPort,
          testSeams: this.options.testSeams?.probes === true,
          ctx: {
            // The run folder: the one place the child can read its own
            // assets/ (and its bundle) from. The extension's source folder
            // is not readable to it, so naming that here would mislead.
            extensionDir: runReal,
            dorkHome: this.options.dorkHome,
            // The real path, exactly as granted: Node's permission model
            // compares path strings, so a write through a symlinked spelling
            // of the same folder (macOS /tmp) would be refused. The same
            // folder createDataProviderContext names, by one helper.
            filesDir: filesReal,
          },
          displayName: name,
          allowAgents: this.options.isolation.agents,
          personRefusal: (() => {
            const copy = requirePersonCopy(name);
            return { error: copy.error, code: copy.code, message: copy.agent };
          })(),
        });
        loadTimer = setTimeout(() => {
          if (phase !== 'load' && phase !== 'register') return;
          this.killNow();
          settleStart({
            ok: false,
            code: 'server_start_timeout',
            message: `${name} took too long to start. Reload it to try again.`,
          });
        }, this.timings.loadTimeoutMs);
        return;
      }
      if (this.routeCtx(message)) return;
      if (phase === 'load') {
        if (message.type !== 'loaded') return;
        if (!message.ok) {
          if (loadTimer) clearTimeout(loadTimer);
          this.options.logger.warn(
            `[Extensions] ${this.options.extensionId}: couldn't load: ${message.error ?? 'unknown error'}`
          );
          this.killNow();
          settleStart({
            ok: false,
            code: 'server_start_failed',
            message: `${name} couldn't start: ${message.error ?? 'its code failed to load'}.`,
          });
          return;
        }
        phase = 'register';
        return;
      }
      if (phase === 'register') {
        if (message.type !== 'registered') return;
        if (loadTimer) clearTimeout(loadTimer);
        if (!message.ok) {
          this.options.logger.warn(
            `[Extensions] ${this.options.extensionId}: register() failed: ${message.error ?? 'unknown error'}`
          );
          this.killNow();
          settleStart({
            ok: false,
            code: 'server_start_failed',
            message: `${name} couldn't start: ${message.error ?? 'its server part failed to start'}.`,
          });
          return;
        }
        this.registeredCleanup = message.hasCleanup;
        phase = 'running';
        this.serving = true;
        this.startWatchdog();
        settleStart({ ok: true });
        return;
      }
      this.onRunningMessage(message);
    });

    const result = await started;
    // A refused start reports only once its child is gone, so `running` is
    // already false and nothing of it outlives the refusal.
    if (!result.ok) await this.exitPromise;
    return result;
  }

  /**
   * Check a raw message from the child before anything reads it: shape, size
   * and rate. A message that fails is dropped and logged.
   *
   * @param raw - What arrived.
   * @returns `true` when the message may be handled.
   */
  private accept(raw: unknown): boolean {
    const t = Date.now();
    if (t - this.rateWindowStart >= 1_000) {
      this.rateWindowStart = t;
      this.rateCount = 0;
      this.rateWarned = false;
    }
    if (++this.rateCount > MAX_MESSAGES_PER_SECOND) {
      if (!this.rateWarned) {
        this.rateWarned = true;
        this.options.logger.warn(
          `[Extensions] ${this.options.extensionId}: too many messages, dropping the rest of this second`
        );
      }
      return false;
    }
    if (!isChildMessage(raw)) {
      this.options.logger.warn(
        `[Extensions] ${this.options.extensionId}: dropped a malformed message`
      );
      return false;
    }
    // Bounded, copy-free estimate; fails closed (see message-size.ts).
    const size = boundedMessageSize(raw, ISOLATION_LIMITS.maxMessageBytes);
    if (size > ISOLATION_LIMITS.maxMessageBytes) {
      this.options.logger.warn(
        `[Extensions] ${this.options.extensionId}: dropped a message over ${ISOLATION_LIMITS.maxMessageBytes} bytes`
      );
      if (raw.type === 'run-spawn') {
        this.send({
          type: 'run-error',
          rid: raw.rid,
          code: 'ERR_EXTENSION_IPC_TOO_LARGE',
          message: 'That message is too large.',
        });
      } else if (raw.type === 'call' || raw.type === 'sub' || raw.type === 'expose') {
        // Answered, so the child's request settles instead of waiting forever.
        this.send({
          type: 'ret',
          id: raw.id,
          ok: false,
          error: {
            name: 'Error',
            message: 'That message is too large.',
            code: 'ERR_EXTENSION_IPC_TOO_LARGE',
          },
        });
      }
      return false;
    }
    return true;
  }

  /**
   * Route a ctx message to the dispatcher (any phase after the self-check:
   * `register()` uses ctx before the child is running).
   *
   * @param message - A checked message.
   * @returns `true` when it was a ctx message (handled or refused).
   */
  private routeCtx(message: ChildMessage): boolean {
    switch (message.type) {
      case 'call':
      case 'emit':
      case 'sub':
      case 'unsub':
      case 'expose':
      case 'unexpose':
      case 'rret':
        break;
      default:
        return false;
    }
    if (this.dispatcher) {
      this.dispatcher.handle(message);
    } else if (message.type === 'call' || message.type === 'sub' || message.type === 'expose') {
      this.send({
        type: 'ret',
        id: message.id,
        ok: false,
        error: { name: 'Error', message: 'This extension has no ctx here.' },
      });
    }
    return true;
  }

  /**
   * Handle a message from a running child.
   *
   * @param message - A checked message.
   */
  private onRunningMessage(message: ChildMessage): void {
    switch (message.type) {
      case 'pong':
        this.lastPongAt = Date.now();
        break;
      case 'run-spawn': {
        if (this.outstanding >= ISOLATION_LIMITS.maxOutstandingCalls) {
          this.send({
            type: 'run-error',
            rid: message.rid,
            code: 'ERR_EXTENSION_TOO_MANY_CALLS',
            message: 'Too many calls at once.',
          });
          break;
        }
        this.outstanding++;
        void this.broker
          ?.handle(message)
          .catch((err: unknown) => {
            this.options.logger.error(
              `[Extensions] ${this.options.extensionId}: program request failed: ${String(err)}`
            );
          })
          .finally(() => {
            this.outstanding--;
          });
        break;
      }
      case 'run-stdin':
      case 'run-kill':
        void this.broker?.handle(message);
        break;
      case 'conn-data':
      case 'conn-end':
      case 'conn-destroy':
        // Only connections this host opened; anything else is dropped.
        this.connections.get(message.cid)?.receive(message);
        break;
      case 'probe-result': {
        const probe = this.probes.get(message.id);
        if (!probe) break;
        this.probes.delete(message.id);
        if (message.ok) probe.resolve(message.value);
        else {
          probe.reject(
            Object.assign(new Error(message.error?.message ?? 'Probe failed.'), {
              code: message.error?.code,
            })
          );
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Send one message to the child, tracking the unwritten backlog. Past
   * 1,000 unwritten messages the child is killed as unresponsive.
   *
   * @param message - The message.
   * @returns `false` when the channel is backed up (or gone).
   */
  private send(message: HostMessage): boolean {
    const child = this.child;
    if (!child || !child.connected) return false;
    this.backlog++;
    if (this.backlog > ISOLATION_LIMITS.maxBacklog) {
      this.options.logger.warn(
        `[Extensions] ${this.options.extensionId}: stopped reading its messages, stopping it`
      );
      this.killReason = 'server_unresponsive';
      this.killNow();
      return false;
    }
    try {
      child.send(message, (err) => {
        this.backlog = Math.max(0, this.backlog - 1);
        if (err) return;
        if (this.backlog <= DRAIN_LOW_WATER && this.drainWaiters.length > 0) {
          for (const waiter of this.drainWaiters.splice(0)) waiter();
        }
      });
    } catch {
      this.backlog = Math.max(0, this.backlog - 1);
      return false;
    }
    return this.backlog <= DRAIN_LOW_WATER;
  }

  /** Resolves once the backlog is low again (or the child is gone). */
  private whenDrained(): Promise<void> {
    if (!this.child || this.backlog <= DRAIN_LOW_WATER) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  /** Ping on an interval; a child silent past the pong timeout is killed. */
  private startWatchdog(): void {
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > this.timings.pongTimeoutMs) {
        this.options.logger.warn(
          `[Extensions] ${this.options.extensionId}: stopped responding, stopping it`
        );
        this.killReason = 'server_unresponsive';
        this.killNow();
        return;
      }
      this.send({ type: 'ping', n: ++this.pingCount });
    }, this.timings.pingIntervalMs);
    this.pingTimer.unref();
  }

  /** Stop pinging. */
  private stopWatchdog(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /**
   * Open a virtual HTTP connection to the child's router (spec §7), for one
   * forwarded request. Refused while the child is not serving (starting,
   * stopping, gone) and past {@link ISOLATION_LIMITS} `maxConnections` open
   * at once.
   *
   * @param onActivity - Called on every frame either way (the idle timer).
   * @returns The host end, or why there is none.
   */
  openConnection(
    onActivity?: () => void
  ): { ok: true; socket: VirtualSocket } | { ok: false; reason: 'not_running' | 'busy' } {
    if (!this.serving || !this.child?.connected) return { ok: false, reason: 'not_running' };
    if (this.connections.size >= ISOLATION_LIMITS.maxConnections) {
      return { ok: false, reason: 'busy' };
    }
    const cid = this.nextCid++;
    const socket = new VirtualSocket({
      cid,
      send: (message) => this.send(message) || this.child !== null,
      onActivity,
      onClose: () => this.connections.delete(cid),
    });
    this.connections.set(cid, socket);
    this.send({ type: 'conn-open', cid });
    return { ok: true, socket };
  }

  /** How many virtual connections are open right now. */
  get openConnections(): number {
    return this.connections.size;
  }

  /**
   * Kill this host's own child immediately, and every program its broker
   * started. Synchronous; safe to call when nothing runs.
   */
  killNow(): void {
    this.broker?.killAll();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  /**
   * Ask the child to stop; kill it if it has not exited within the grace
   * period (3 s). Resolves once it has exited.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopRequested = true;
    this.stopWatchdog();
    this.broker?.killAll();
    const exited = this.exitPromise ?? Promise.resolve();
    this.send({ type: 'stop' });
    const grace = setTimeout(() => this.killNow(), this.timings.stopGraceMs);
    await exited;
    clearTimeout(grace);
  }

  /**
   * Call one of the bundle's exported probes (test seam; only when the host
   * was built with `testSeams.probes`).
   *
   * @param name - The probe.
   * @param args - Its arguments (structured-cloneable).
   */
  probe(name: string, ...args: unknown[]): Promise<unknown> {
    if (!this.options.testSeams?.probes) {
      return Promise.reject(new Error('Probes are a test seam.'));
    }
    if (!this.child) return Promise.reject(new Error('Not running.'));
    const id = this.nextProbeId++;
    return new Promise((resolve, reject) => {
      this.probes.set(id, { resolve, reject });
      this.send({ type: 'probe', id, name, args });
    });
  }
}
