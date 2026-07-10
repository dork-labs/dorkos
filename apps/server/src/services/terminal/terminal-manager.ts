import { randomUUID } from 'crypto';
import * as pty from 'node-pty';
import {
  TERMINAL_CLOSE_SUPERSEDED,
  TERMINAL_CLOSE_SUPERSEDED_REASON,
  type TerminalSize,
} from '@dorkos/shared/terminal-schemas';
import { validateBoundary } from '../../lib/boundary.js';
import { logger } from '../../lib/logger.js';
import { ensureSpawnHelperExecutable } from './spawn-helper-fix.js';

/**
 * Embedded-terminal PTY lifecycle (spec right-panel-workbench, Chunk E;
 * ADR 260708-185521). Owns one `node-pty` process per terminal-session id,
 * spawned in a boundary-confined working directory, and pipes its raw byte
 * stream to an attached socket. The `node-pty` import is confined to this
 * directory by ESLint, mirroring the runtime-SDK confinement rule.
 *
 * @module services/terminal/terminal-manager
 */

/** Idle grace period after the last socket detaches before the PTY is killed. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Cap on output buffered before a socket attaches, so a chatty shell can't grow unbounded. */
const PENDING_MAX_BYTES = 1024 * 1024;
/**
 * Dim in-band notice prepended to a replay when the detached buffer overflowed
 * and dropped output — an honest cue that the scrollback the client is about to
 * receive is incomplete. Emitted by the server (the only party that knows the
 * cap was hit) as the first replayed frame, so it lands after the client's own
 * `[reconnected]` cue and before the surviving buffered output.
 */
const TRUNCATION_NOTICE = '\x1b[2m[some output was lost while disconnected]\x1b[0m\r\n';
/** Fallback viewport when the client creates a terminal without an initial size. */
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };
/**
 * Cap on concurrently live PTYs (DoS guard). Each PTY is a real shell plus up to
 * {@link PENDING_MAX_BYTES} of pre-attach buffer reclaimed only on idle/exit
 * teardown, so unbounded creation is a local resource-exhaustion vector. 24 is
 * far more terminals than an operator realistically opens at once, while still
 * bounding the blast radius. Exceeding it rejects with {@link TerminalLimitError}.
 */
const DEFAULT_MAX_TERMINALS = 24;

/**
 * Thrown by {@link TerminalManager.create} when the live-PTY cap is reached. The
 * terminal route maps it to HTTP 429 (Too Many Requests).
 */
export class TerminalLimitError extends Error {
  constructor(max: number) {
    super(`Terminal limit reached (${max} live terminals)`);
    this.name = 'TerminalLimitError';
  }
}

/**
 * The minimal PTY surface the manager depends on — a structural subset of
 * node-pty's `IPty`. Declaring it explicitly lets unit tests inject a mock PTY
 * instead of spawning a real shell.
 */
export interface PtyLike {
  /** Process id of the spawned shell. */
  readonly pid: number;
  /** Subscribe to decoded output chunks. */
  onData(listener: (data: string) => void): void;
  /** Subscribe to process exit. */
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  /** Write input to the PTY stdin. */
  write(data: string): void;
  /** Resize the PTY viewport. */
  resize(cols: number, rows: number): void;
  /** Terminate the PTY. */
  kill(signal?: string): void;
}

/** Options for spawning a PTY — the injectable seam for the manager. */
export interface SpawnPtyOptions {
  /** Shell executable to run. */
  shell: string;
  /** Working directory (already boundary-validated). */
  cwd: string;
  /** Initial column count. */
  cols: number;
  /** Initial row count. */
  rows: number;
  /** Environment for the shell. */
  env: Record<string, string>;
}

/** A PTY factory. Defaults to node-pty; overridden in tests with a mock. */
export type SpawnPty = (opts: SpawnPtyOptions) => PtyLike;

/**
 * A sink the manager writes PTY output to and can close. Adapted from a real
 * WebSocket by the WS wiring; kept minimal so the manager needs no `ws` types.
 */
export interface TerminalSink {
  /** Deliver an output frame to the client. */
  send(data: Uint8Array): void;
  /**
   * Close the underlying connection. An optional WebSocket close `code` and
   * `reason` are threaded through so a takeover (a superseding attach) can be
   * distinguished from an ordinary teardown client-side — see
   * {@link TERMINAL_CLOSE_SUPERSEDED}.
   */
  close(code?: number, reason?: string): void;
}

/** Live state for one terminal-session id. */
interface TerminalInstance {
  id: string;
  cwd: string;
  pty: PtyLike;
  sink: TerminalSink | null;
  /** Output buffered while no sink is attached (bounded by PENDING_MAX_BYTES). */
  pending: Uint8Array[];
  pendingBytes: number;
  /**
   * Set when the detached buffer overflowed and dropped output, so the next
   * attach can lead its replay with {@link TRUNCATION_NOTICE}; reset once the
   * cue has been emitted.
   */
  truncated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
}

/** Resolve the interactive shell for the host platform. */
function resolveShell(): string {
  // The user's login shell is a raw OS environment value, not part of the app's
  // validated env.ts schema — read it directly.
  if (process.platform === 'win32') {
    // eslint-disable-next-line no-restricted-syntax -- OS shell path, not an app env var
    return process.env.COMSPEC ?? 'powershell.exe';
  }
  // eslint-disable-next-line no-restricted-syntax -- OS shell path, not an app env var
  return process.env.SHELL ?? 'bash';
}

/** The default node-pty-backed spawn. */
const nodePtySpawn: SpawnPty = ({ shell, cwd, cols, rows, env }) =>
  pty.spawn(shell, [], { name: 'xterm-256color', cwd, cols, rows, env });

/**
 * Manages the lifecycle of embedded-terminal PTYs. One instance is created at
 * server startup and shared by the terminal routes and the WebSocket handler.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalInstance>();
  private readonly spawn: SpawnPty;
  private readonly idleTimeoutMs: number;
  private readonly boundary: string | undefined;
  private readonly maxTerminals: number;
  private readonly pendingMaxBytes: number;

  /**
   * Construct a terminal manager.
   *
   * @param opts - `spawn` injects a mock PTY factory in tests; `idleTimeoutMs`
   *   overrides the idle-teardown grace period; `boundary` overrides the path
   *   boundary (defaults to the process-wide initialized boundary);
   *   `maxTerminals` overrides the concurrent-PTY cap; `pendingMaxBytes`
   *   overrides the detached-output buffer cap (tests shrink it to exercise
   *   truncation without buffering a megabyte).
   */
  constructor(
    opts: {
      spawn?: SpawnPty;
      idleTimeoutMs?: number;
      boundary?: string;
      maxTerminals?: number;
      pendingMaxBytes?: number;
    } = {}
  ) {
    this.spawn = opts.spawn ?? nodePtySpawn;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.boundary = opts.boundary;
    this.maxTerminals = opts.maxTerminals ?? DEFAULT_MAX_TERMINALS;
    this.pendingMaxBytes = opts.pendingMaxBytes ?? PENDING_MAX_BYTES;
  }

  /**
   * Create a PTY in `cwd` (confined to the boundary) and return its id. The id
   * is used to attach the WebSocket and to tear the terminal down.
   *
   * @param req - Target working directory and optional initial viewport.
   * @throws BoundaryError when `cwd` escapes the directory boundary.
   * @throws TerminalLimitError when the concurrent-PTY cap is reached.
   */
  async create(req: { cwd: string; size?: TerminalSize }): Promise<string> {
    // DoS guard — refuse before doing any work once the live-PTY cap is hit.
    if (this.terminals.size >= this.maxTerminals) {
      throw new TerminalLimitError(this.maxTerminals);
    }

    // Boundary double-check — a terminal is a shell in this directory, so the
    // same confinement the file routes use applies before we spawn anything.
    const resolvedCwd = await validateBoundary(req.cwd, this.boundary);

    // node-pty 1.1.0 ships a non-executable spawn-helper; fix it before the
    // first fork (see spawn-helper-fix.ts).
    ensureSpawnHelperExecutable();

    const id = randomUUID();
    const size = req.size ?? DEFAULT_SIZE;
    const shell = resolveShell();
    const child = this.spawn({
      shell,
      cwd: resolvedCwd,
      cols: size.cols,
      rows: size.rows,
      env: buildTerminalEnv(),
    });

    const instance: TerminalInstance = {
      id,
      cwd: resolvedCwd,
      pty: child,
      sink: null,
      pending: [],
      pendingBytes: 0,
      truncated: false,
      idleTimer: null,
      disposed: false,
    };
    this.terminals.set(id, instance);

    child.onData((data) => this.handleData(instance, data));
    child.onExit(() => this.destroy(id));

    // Start the idle timer immediately; attaching a socket clears it.
    this.armIdleTimer(instance);
    logger.info('[terminal] spawned PTY', { id, cwd: resolvedCwd, pid: child.pid });
    return id;
  }

  /** Whether a terminal with this id exists (used to gate socket upgrades). */
  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /**
   * Attach a sink (the client's socket) to a terminal, flushing any output that
   * arrived before it connected. Replaces an existing sink if one is attached.
   *
   * @param id - Terminal id.
   * @param sink - The output sink to attach.
   */
  attach(id: string, sink: TerminalSink): void {
    const inst = this.terminals.get(id);
    if (!inst) {
      sink.close();
      return;
    }
    // Replacing a live sink is a takeover (e.g. a duplicated tab re-attaching to
    // the same id). Close the incumbent with a distinct app code so its client
    // can tell "moved to another window" from "the shell exited" and keep the
    // tab instead of pruning it.
    if (inst.sink && inst.sink !== sink) {
      inst.sink.close(TERMINAL_CLOSE_SUPERSEDED, TERMINAL_CLOSE_SUPERSEDED_REASON);
    }
    inst.sink = sink;
    this.clearIdleTimer(inst);
    // Lead the replay with the truncation cue if output was dropped while
    // detached, then reset the flag — the cue is emitted exactly once per gap.
    if (inst.truncated) {
      sink.send(Buffer.from(TRUNCATION_NOTICE, 'utf8'));
      inst.truncated = false;
    }
    // Flush buffered output captured before the socket connected.
    for (const chunk of inst.pending) sink.send(chunk);
    inst.pending = [];
    inst.pendingBytes = 0;
  }

  /**
   * Detach a sink (on socket close). Starts the idle timer so an abandoned
   * terminal is eventually reclaimed.
   *
   * @param id - Terminal id.
   * @param sink - The sink being detached; ignored if it is no longer current.
   */
  detach(id: string, sink: TerminalSink): void {
    const inst = this.terminals.get(id);
    if (!inst || inst.sink !== sink) return;
    inst.sink = null;
    this.armIdleTimer(inst);
  }

  /**
   * Write input to a terminal's PTY.
   *
   * @param id - Terminal id.
   * @param data - UTF-8 input to forward to the shell.
   */
  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data);
  }

  /**
   * Resize a terminal's PTY viewport.
   *
   * @param id - Terminal id.
   * @param size - New viewport dimensions in character cells.
   */
  resize(id: string, size: TerminalSize): void {
    this.terminals.get(id)?.pty.resize(size.cols, size.rows);
  }

  /**
   * Tear down a terminal: kill the PTY, close the sink, and forget the id.
   * Idempotent.
   *
   * @param id - Terminal id.
   */
  destroy(id: string): void {
    const inst = this.terminals.get(id);
    if (!inst || inst.disposed) return;
    inst.disposed = true;
    this.clearIdleTimer(inst);
    this.terminals.delete(id);
    try {
      inst.pty.kill();
    } catch (err) {
      logger.warn('[terminal] error killing PTY', { id, err });
    }
    inst.sink?.close();
    logger.info('[terminal] destroyed PTY', { id });
  }

  /** Kill every PTY — called on server shutdown. */
  destroyAll(): void {
    for (const id of [...this.terminals.keys()]) this.destroy(id);
  }

  /** Buffer output when no sink is attached; forward it when one is. */
  private handleData(inst: TerminalInstance, data: string): void {
    const bytes = Buffer.from(data, 'utf8');
    if (inst.sink) {
      inst.sink.send(bytes);
      return;
    }
    if (inst.pendingBytes >= this.pendingMaxBytes) {
      // Buffer full: drop this (newest) chunk and flag the gap so the next attach
      // tells the user their scrollback is incomplete.
      inst.truncated = true;
      return;
    }
    inst.pending.push(bytes);
    inst.pendingBytes += bytes.byteLength;
  }

  private armIdleTimer(inst: TerminalInstance): void {
    this.clearIdleTimer(inst);
    inst.idleTimer = setTimeout(() => {
      logger.info('[terminal] idle teardown', { id: inst.id });
      this.destroy(inst.id);
    }, this.idleTimeoutMs);
    // Do not keep the process alive solely for an idle terminal timer.
    inst.idleTimer.unref?.();
  }

  private clearIdleTimer(inst: TerminalInstance): void {
    if (inst.idleTimer) {
      clearTimeout(inst.idleTimer);
      inst.idleTimer = null;
    }
  }
}

/**
 * Build the environment for a spawned shell: inherit the server's env, then set
 * the terminal-identifying vars xterm expects.
 */
function buildTerminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // The spawned shell inherits the full OS environment; this is the process
  // environment itself, not an app config value, so env.ts does not apply.
  // eslint-disable-next-line no-restricted-syntax -- forwarding the whole OS env to the child shell
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
