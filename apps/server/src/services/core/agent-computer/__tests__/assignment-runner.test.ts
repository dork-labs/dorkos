/**
 * @vitest-environment node
 *
 * The beat an agent computer reads its assignment on (DOR-2940): Cloud's
 * `pollAfterSeconds` within bounds, a retry after a failure, a read at once on
 * `agent_computer_assignment_changed` that never overlaps another, and a stop
 * for good on a refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  AGENT_COMPUTER_LINKED_POLL_MS,
  AGENT_COMPUTER_MAX_POLL_MS,
  AGENT_COMPUTER_MIN_POLL_MS,
  AGENT_COMPUTER_RETRY_MS,
  AGENT_COMPUTER_WAITING_POLL_MS,
  AgentComputerAssignmentRunner,
  agentComputerAssignmentChanged,
  nextAgentComputerPollMs,
} from '../assignment-runner.js';
import type { AgentComputerSyncOutcome } from '../assignment-sync.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the wait between reads', () => {
  it.each<[AgentComputerSyncOutcome, number | null]>([
    [{ kind: 'waiting', pollAfterSeconds: null }, AGENT_COMPUTER_WAITING_POLL_MS],
    [{ kind: 'linked', pollAfterSeconds: null }, AGENT_COMPUTER_LINKED_POLL_MS],
    [{ kind: 'waiting', pollAfterSeconds: 20 }, 20_000],
    [{ kind: 'linked', pollAfterSeconds: 1 }, AGENT_COMPUTER_MIN_POLL_MS],
    [{ kind: 'linked', pollAfterSeconds: 86_400 }, AGENT_COMPUTER_MAX_POLL_MS],
    [{ kind: 'failed' }, AGENT_COMPUTER_RETRY_MS],
    [{ kind: 'refused', reason: 'different-owner' }, null],
  ])('after %o is %s', (outcome, wait) => {
    expect(nextAgentComputerPollMs(outcome)).toBe(wait);
  });
});

describe('the runner', () => {
  it('reads at start, then every pollAfterSeconds', async () => {
    const sync = vi.fn(async (): Promise<AgentComputerSyncOutcome> => ({
      kind: 'waiting',
      pollAfterSeconds: 20,
    }));
    const runner = new AgentComputerAssignmentRunner({ sync });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
    runner.stop();
  });

  it('reads at once when asked, and never runs two reads together', async () => {
    let release!: () => void;
    let inFlight = 0;
    let most = 0;
    const sync = vi.fn(async (): Promise<AgentComputerSyncOutcome> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => (release = resolve));
      inFlight -= 1;
      return { kind: 'linked', pollAfterSeconds: null };
    });
    const runner = new AgentComputerAssignmentRunner({ sync });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    // Asked while a read runs: it follows that read, rather than racing it.
    expect(runner.readNow()).toBe('applied');
    expect(runner.readNow()).toBe('applied');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(most).toBe(1);
    // Asked while idle: it reads now instead of at the beat.
    runner.readNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(3);
    release();
    runner.stop();
  });

  it('stops for good on a refusal, and ignores a later ask', async () => {
    const sync = vi.fn(async (): Promise<AgentComputerSyncOutcome> => ({
      kind: 'refused',
      reason: 'different-owner',
    }));
    const runner = new AgentComputerAssignmentRunner({ sync });
    runner.start();
    await vi.advanceTimersByTimeAsync(AGENT_COMPUTER_MAX_POLL_MS * 2);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(runner.readNow()).toBe('ignored');
  });

  it('retries a failed read', async () => {
    const sync = vi.fn(async (): Promise<AgentComputerSyncOutcome> => ({ kind: 'failed' }));
    const runner = new AgentComputerAssignmentRunner({ sync });
    runner.start();
    await vi.advanceTimersByTimeAsync(AGENT_COMPUTER_RETRY_MS);
    expect(sync).toHaveBeenCalledTimes(2);
    runner.stop();
  });
});

describe('the command', () => {
  it('is ignored where the link was never started: any role but an agent computer', () => {
    expect(agentComputerAssignmentChanged()).toBe('ignored');
  });
});
