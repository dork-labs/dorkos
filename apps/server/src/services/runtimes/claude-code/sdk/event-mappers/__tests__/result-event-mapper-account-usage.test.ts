import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession } from '../../../agent-types.js';

const recordSessionUsage = vi.fn();
vi.mock('../../../accounts/account-usage-feed.js', () => ({
  recordSessionUsage: (...args: unknown[]) => recordSessionUsage(...args),
}));

const { mapResultEvent } = await import('../result-event-mapper.js');

function makeSession(): AgentSession {
  return {
    sdkSessionId: '',
    lastActivity: 0,
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    launchedAccountRoot: '/accounts/work',
  };
}

async function drain(message: Record<string, unknown>, session = makeSession()) {
  const out: StreamEvent[] = [];
  for await (const e of mapResultEvent(message as unknown as SDKMessage, session, 's-1')) {
    out.push(e);
  }
  return out;
}

describe('rate_limit_event feeds the account usage store (spec claude-account-fleet D2)', () => {
  beforeEach(() => recordSessionUsage.mockReset());

  it('records utilization 0.82 as usedPct 82 under the event rateLimitType', async () => {
    await drain({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.82,
        resetsAt: 1_783_000_000,
      },
    });
    expect(recordSessionUsage).toHaveBeenCalledTimes(1);
    const [session, observations] = recordSessionUsage.mock.calls[0]!;
    expect((session as AgentSession).launchedAccountRoot).toBe('/accounts/work');
    expect(observations).toEqual([
      expect.objectContaining({
        key: 'five_hour',
        usedPct: 82,
        resetsAt: new Date(1_783_000_000 * 1000).toISOString(),
        status: 'allowed_warning',
        source: 'sdk_event',
      }),
    ]);
  });

  it('records overage under its own key', async () => {
    await drain({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'overage' },
    });
    expect(recordSessionUsage.mock.calls[0]![1]).toEqual([
      expect.objectContaining({
        key: 'overage',
        usedPct: null,
        resetsAt: null,
        status: 'rejected',
      }),
    ]);
  });

  it('records nothing for an event with no rateLimitType, and still emits the status', async () => {
    const events = await drain({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', utilization: 0.1 },
    });
    expect(recordSessionUsage).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['session_status']);
  });
});
