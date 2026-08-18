/**
 * Test double for the server child process.
 *
 * One class covers both spawn paths, because `server-spawn.ts` normalizes them
 * behind the same `ServerChild` shape: Electron's `utilityProcess.fork`
 * (production, `postMessage`) and `child_process.fork` (dev, `send`). The
 * supervisor under test only ever sees that normalized shape, so a single
 * double keeps the two paths honest against each other.
 *
 * Mounted through `./child-process-mock` (for `node:child_process`) and
 * `./electron-mock` (for `utilityProcess`). Both import the class from here
 * rather than sharing a registry: `vi.mock(..., factory)` results are memoized
 * per specifier, so a shared mutable module between them could end up
 * duplicated. Each mock owns its own list of spawned children instead, read
 * through the specifier the test mocked.
 */

/** Options a spawn call was made with, narrowed to what the tests assert on. */
export interface SpawnOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  stdio?: unknown;
  /** Packaged only: the directory the server child starts in (see `server-cwd.ts`). */
  cwd?: string;
}

/**
 * A stream stand-in that actually delivers.
 *
 * `forwardOutputToLog` subscribes to `data` and feeds stderr into the tail the
 * supervisor shows the user, so a test needs to be able to push a line through
 * that same path rather than fake the tail from outside it.
 */
class MockStream {
  private readonly handlers: Array<(chunk: Buffer | string) => void> = [];

  on(event: string, handler: (chunk: Buffer | string) => void): this {
    if (event === 'data') this.handlers.push(handler);
    return this;
  }

  /** Test helper — deliver `text` to every `data` subscriber. */
  write(text: string): void {
    for (const handler of [...this.handlers]) handler(text);
  }

  /** The shape `forwardOutputToLog` expects. */
  asReadable(): NodeJS.ReadableStream {
    return this as unknown as NodeJS.ReadableStream;
  }
}

/**
 * A spawned server child whose exit code, exit timing, `message` traffic and
 * spawn failures are all driven by the test.
 */
export class MockServerProcess {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  /** Messages the supervisor sent down (`{ type: 'shutdown' }`). */
  readonly sent: unknown[] = [];
  /** True once the supervisor called `kill()`. */
  killed = false;
  /**
   * When set, `send`/`postMessage` throws it. Models sending to a child that
   * has already died: a real `ChildProcess` emits an `error` event that throws
   * when nothing is listening.
   */
  sendError: Error | null = null;

  readonly stdout = new MockStream().asReadable();
  private readonly stderrStream = new MockStream();
  readonly stderr = this.stderrStream.asReadable();

  constructor(
    /** The entry script this child was forked with. */
    readonly entry: string,
    /** The options the spawn call passed. */
    readonly options: SpawnOptions
  ) {}

  /** The environment the supervisor composed for this child. */
  get env(): NodeJS.ProcessEnv {
    return this.options.env ?? {};
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) {
      const index = existing.indexOf(listener);
      if (index !== -1) existing.splice(index, 1);
    }
    return this;
  }

  send(msg: unknown): boolean {
    if (this.sendError) throw this.sendError;
    this.sent.push(msg);
    return true;
  }

  /** Electron's `UtilityProcess` name for the same thing. */
  postMessage(msg: unknown): void {
    this.send(msg);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Test helper — the child signalled it finished booting. */
  emitReady(): void {
    this.emit('message', { type: 'ready' });
  }

  /** Test helper — deliver an arbitrary message from the child. */
  emitMessage(msg: unknown): void {
    this.emit('message', msg);
  }

  /**
   * Test helper — the child wrote a complete stderr line, newline included.
   *
   * Convenient, but it is also a lie about real streams: it guarantees every
   * line arrives whole. Use {@link emitStderrChunk} to reproduce a chunk that
   * begins or ends mid-line, which is what actually happens on a pipe.
   */
  emitStderr(text: string): void {
    this.stderrStream.write(`${text}\n`);
  }

  /** Test helper — the child wrote a raw chunk, exactly as given. */
  emitStderrChunk(chunk: string): void {
    this.stderrStream.write(chunk);
  }

  /** Test helper — the child exited. `null` models death by signal. */
  emitExit(code: number | null): void {
    this.emit('exit', code);
  }

  /** Test helper — the spawn itself failed (missing/unspawnable executable). */
  emitError(err: Error): void {
    this.emit('error', err);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}
