/**
 * An in-memory `codex app-server` for tests (spec `codex-app-server-transport`
 * §17). It speaks the wire protocol over PassThrough pipes and is injected
 * through the process pool's `spawn` seam, so everything above the pipes — the
 * JSON-RPC client, the pool, the loader, the transport and the runtime — runs
 * for real.
 *
 * It is not a mock that answers whatever the test hopes. It enforces the two
 * behaviours of the real 0.154 binary that are easiest to assume away:
 *
 * - **The joining trap.** `turn/start` on a thread whose turn is still running
 *   does NOT start a turn: it steers into the running one and answers with the
 *   EXISTING turn id, with no `turn/started` (protocol §3).
 * - **Loaded config is immutable.** `thread/resume` on a thread already loaded
 *   in this process answers success and IGNORES the new `config` (spike 1b);
 *   only a cold load in a new process applies it. And a thread with no turn yet
 *   has no rollout, so a cold resume or a fork of it answers `no rollout found`.
 *
 * A {@link FakeCodexHome} is the disk: threads and rollouts outlive one
 * process, the way `$CODEX_HOME/sessions` does. Each spawned
 * {@link FakeAppServer} is one process: what it has loaded dies with it.
 *
 * Turns run a script ({@link FakeTurnScript}); the default one streams "pong"
 * and completes. Scripts can stream, park until interrupted, never answer an
 * interrupt, send a server request and wait for the reply, or crash the
 * process.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';

/** The `method` a client's reply to a server request is recorded under in `received`. */
export const REPLY = '<reply>';

/** What one spawn was given. */
export interface FakeSpawnRecord {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string | undefined;
}

/** One thread as the home knows it. */
export interface FakeThreadRecord {
  readonly id: string;
  /** Whether a turn has run, so a rollout exists and the thread can be resumed. */
  hasRollout: boolean;
}

/** One thread as a process has it loaded. */
export interface FakeLoadedThread {
  readonly id: string;
  /** The params it was loaded with: fixed for its loaded life. */
  readonly loadParams: Record<string, unknown>;
  /** The running turn, if any. */
  activeTurn: FakeTurn | undefined;
  /** Every turn/start params object it received. */
  readonly turnStarts: Array<Record<string, unknown>>;
}

/** One running turn. */
export interface FakeTurn {
  readonly id: string;
  readonly threadId: string;
  /** Resolves when the turn is interrupted. */
  readonly interrupted: Promise<void>;
  /** Text steered into the turn by a joined `turn/start`. */
  readonly steered: string[];
  done: boolean;
}

/** What a turn script can do. */
export interface FakeTurnContext {
  readonly turn: FakeTurn;
  readonly server: FakeAppServer;
  /** The `turn/start` params. */
  readonly params: Record<string, unknown>;
  /** Send a notification scoped to this turn's thread. */
  emit(method: string, params: Record<string, unknown>): void;
  /** Stream an agent message in deltas, then complete the item. */
  agentMessage(text: string, deltas?: string[]): void;
  /** Report token usage for this turn. */
  tokenUsage(lastTotal: number, window: number, totalOutput?: number): void;
  /** End the turn. */
  complete(status?: 'completed' | 'failed' | 'interrupted', error?: Record<string, unknown>): void;
  /**
   * Send a server → client request and wait for the reply. Like the binary,
   * `serverRequest/resolved` follows the reply.
   */
  serverRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Wait for the next macrotask (lets the client consume what was sent). */
  tick(): Promise<void>;
}

/** A turn's behaviour. */
export type FakeTurnScript = (ctx: FakeTurnContext) => void | Promise<void>;

/** The default turn: "pong", usage, completed. */
export const pongTurn: FakeTurnScript = (ctx) => {
  ctx.agentMessage('pong', ['po', 'ng']);
  ctx.tokenUsage(1200, 200_000, 40);
  ctx.complete('completed');
};

/** A turn that streams one word, then runs until it is interrupted. */
export const parkedTurn: FakeTurnScript = async (ctx) => {
  ctx.emit('item/agentMessage/delta', { itemId: 'msg-parked', delta: 'working' });
  await ctx.turn.interrupted;
  ctx.complete('interrupted');
};

/** The command the approval turn asks to run. */
export const APPROVAL_COMMAND = 'touch made.txt';

/**
 * A turn that asks before running a command, the way 0.154 does (verified on
 * the binary): `item/started` for the command, then the approval request.
 * Approved, the command runs; declined, it is reported declined; cancelled
 * (a stop), the turn waits for its interrupt.
 */
export const approvalTurn: FakeTurnScript = async (ctx) => {
  const item = {
    type: 'commandExecution',
    id: 'cmd-approval',
    command: APPROVAL_COMMAND,
    cwd: String(ctx.params.cwd ?? '/project'),
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [{ type: 'unknown', command: APPROVAL_COMMAND }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  ctx.emit('item/started', { item, startedAtMs: Date.now() });
  const reply = (await ctx.serverRequest('item/commandExecution/requestApproval', {
    kind: 'command',
    itemId: item.id,
    startedAtMs: Date.now(),
    reason: 'Create made.txt?',
    command: APPROVAL_COMMAND,
    cwd: item.cwd,
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
  })) as { decision?: unknown };
  if (reply.decision === 'cancel') {
    await ctx.turn.interrupted;
    ctx.emit('item/completed', { item: { ...item, status: 'declined' } });
    ctx.complete('interrupted');
    return;
  }
  const ran = reply.decision === 'accept' || reply.decision === 'acceptForSession';
  ctx.emit('item/completed', {
    item: {
      ...item,
      status: ran ? 'completed' : 'declined',
      exitCode: ran ? 0 : null,
      aggregatedOutput: ran ? 'made' : null,
    },
  });
  ctx.agentMessage(ran ? 'made it' : 'left it alone');
  ctx.complete('completed');
};

/** A turn that runs and never acknowledges an interrupt (C11's hang). */
export const hangingTurn: FakeTurnScript = async (ctx) => {
  ctx.emit('item/agentMessage/delta', { itemId: 'msg-hang', delta: 'working' });
  await new Promise(() => {});
};

/** The disk under one `CODEX_HOME`, shared by every process spawned on it. */
export class FakeCodexHome {
  readonly threads = new Map<string, FakeThreadRecord>();
  /** `config.toml`'s `[projects]` table: path → trust_level. */
  readonly projects: Record<string, { trust_level: string }> = {};
  /** Turn scripts, consumed in order; the default runs when empty. */
  readonly scripts: FakeTurnScript[] = [];
  /** The script that runs when none is queued. */
  defaultScript: FakeTurnScript = pongTurn;
  /** Every process ever spawned on this home. */
  readonly processes: FakeAppServer[] = [];

  /** Queue the script for the next turn any process on this home starts. */
  nextTurn(script: FakeTurnScript): void {
    this.scripts.push(script);
  }
}

/**
 * The spawn seam: one {@link FakeCodexHome} per `CODEX_HOME` value, one
 * {@link FakeAppServer} per spawn.
 */
export class FakeAppServerHost {
  readonly spawns: FakeSpawnRecord[] = [];
  private readonly homes = new Map<string, FakeCodexHome>();

  /** The home for a `CODEX_HOME` (created on first use). */
  home(codexHome = 'default'): FakeCodexHome {
    let home = this.homes.get(codexHome);
    if (!home) {
      home = new FakeCodexHome();
      this.homes.set(codexHome, home);
    }
    return home;
  }

  /** Every process spawned across every home. */
  get processes(): FakeAppServer[] {
    return [...this.homes.values()].flatMap((home) => home.processes);
  }

  /** Spawn a fake process; the signature of the pool's seam. */
  spawn = (
    binary: string,
    args: readonly string[],
    options: { env?: Record<string, string | undefined>; cwd?: string | undefined }
  ): FakeAppServer => {
    const env = options.env ?? {};
    this.spawns.push({ binary, args: [...args], env: { ...env }, cwd: options.cwd });
    const home = this.home(env.CODEX_HOME ?? 'default');
    const server = new FakeAppServer(home);
    home.processes.push(server);
    return server;
  };
}

let pidCounter = 40_000;

/** One fake `codex app-server` process. */
export class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = ++pidCounter;
  /** Every request and notification received, in order. */
  readonly received: Array<{ id?: number | string; method: string; params?: unknown }> = [];
  /** Threads this process has loaded. */
  readonly loaded = new Map<string, FakeLoadedThread>();
  /** Replies to server requests this process sent, by request id. */
  readonly replies = new Map<number | string, unknown>();
  /** Threads a client unsubscribed from. */
  readonly unsubscribed = new Set<string>();
  /** Background terminals each thread reports as still running. */
  readonly backgroundTerminals = new Map<string, unknown[]>();
  /** Exit (as a crash) instead of answering the next `turn/start`. */
  exitOnTurnStart = false;
  /** Hold every `turn/start` answer until this settles. */
  turnStartGate: Promise<void> | undefined;
  /** Set to refuse every request with `Server overloaded` this many times. */
  overloadNext = 0;
  /** Signals passed to `kill`. */
  readonly killSignals: string[] = [];
  exitCode: number | null = null;
  private initialized = false;
  private exited = false;
  private serverRequestId = 1000;
  private readonly waitingReplies = new Map<number | string, (value: unknown) => void>();
  private buffered = '';

  /**
   * Start a fake process on a home.
   *
   * @param home - The disk it reads and writes.
   */
  constructor(readonly home: FakeCodexHome) {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.onInput(chunk));
    this.stdin.on('finish', () => this.exit(0));
  }

  /** Kill the process (records the signal and exits). */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killSignals.push(String(signal));
    this.exit(null, String(signal));
    return true;
  }

  /** Exit as if the binary stopped on its own. */
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('exit', code, signal));
  }

  /** The id of the last server → client request this process sent. */
  get lastServerRequestId(): number {
    return this.serverRequestId - 1;
  }

  /** Whether the process has exited. */
  get hasExited(): boolean {
    return this.exited;
  }

  /** Send a raw message to the client. */
  send(message: unknown): void {
    if (this.exited) return;
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  /** Every request of one method this process received. */
  requestsOf(method: string): Array<Record<string, unknown>> {
    return this.received
      .filter((message) => message.method === method)
      .map((message) => (message.params ?? {}) as Record<string, unknown>);
  }

  private onInput(chunk: Buffer): void {
    this.buffered += chunk.toString();
    const lines = this.buffered.split('\n');
    this.buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: number | string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (message.method === undefined && message.id !== undefined) {
        // Kept in order with the requests, so a test can tell which came first.
        this.received.push({ id: message.id, method: REPLY, params: message.result });
        this.replies.set(message.id, message.result ?? { error: message.error });
        this.waitingReplies.get(message.id)?.(message.result ?? { error: message.error });
        this.waitingReplies.delete(message.id);
        continue;
      }
      this.received.push({
        ...(message.id !== undefined ? { id: message.id } : {}),
        method: message.method!,
        params: message.params,
      });
      if (message.id !== undefined) this.handle(message.id, message.method!, message.params);
    }
  }

  private reply(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  private fail(id: number | string, message: string, code = -32600): void {
    this.send({ id, error: { code, message } });
  }

  private handle(id: number | string, method: string, rawParams: unknown): void {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    if (this.overloadNext > 0 && method !== 'initialize') {
      this.overloadNext -= 1;
      this.fail(id, 'Server overloaded; retry later.', -32001);
      return;
    }
    if (method === 'initialize') {
      if (this.initialized) return this.fail(id, 'Already initialized');
      this.initialized = true;
      const name = (params.clientInfo as { name?: string } | undefined)?.name ?? 'client';
      return this.reply(id, {
        userAgent: `${name}/0.154.0 (Fake OS; arm64) unknown (${name}; test)`,
        codexHome: '/fake/codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      });
    }
    if (!this.initialized) return this.fail(id, 'Not initialized');
    switch (method) {
      case 'thread/start':
        return this.threadStart(id, params);
      case 'thread/resume':
        return this.threadResume(id, params);
      case 'turn/start':
        if (this.exitOnTurnStart) return this.exit(1);
        if (this.turnStartGate) {
          void this.turnStartGate.then(() => this.turnStart(id, params));
          return;
        }
        return this.turnStart(id, params);
      case 'turn/interrupt':
        return this.turnInterrupt(id, params);
      case 'config/read':
        return this.reply(id, {
          config: { projects: this.home.projects },
          origins: {},
          layers: null,
        });
      case 'account/rateLimits/read':
        return this.reply(id, {
          rateLimits: {
            limitId: 'codex',
            limitName: null,
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_900_000_000 },
            secondary: null,
            credits: null,
            planType: 'pro',
            rateLimitReachedType: null,
          },
        });
      case 'thread/backgroundTerminals/list':
        // Like the binary: a thread this process has not loaded is not found.
        if (!this.loaded.has(params.threadId as string)) {
          return this.fail(id, `thread not found: ${String(params.threadId)}`);
        }
        return this.reply(id, {
          data: this.backgroundTerminals.get(params.threadId as string) ?? [],
          nextCursor: null,
        });
      case 'thread/fork':
        return this.threadFork(id, params);
      case 'thread/unsubscribe':
        this.unsubscribed.add(params.threadId as string);
        return this.reply(id, { status: 'unsubscribed' });
      case 'model/list':
        return this.reply(id, { data: [], nextCursor: null });
      default:
        return this.fail(id, `Invalid request: unknown variant \`${method}\``);
    }
  }

  private threadStart(id: number | string, params: Record<string, unknown>): void {
    const threadId = randomUUID();
    this.home.threads.set(threadId, { id: threadId, hasRollout: false });
    this.loaded.set(threadId, {
      id: threadId,
      loadParams: params,
      activeTurn: undefined,
      turnStarts: [],
    });
    this.reply(id, { thread: { id: threadId }, model: params.model ?? 'fake-model' });
    this.send({ method: 'thread/started', params: { thread: { id: threadId } } });
  }

  private threadFork(id: number | string, params: Record<string, unknown>): void {
    const source = this.home.threads.get(params.threadId as string);
    if (!source) return this.fail(id, `thread not found: ${String(params.threadId)}`);
    // Like the binary: a thread that never ran a turn has no rollout to fork.
    if (!source.hasRollout) {
      return this.fail(id, `no rollout found for thread id ${String(params.threadId)}`);
    }
    // A fork is a new thread, loaded with the config it was given, carrying
    // the source's history (so it is resumable at once).
    const threadId = randomUUID();
    this.home.threads.set(threadId, { id: threadId, hasRollout: source.hasRollout });
    this.loaded.set(threadId, {
      id: threadId,
      loadParams: params,
      activeTurn: undefined,
      turnStarts: [],
    });
    this.reply(id, { thread: { id: threadId }, model: params.model ?? 'fake-model' });
  }

  private threadResume(id: number | string, params: Record<string, unknown>): void {
    const threadId = params.threadId as string;
    const record = this.home.threads.get(threadId);
    if (!record) return this.fail(id, `thread not found: ${threadId}`);
    const loaded = this.loaded.get(threadId);
    if (loaded) {
      // Loaded-config immutability: success, and the new config is ignored.
      return this.reply(id, {
        thread: { id: threadId },
        model: loaded.loadParams.model ?? 'fake-model',
      });
    }
    if (!record.hasRollout) return this.fail(id, `no rollout found for thread id ${threadId}`);
    this.loaded.set(threadId, {
      id: threadId,
      loadParams: params,
      activeTurn: undefined,
      turnStarts: [],
    });
    this.reply(id, { thread: { id: threadId }, model: params.model ?? 'fake-model' });
  }

  private turnStart(id: number | string, params: Record<string, unknown>): void {
    const threadId = params.threadId as string;
    const loaded = this.loaded.get(threadId);
    if (!loaded) return this.fail(id, `thread not found: ${threadId}`);
    loaded.turnStarts.push(params);
    const text = ((params.input as Array<{ text?: string }> | undefined) ?? [])
      .map((input) => input.text ?? '')
      .join('');
    if (loaded.activeTurn && !loaded.activeTurn.done) {
      // The joining trap: steer into the running turn, answer ITS id.
      loaded.activeTurn.steered.push(text);
      return this.reply(id, {
        turn: { id: loaded.activeTurn.id, status: 'inProgress', items: [] },
      });
    }
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
    const turn: FakeTurn = { id: randomUUID(), threadId, interrupted, steered: [], done: false };
    (turn as { interrupt?: () => void }).interrupt = interrupt;
    loaded.activeTurn = turn;
    this.home.threads.get(threadId)!.hasRollout = true;
    this.reply(id, { turn: { id: turn.id, status: 'inProgress', items: [] } });
    this.send({
      method: 'turn/started',
      params: { threadId, turn: { id: turn.id, status: 'inProgress', items: [] } },
    });
    const script = this.home.scripts.shift() ?? this.home.defaultScript;
    setImmediate(() => {
      void Promise.resolve(script(this.contextFor(turn, params))).catch(() => {});
    });
  }

  private turnInterrupt(id: number | string, params: Record<string, unknown>): void {
    const loaded = this.loaded.get(params.threadId as string);
    const turn = loaded?.activeTurn;
    if (!turn || turn.done || turn.id !== params.turnId) {
      return this.fail(id, 'no active turn to interrupt');
    }
    this.reply(id, {});
    (turn as { interrupt?: () => void }).interrupt?.();
  }

  private contextFor(turn: FakeTurn, params: Record<string, unknown>): FakeTurnContext {
    const scoped = (extra: Record<string, unknown>) => ({
      threadId: turn.threadId,
      turnId: turn.id,
      ...extra,
    });
    const ctx: FakeTurnContext = {
      turn,
      server: this,
      params,
      emit: (method, extra) => this.send({ method, params: scoped(extra) }),
      agentMessage: (text, deltas = [text]) => {
        const itemId = `msg-${randomUUID().slice(0, 8)}`;
        this.send({
          method: 'item/started',
          params: scoped({
            item: { type: 'agentMessage', id: itemId, text: '' },
            startedAtMs: Date.now(),
          }),
        });
        for (const delta of deltas) {
          this.send({ method: 'item/agentMessage/delta', params: scoped({ itemId, delta }) });
        }
        this.send({
          method: 'item/completed',
          params: scoped({
            item: { type: 'agentMessage', id: itemId, text },
            completedAtMs: Date.now(),
          }),
        });
      },
      tokenUsage: (lastTotal, window, totalOutput = 0) => {
        const breakdown = (total: number, output: number) => ({
          totalTokens: total,
          inputTokens: total - output,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: output,
          reasoningOutputTokens: 0,
        });
        this.send({
          method: 'thread/tokenUsage/updated',
          params: scoped({
            tokenUsage: {
              total: breakdown(lastTotal, totalOutput),
              last: breakdown(lastTotal, totalOutput),
              modelContextWindow: window,
            },
          }),
        });
      },
      complete: (status = 'completed', error) => {
        if (turn.done) return;
        turn.done = true;
        const loaded = this.loaded.get(turn.threadId);
        if (loaded?.activeTurn === turn) loaded.activeTurn = undefined;
        this.send({
          method: 'turn/completed',
          params: {
            threadId: turn.threadId,
            turn: { id: turn.id, status, items: [], error: error ?? null },
          },
        });
      },
      serverRequest: (method, extra) => {
        const requestId = this.serverRequestId++;
        const reply = new Promise<unknown>((resolve) =>
          this.waitingReplies.set(requestId, resolve)
        );
        this.send({ id: requestId, method, params: scoped(extra) });
        return reply.then((value) => {
          this.send({
            method: 'serverRequest/resolved',
            params: { threadId: turn.threadId, requestId },
          });
          return value;
        });
      },
      tick: () => new Promise((resolve) => setImmediate(resolve)),
    };
    return ctx;
  }
}
