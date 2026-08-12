/**
 * A scriptable stand-in for one SDK subprocess, shared by the pump suite and
 * the turn-windowing suite so both drive the SAME double.
 *
 * Not a test file (no `.test.ts` suffix) — a test-support module only.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/fake-pump-query
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PumpQuery } from '../session-pump-contract.js';

/**
 * A control answer that arrives on a LATER macrotask, as a real one does.
 *
 * Load-bearing, not decoration. The windower promises a window's accounting is
 * delivered BEFORE its `result` is released, so `context_usage` still precedes
 * `done`. Answering control calls synchronously makes that ordering hold by
 * microtask luck whether or not the code preserves it — reordering the fetch
 * after the push stayed green against a synchronous fake and goes red against
 * this one.
 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * One SDK subprocess a test drives by hand.
 *
 * It is an async iterable over messages a test pushes in, plus the `close()`
 * that terminates the child and the control methods a warm process answers.
 * `endStream`/`failStream` are how a test kills the process; `close()` records
 * that the pump reached for the forceful teardown.
 */
export class FakeQuery implements PumpQuery {
  closed = 0;
  /** How many times each control method was called — the "is it still alive" probe. */
  contextUsageCalls = 0;
  subscriptionUsageCalls = 0;
  /** Messages waiting for the consumer, and the parked consumer's waker. */
  private readonly pending: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private failure: unknown;

  /** Hand a message to whoever is reading this process's output. */
  emit(message: SDKMessage): void {
    this.pending.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  /** The subprocess exited cleanly (stdin closed, or it just went away). */
  endStream(): void {
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** The subprocess died and the generator threw. */
  failStream(err: unknown): void {
    this.failure = err;
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** The SDK's forceful teardown of the CLI child. */
  close(): void {
    this.closed += 1;
    this.endStream();
  }

  /** The control call the windower makes at every window close. */
  getContextUsage(): ReturnType<PumpQuery['getContextUsage']> {
    this.contextUsageCalls += 1;
    if (this.done) return Promise.reject(new Error('the process is gone'));
    // A DIFFERENT total on every call, so a test asserting that each window got
    // its own breakdown cannot pass on a stale one left over from the window
    // before it.
    return tick().then(() => ({
      totalTokens: 1_000 * this.contextUsageCalls,
      maxTokens: 200_000,
      percentage: 0.5,
      model: 'test-model',
      categories: [{ name: 'Messages', tokens: 1_000, isDeferred: false, color: 'text' }],
    })) as unknown as ReturnType<PumpQuery['getContextUsage']>;
  }

  /** The experimental `/usage` control call, alongside the context fetch. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): ReturnType<
    PumpQuery['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']
  > {
    this.subscriptionUsageCalls += 1;
    if (this.done) return Promise.reject(new Error('the process is gone'));
    return tick().then(() => ({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 25, resets_at: null } },
    })) as unknown as ReturnType<
      PumpQuery['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']
    >;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      while (this.pending.length > 0) yield this.pending.shift()!;
      if (this.failure !== undefined) throw this.failure;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/**
 * The `system/init` message, with whatever protocol capabilities a test wants.
 *
 * @param capabilities - Protocol capability names the CLI reports at init.
 */
export function initMessage(capabilities?: string[]): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: '0.0.0-test',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
    model: 'test-model',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    ...(capabilities !== undefined ? { capabilities } : {}),
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'sess-1',
  } as SDKMessage;
}
