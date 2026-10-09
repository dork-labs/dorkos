/** SDK acquisition is asynchronous; the original pump still owns launch and teardown. */
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../agent-types.js';
import type { MessageSenderOpts } from '../../messaging/message-sender-shared.js';
import type { PumpLaunchPlan } from '../pump-launch.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  vi.resetModules();
});

async function fixture() {
  vi.resetModules();
  const acquired = deferred();
  const release = deferred();
  let hold = false;
  let factoryCalls = 0;
  const { FakeQuery, initMessage } = await import('./fake-pump-query.js');
  const live = new FakeQuery();
  let promptClosed = false;
  let promptDrain = Promise.resolve();
  const query = vi.fn(
    (input: {
      prompt: AsyncIterable<unknown>;
      options: import('@anthropic-ai/claude-agent-sdk').Options;
    }) => {
      // The provider owns stdin consumption. Only original pump stdin closure
      // ends this fixture's output stream; acquisition itself never ends it.
      promptDrain = (async () => {
        for await (const message of input.prompt) {
          throw new Error(`Idle warm unexpectedly submitted a user message: ${typeof message}`);
        }
        promptClosed = true;
        live.endStream();
      })();
      void promptDrain.catch(() => undefined);
      return live;
    }
  );
  vi.doMock('@anthropic-ai/claude-agent-sdk', async () => {
    factoryCalls += 1;
    acquired.resolve();
    if (hold) await release.promise;
    return { query };
  });
  // A future eager import must fail this assertion rather than park module collection.
  const { createPumpLauncher } = await import('../pump-launch.js');
  const { SessionPump } = await import('../session-pump.js');
  expect(factoryCalls).toBe(0);
  hold = true;
  const plan: PumpLaunchPlan = {
    effectiveCwd: '/proj',
    enrichedContent: 'hello',
    meshAgentId: undefined,
    statusEvents: [],
    sdkOptions: { cwd: '/proj' },
    fingerprint: {} as PumpLaunchPlan['fingerprint'],
  };
  const session = { hasStarted: false, sdkSessionId: undefined } as unknown as AgentSession;
  const onLaunched = vi.fn();
  const launch = createPumpLauncher(session, {} as MessageSenderOpts, () => plan, onLaunched);
  const pump = new SessionPump({ sessionId: 'sdk-acquisition', launch });
  return {
    pump,
    query,
    live,
    plan,
    onLaunched,
    initMessage,
    acquired,
    release,
    get promptClosed() {
      return promptClosed;
    },
    get promptDrain() {
      return promptDrain;
    },
  };
}

it('does not query or publish a process after the original warming pump is torn down during acquisition', async () => {
  const f = await fixture();
  const warming = f.pump.warm();
  // Attach rejection handling immediately; cleanup may retire the original pending launch.
  void warming.catch(() => undefined);
  let failed = false;
  let first: unknown;
  let checkedLaunchRefusal = false;
  try {
    await f.acquired.promise;
    expect(f.pump.state).toBe('warming');
    expect(f.query).not.toHaveBeenCalled();
    await f.pump.teardown();
    expect(f.pump.state).toBe('cold');
    f.release.resolve();
    await expect(warming).rejects.toThrow(
      'Original persistent pump retired or changed during SDK acquisition'
    );
    checkedLaunchRefusal = true;
    expect(f.query).not.toHaveBeenCalled();
    expect(f.onLaunched).not.toHaveBeenCalled();
    expect(f.live.closed).toBe(0); // No provider process was constructed to close.
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    f.release.resolve();
    const results = await Promise.allSettled([f.pump.teardown(), warming, f.promptDrain]);
    for (const [index, result] of results.entries()) {
      // Only the exact original launch promise whose refusal was asserted is expected.
      // A matching message on a different cleanup failure does not erase its cause.
      if (result.status === 'rejected' && !failed && !(index === 1 && checkedLaunchRefusal)) {
        failed = true;
        first = result.reason;
      }
    }
  }
  if (failed) throw first;
});

it('launches the same SDK process once after acquisition and preserves the original shared options', async () => {
  const f = await fixture();
  const warming = f.pump.warm();
  void warming.catch(() => undefined);
  let failed = false;
  let first: unknown;
  try {
    await f.acquired.promise;
    expect(f.pump.state).toBe('warming');
    expect(f.query).not.toHaveBeenCalled();
    f.live.emit(f.initMessage());
    f.release.resolve();
    await warming;
    expect(f.pump.state).toBe('warm');
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.onLaunched).toHaveBeenCalledTimes(1);
    expect(f.onLaunched.mock.calls[0]?.[0]).toBe(f.live);
    expect(f.plan.sdkOptions.spawnClaudeCodeProcess).toBeUndefined();
    expect(typeof f.query.mock.calls[0]?.[0]).toBe('object');
    expect(f.promptClosed).toBe(false);
    await f.pump.teardown();
    await f.promptDrain;
    expect(f.promptClosed).toBe(true);
    expect(f.live.closed).toBe(1);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    f.release.resolve();
    const results = await Promise.allSettled([f.pump.teardown(), warming, f.promptDrain]);
    for (const result of results)
      if (result.status === 'rejected' && !failed) {
        failed = true;
        first = result.reason;
      }
  }
  if (failed) throw first;
});
