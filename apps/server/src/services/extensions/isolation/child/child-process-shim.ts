/**
 * `child_process` for an isolated extension (DOR-2686, spec §6): the same
 * asynchronous API, backed by the host's program broker.
 *
 * The child has no `--allow-child-process` (it is all-or-nothing), so it
 * cannot start anything itself. When the bundle asks for `child_process`, the
 * bootstrap hands it this module instead. `spawn`, `execFile` and `exec` send
 * a `run-spawn` request; the host runs the program only if it is in
 * `allow.run`, and streams its output back. Reaching the real module some
 * other way gets `ERR_ACCESS_DENIED` from Node.
 *
 * Differences from Node's module, all deliberate:
 *
 * - `execSync`, `execFileSync`, `spawnSync` and `fork` throw: a synchronous
 *   call cannot wait on an asynchronous channel without a worker, and workers
 *   are denied.
 * - `pid` is set when the host reports the program started, a moment after
 *   `spawn` returns, rather than synchronously.
 * - `exec` and `spawn(…, { shell: true })` run the platform shell (`sh`, or
 *   `cmd` on Windows), so that shell must be in `allow.run` itself.
 * - `stdio` supports `'pipe'` and `'ignore'` for standard input only; output
 *   always arrives as streams.
 *
 * @module services/extensions/isolation/child/child-process-shim
 */
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import type { HostMessage, RunSpawnMessage } from '../ipc-protocol.js';
import { SYNC_RUN_REFUSAL } from '../ipc-protocol.js';

/** How the shim reaches the host. */
export interface ShimChannel {
  /** Send one message to the host. */
  send(message: RunSpawnMessage | { type: 'run-stdin' | 'run-kill'; [key: string]: unknown }): void;
}

/** What the shim needs to know at start. */
export interface ShimOptions {
  /** The platform, which decides the shell. */
  platform: NodeJS.Platform;
  /** The `allow.run` list, so `exec` can name the shell the way it was declared. */
  allowRun: readonly string[];
}

/** Options `spawn` reads. */
interface SpawnOptions {
  cwd?: string | URL;
  env?: Record<string, unknown>;
  shell?: boolean | string;
  stdio?: unknown;
}

/** Options `execFile` and `exec` read. */
interface ExecOptions extends SpawnOptions {
  encoding?: BufferEncoding | 'buffer' | null;
  maxBuffer?: number;
  timeout?: number;
  killSignal?: string;
}

type ExecCallback = (
  err: (Error & Record<string, unknown>) | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;

/** Default `maxBuffer` for `execFile`/`exec`, as Node's. */
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * A program the host runs for the extension, shaped like Node's
 * `ChildProcess`: `stdout`/`stderr` streams, a `stdin` stream (or `null`),
 * `kill()`, and `spawn`, `exit`, `close` and `error` events.
 */
export class BrokeredChildProcess extends EventEmitter {
  /** The program's process id on the host, once it has started. */
  pid: number | undefined = undefined;
  /** Its exit code, once it has exited normally. */
  exitCode: number | null = null;
  /** The signal that ended it, if one did. */
  signalCode: string | null = null;
  /** Whether `kill()` has been called. */
  killed = false;
  /** Its standard output. */
  readonly stdout: Readable;
  /** Its standard error. */
  readonly stderr: Readable;
  /** Its standard input, or `null` when ignored. */
  readonly stdin: Writable | null;
  /** The file and arguments, as Node exposes them. */
  readonly spawnfile: string;
  /** All arguments, starting with the file. */
  readonly spawnargs: string[];

  private ended = false;

  /**
   * Make the stand-in for one program request.
   *
   * @param rid - The request id.
   * @param file - The program.
   * @param args - Its arguments.
   * @param withStdin - Whether standard input is a stream.
   * @param channel - The way to the host.
   */
  constructor(
    readonly rid: number,
    file: string,
    args: string[],
    withStdin: boolean,
    private readonly channel: ShimChannel
  ) {
    super();
    this.spawnfile = file;
    this.spawnargs = [file, ...args];
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.stdin = withStdin
      ? new Writable({
          write: (chunk: Buffer, _encoding, callback) => {
            channel.send({ type: 'run-stdin', rid, chunk: new Uint8Array(chunk) });
            callback();
          },
          final: (callback) => {
            channel.send({ type: 'run-stdin', rid, chunk: null });
            callback();
          },
        })
      : null;
  }

  /**
   * Ask the host to stop the program.
   *
   * @param signal - The signal, `SIGTERM` by default.
   * @returns `true` when the program was still running.
   */
  kill(signal: string | number = 'SIGTERM'): boolean {
    if (this.ended) return false;
    this.killed = true;
    this.channel.send({
      type: 'run-kill',
      rid: this.rid,
      signal: typeof signal === 'string' ? signal : null,
    });
    return true;
  }

  /**
   * Route one host message about this program.
   *
   * @param message - A `run-*` message for this request id.
   * @internal
   */
  receive(message: HostMessage): void {
    switch (message.type) {
      case 'run-spawned':
        this.pid = message.pid;
        this.emit('spawn');
        break;
      case 'run-data':
        (message.stream === 'stdout' ? this.stdout : this.stderr).push(
          Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength)
        );
        break;
      case 'run-exit':
        this.finish();
        this.exitCode = message.code;
        this.signalCode = message.signal;
        this.emit('exit', message.code, message.signal);
        this.emit('close', message.code, message.signal);
        break;
      case 'run-error': {
        this.finish();
        const err = Object.assign(new Error(message.message), { code: message.code });
        this.emit('error', err);
        this.emit('close', null, null);
        break;
      }
      default:
        break;
    }
  }

  /** End the output streams once. */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.stdout.push(null);
    this.stderr.push(null);
  }
}

/**
 * Normalize Node's `(file, args?, options?)` and `(file, options?)` forms.
 *
 * @param args - What the caller passed after the file.
 */
function readArgs(args: unknown[]): { list: string[]; options: ExecOptions; rest: unknown[] } {
  let i = 0;
  let list: string[] = [];
  if (Array.isArray(args[i])) {
    list = (args[i] as unknown[]).map((a) => String(a));
    i++;
  }
  let options: ExecOptions = {};
  if (args[i] && typeof args[i] === 'object') {
    options = args[i] as ExecOptions;
    i++;
  }
  return { list, options, rest: args.slice(i) };
}

/**
 * Turn an environment into strings, as Node does, dropping `undefined`.
 *
 * @param env - The caller's environment.
 */
function stringEnv(env: Record<string, unknown> | undefined): Record<string, string> | null {
  if (!env) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}

/**
 * Build the `child_process` replacement for one isolated extension.
 *
 * @param channel - The way to the host.
 * @param options - The platform and the declared `allow.run` list.
 * @returns The module the bundle sees, plus a router for host messages.
 */
export function createChildProcessShim(
  channel: ShimChannel,
  options: ShimOptions
): {
  module: Record<string, unknown>;
  receive(message: HostMessage): void;
} {
  const running = new Map<number, BrokeredChildProcess>();
  let nextRid = 1;

  /** The shell `exec` runs, named the way `allow.run` declares it. */
  const shell = (): { file: string; args: (command: string) => string[] } => {
    if (options.platform === 'win32') {
      const file = options.allowRun.find((e) => /^cmd(\.exe)?$/i.test(e)) ?? 'cmd';
      return { file, args: (command) => ['/d', '/s', '/c', `"${command}"`] };
    }
    const file = options.allowRun.find((e) => e === 'sh' || e === '/bin/sh') ?? 'sh';
    return { file, args: (command) => ['-c', command] };
  };

  const spawn = (file: string, ...rest: unknown[]): BrokeredChildProcess => {
    if (typeof file !== 'string' || file.length === 0) {
      throw new TypeError('The "file" argument must be a non-empty string.');
    }
    const { list, options: opts } = readArgs(rest);
    let program = file;
    let args = list;
    if (opts.shell) {
      const sh = shell();
      program = sh.file;
      args = sh.args([file, ...list].join(' '));
    }
    const stdio = opts.stdio;
    const stdinIgnored =
      stdio === 'ignore' || (Array.isArray(stdio) && (stdio[0] === 'ignore' || stdio[0] === null));
    const rid = nextRid++;
    const child = new BrokeredChildProcess(rid, program, args, !stdinIgnored, channel);
    running.set(rid, child);
    child.once('close', () => running.delete(rid));
    const cwd = opts.cwd instanceof URL ? opts.cwd.pathname : (opts.cwd ?? null);
    channel.send({
      type: 'run-spawn',
      rid,
      file: program,
      args,
      cwd: typeof cwd === 'string' ? cwd : null,
      env: stringEnv(opts.env),
      stdin: !stdinIgnored,
    });
    return child;
  };

  const execFile = (file: string, ...rest: unknown[]): BrokeredChildProcess => {
    const { list, options: opts, rest: tail } = readArgs(rest);
    const callback = tail.find((a) => typeof a === 'function') as ExecCallback | undefined;
    const child = spawn(file, list, { ...opts, shell: opts.shell });
    const encoding = opts.encoding === undefined ? 'utf8' : opts.encoding;
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => child.kill(opts.killSignal ?? 'SIGTERM'), opts.timeout);
    }
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer && !overflow) {
        overflow = true;
        child.kill(opts.killSignal ?? 'SIGTERM');
      }
      if (!overflow) sink.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const render = (chunks: Buffer[]): string | Buffer => {
      const buffer = Buffer.concat(chunks);
      return encoding === 'buffer' || encoding === null ? buffer : buffer.toString(encoding);
    };
    let done = false;
    const finish = (error: (Error & Record<string, unknown>) | null): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      callback?.(error, render(out), render(err));
    };
    child.once('error', (e: Error) => finish(e as Error & Record<string, unknown>));
    child.once('close', (code: number | null, signal: string | null) => {
      if (code === 0 && !overflow) return finish(null);
      const command = [file, ...list].join(' ');
      const stderrText = Buffer.concat(err).toString('utf8');
      const details: Record<string, unknown> = overflow
        ? { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', cmd: command }
        : { code, killed: child.killed, signal, cmd: command };
      const e: Error & Record<string, unknown> = Object.assign(
        new Error(
          overflow
            ? 'stdout maxBuffer length exceeded'
            : `Command failed: ${command}\n${stderrText}`
        ),
        details
      );
      finish(e);
    });
    return child;
  };

  const exec = (command: string, ...rest: unknown[]): BrokeredChildProcess => {
    const opts = (rest[0] && typeof rest[0] === 'object' ? rest[0] : {}) as ExecOptions;
    const callback = rest.find((a) => typeof a === 'function');
    const sh = shell();
    return execFile(sh.file, sh.args(command), { ...opts, shell: false }, callback);
  };

  /** The promise forms `util.promisify` uses, resolving `{ stdout, stderr }` as Node's do. */
  const promiseForm =
    (fn: (...a: unknown[]) => BrokeredChildProcess) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, stdout: unknown, stderr: unknown) => {
          if (err) reject(Object.assign(err, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      });
  Object.defineProperty(execFile, promisify.custom, {
    value: promiseForm(execFile as (...a: unknown[]) => BrokeredChildProcess),
  });
  Object.defineProperty(exec, promisify.custom, {
    value: promiseForm(exec as (...a: unknown[]) => BrokeredChildProcess),
  });

  const refuseSync = (): never => {
    throw Object.assign(new Error(SYNC_RUN_REFUSAL), { code: 'ERR_EXTENSION_SYNC_RUN' });
  };

  const shimModule: Record<string, unknown> = {
    spawn,
    execFile,
    exec,
    execSync: refuseSync,
    execFileSync: refuseSync,
    spawnSync: refuseSync,
    fork: refuseSync,
    ChildProcess: BrokeredChildProcess,
  };
  shimModule.default = shimModule;

  return {
    module: shimModule,
    receive(message) {
      if (
        message.type !== 'run-spawned' &&
        message.type !== 'run-data' &&
        message.type !== 'run-exit' &&
        message.type !== 'run-error'
      ) {
        return;
      }
      running.get(message.rid)?.receive(message);
    },
  };
}
