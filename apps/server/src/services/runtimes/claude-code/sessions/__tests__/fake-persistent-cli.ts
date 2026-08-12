/**
 * A stand-in for the `claude` CLI that behaves like a PERSISTENT one: it stays
 * alive across turns, reads its held input stream for as long as the process
 * lives, and answers each user message with its own correlated `result`.
 *
 * Not a test file (no `.test.ts` suffix) — a test-support module only.
 *
 * ## Why the existing `wrapSdkQuery` doubles cannot be used here
 *
 * They script a FIXED sequence and then end, which is exactly right for a
 * process that lives one turn. Handed to the pump, the stream ending after the
 * first `result` reads as the process dying — so every second turn would be
 * testing crash recovery rather than warmth. This double ends only when the
 * test kills it or the prompt stream closes, which is what a real warm CLI does.
 *
 * ## It correlates by id, because the windower does
 *
 * Each `result` carries the `user_message_uuid` of the message it answers,
 * exactly as the SDK does. A double that omitted it would still close the open
 * window — an unnamed result terminates whichever window is open — so the
 * correlation path would never be exercised and a broken one would pass.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/fake-persistent-cli
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A control answer that arrives on a LATER macrotask, as a real one does.
 *
 * Load-bearing rather than realism for its own sake. The windower ends a
 * window's pump turn only after fetching its accounting, and the pump reaches
 * `RUNNING` on the microtask chain behind its launch. Answering control calls
 * synchronously puts those two on the same chain, so which lands first is
 * microtask luck — and a `endTurn()` that arrives first is a no-op, leaving the
 * pump stuck RUNNING with no window. One macrotask separates them the way an
 * IPC round trip does.
 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** One booted process: what it was launched with, and what it has said. */
export class FakeCliProcess {
  /** Exactly the options this launch was handed. */
  readonly options: Options;
  /** How many turns this process has answered. */
  answered = 0;
  /** True once the process is gone, however it went. */
  ended = false;
  /** How many times the forceful `close()` was reached for. */
  closed = 0;
  /** How many times the graceful `interrupt()` was reached for. */
  interrupts = 0;
  /**
   * When set, `interrupt()` rejects with this instead of resolving — the SDK's
   * pre-init failure path, where the control write fails because the process is
   * already gone (`request()` rejects on a failed `transport.write`). Drives the
   * escalation-to-`close()` branch a booting Stop can hit (DOR-1191).
   */
  interruptRejectsWith: unknown;
  /** The four settable-live pins, in the order they were applied. */
  readonly liveSets: string[] = [];
  /** Every message id this process has READ off its input stream, in order. */
  readonly received: string[] = [];
  /** Messages waiting for the consumer. */
  private readonly pending: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private failure: unknown;
  /** When false, a dispatched message is read but deliberately left unanswered. */
  private autoAnswer = true;
  /** A prompt whose reading waits for {@link reportReady}, so a turn can hang mid-boot. */
  private deferredPrompt: AsyncIterable<unknown> | undefined;

  /**
   * Boot a process around a held prompt.
   *
   * @param options - The SDK options this launch was handed
   * @param prompt - The held input stream the pump owns
   * @param deferInit - When true, hold `system/init` until {@link reportReady},
   *   so a test can press Stop while the first turn is still booting (DOR-1191).
   */
  constructor(options: Options, prompt: AsyncIterable<unknown>, deferInit = false) {
    this.options = options;
    if (deferInit) {
      // Nothing is read or answered until the process reports ready: the pump
      // stays WARMING and its dispatch parks on `system/init`.
      this.deferredPrompt = prompt;
      return;
    }
    this.emit(initMessage());
    void this.readPrompt(prompt);
  }

  /** Emit the held `system/init` and start reading, ending a deferred boot. */
  reportReady(): void {
    if (this.deferredPrompt === undefined) return;
    const prompt = this.deferredPrompt;
    this.deferredPrompt = undefined;
    this.emit(initMessage());
    void this.readPrompt(prompt);
  }

  /** Stop answering dispatched messages, so a turn can be left hanging. */
  goSilent(): void {
    this.autoAnswer = false;
  }

  /** Hand a message to whoever is reading this process's output. */
  emit(message: SDKMessage): void {
    if (this.ended) return;
    this.pending.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  /** Answer the message with this id, as the CLI would at the end of a turn. */
  answer(messageId: string | undefined, text = 'ok'): void {
    this.answered += 1;
    this.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: `assistant-${this.answered}`,
    } as unknown as SDKMessage);
    this.emit(resultMessage(messageId));
  }

  /** The subprocess exited: stdin closed, or it simply went away. */
  endStream(): void {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** The subprocess died and its stream threw — a crash, not a close. */
  crash(err: unknown): void {
    this.failure = err;
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** The SDK's forceful teardown of the CLI child. */
  close(): void {
    this.closed += 1;
    this.endStream();
  }

  /** Read the held prompt for the life of the process, answering as it goes. */
  private async readPrompt(prompt: AsyncIterable<unknown>): Promise<void> {
    for await (const message of prompt) {
      if (this.ended) return;
      const id = (message as { uuid?: string }).uuid;
      this.received.push(id ?? '<unnamed>');
      if (this.autoAnswer) this.answer(id);
    }
    // Stdin closed, so the CLI exits and its output stream ends. Faithful, and
    // load-bearing for the resume path: `executeSdkQuery` closes the prompt at
    // the `result` and then waits for the stream to end. A double that stayed
    // open there would hang every flag-off turn.
    this.endStream();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      while (this.pending.length > 0) yield this.pending.shift()!;
      if (this.failure !== undefined) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  // --- the control channel a warm process still answers -------------------

  getContextUsage(): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error('the process is gone'));
    return tick().then(() => ({
      totalTokens: 1_000,
      maxTokens: 200_000,
      percentage: 0.5,
      model: 'test-model',
      categories: [{ name: 'Messages', tokens: 1_000, isDeferred: false, color: 'text' }],
    }));
  }

  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error('the process is gone'));
    return tick().then(() => ({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 25, resets_at: null } },
    }));
  }

  setModel(model?: string): Promise<void> {
    this.liveSets.push(`setModel:${model ?? '<default>'}`);
    return Promise.resolve();
  }

  setPermissionMode(mode: string): Promise<void> {
    this.liveSets.push(`setPermissionMode:${mode}`);
    return Promise.resolve();
  }

  setMcpServers(servers: Record<string, unknown>): Promise<unknown> {
    this.liveSets.push(`setMcpServers:${Object.keys(servers).sort().join(',')}`);
    return Promise.resolve({ added: [], removed: [], failed: [] });
  }

  reloadPlugins(): Promise<unknown> {
    this.liveSets.push('reloadPlugins');
    return Promise.resolve({ commands: [] });
  }

  interrupt(): Promise<void> {
    this.interrupts += 1;
    if (this.interruptRejectsWith !== undefined) return Promise.reject(this.interruptRejectsWith);
    return Promise.resolve();
  }

  supportedModels(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  mcpServerStatus(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  supportedCommands(): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  supportedAgents(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
}

/** Every process a run of the fake CLI booted, oldest first. */
export class FakeCli {
  readonly processes: FakeCliProcess[] = [];
  /**
   * When true, the NEXT process booted holds its `system/init` until
   * {@link FakeCliProcess.reportReady}, so a test can catch a turn mid-boot
   * (DOR-1191). Reset after it takes, so only the one launch is deferred.
   */
  deferNextInit = false;

  /**
   * The `query()` implementation to hand `vi.mocked(query).mockImplementation`.
   *
   * @returns A live process, recorded in {@link processes}
   */
  readonly query = (args: { prompt: AsyncIterable<unknown>; options: Options }): FakeCliProcess => {
    const deferInit = this.deferNextInit;
    this.deferNextInit = false;
    const process = new FakeCliProcess(args.options, args.prompt, deferInit);
    this.processes.push(process);
    return process;
  };

  /** How many subprocesses have been booted — the process-identity assertion. */
  get launches(): number {
    return this.processes.length;
  }

  /** The process booted most recently, or undefined before the first launch. */
  get latest(): FakeCliProcess | undefined {
    return this.processes.at(-1);
  }
}

const SESSION_ID = 'sdk-session-persistent';

/** The `system/init` that says the process is up and its controls are usable. */
function initMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'default',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    output_style: 'normal',
    skills: [],
    plugins: [],
    cwd: '/projects/pump',
    apiKeySource: 'user',
    uuid: 'init-uuid',
    claude_code_version: '0.0.0',
  } as unknown as SDKMessage;
}

/**
 * The `result` that answers one dispatched message.
 *
 * @param userMessageUuid - The id of the message this answers, as the SDK
 *   echoes it back. Omitted for a `result` nobody dispatched.
 */
export function resultMessage(userMessageUuid?: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0001,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    session_id: SESSION_ID,
    uuid: `result-${userMessageUuid ?? 'unasked'}`,
    ...(userMessageUuid !== undefined ? { user_message_uuid: userMessageUuid } : {}),
  } as unknown as SDKMessage;
}
