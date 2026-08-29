import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@dorkos/shared/logger';
import { interruptTurn } from '../interrupt.js';
import type { AgentRuntimeLike } from '../types.js';

/** A minimal `AgentRuntimeLike` — `interruptTurn` only ever calls `interruptQuery`. */
function fakeAgentManager(interruptQuery: AgentRuntimeLike['interruptQuery']): AgentRuntimeLike {
  return { interruptQuery } as unknown as AgentRuntimeLike;
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('interruptTurn', () => {
  it('never rejects, even when interruptQuery throws', async () => {
    const agentManager = fakeAgentManager(vi.fn().mockRejectedValue(new Error('boom')));
    const logger = fakeLogger();
    await expect(
      interruptTurn(agentManager, 'sess-1', 'turn <t1>', logger)
    ).resolves.toBeUndefined();
  });

  it('logs the safe message when interruptQuery rejects', async () => {
    const agentManager = fakeAgentManager(
      vi.fn().mockRejectedValue(new Error('runtime unreachable'))
    );
    const logger = fakeLogger();
    await interruptTurn(agentManager, 'sess-1', 'turn <t1>', logger);
    expect(logger.error).toHaveBeenCalledWith(
      '[CCA] turn <t1>: interrupting the turn failed',
      expect.objectContaining({ message: 'runtime unreachable' })
    );
  });

  /**
   * DOR-1509 adversarial review. `interruptQuery` reaches all the way into
   * the agent runtime's own SDK client — the same family of HTTP-backed SDK
   * as the chat adapters, and the same class of caught error can carry a
   * live credential (an API key in a request header/config) nested inside
   * it. This reproduces that shape generically (an axios-style `toJSON()`,
   * the same mechanism proven against Slack's SDK) and proves the secret
   * never reaches the logger, the same invariant already proven for every
   * other adapter-facing catch site in this program.
   */
  it('never lets a caught error with a nested secret reach the logger', async () => {
    const secret = 'runtime-api-key-should-not-leak';
    class PoisonedError extends Error {
      readonly config = { headers: { Authorization: `Bearer ${secret}` } };
      toJSON() {
        return { message: this.message, config: this.config };
      }
    }
    const agentManager = fakeAgentManager(
      vi.fn().mockRejectedValue(new PoisonedError('interrupt request failed'))
    );
    const logger = fakeLogger();

    await interruptTurn(agentManager, 'sess-1', 'turn <t1>', logger);

    const everyLoggedArg = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ];
    const serialized = JSON.stringify(everyLoggedArg);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('interrupt request failed');
  });

  it('resolves cleanly and logs nothing when interruptQuery reports no in-flight turn', async () => {
    const agentManager = fakeAgentManager(vi.fn().mockResolvedValue(false));
    const logger = fakeLogger();
    await interruptTurn(agentManager, 'sess-1', 'turn <t1>', logger);
    expect(logger.debug).toHaveBeenCalledWith(
      '[CCA] turn <t1>: runtime reported no in-flight turn to interrupt'
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
