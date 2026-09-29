import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, UsageStatus } from '@dorkos/shared/types';
import type { AgentSession } from '../../../agent-types.js';

const recordSessionUsage = vi.fn();
const sessionSubscriptionUsage = vi.fn<(session: unknown) => UsageStatus | undefined>();
vi.mock('../../../accounts/account-usage-feed.js', () => ({
  recordSessionUsage: (...args: unknown[]) => recordSessionUsage(...args),
  sessionSubscriptionUsage: (session: unknown) => sessionSubscriptionUsage(session),
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
  beforeEach(() => {
    recordSessionUsage.mockReset();
    sessionSubscriptionUsage.mockReset();
  });

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

describe("the session's usage reads from the account store (spec claude-account-fleet §6 U)", () => {
  const fromStore: UsageStatus = {
    kind: 'subscription',
    utilization: 0.61,
    windowLabel: 'Weekly',
    resetsAt: '2026-10-01T00:00:00.000Z',
  };

  beforeEach(() => {
    recordSessionUsage.mockReset();
    sessionSubscriptionUsage.mockReset();
  });

  it("a result's usage is the account's binding window plus the session's own cost", async () => {
    sessionSubscriptionUsage.mockReturnValue(fromStore);
    const session = makeSession();
    session.lastSubscriptionUsage = { kind: 'subscription', utilization: 0.1, windowLabel: 'old' };
    const events = await drain({ type: 'result', total_cost_usd: 0.25, modelUsage: {} }, session);
    const status = events.find((e) => e.type === 'session_status')!;
    expect((status.data as { usage?: UsageStatus }).usage).toEqual({
      ...fromStore,
      costUsd: 0.25,
    });
  });

  it("falls back to the session's own last reading while the store has no plan window", async () => {
    sessionSubscriptionUsage.mockReturnValue(undefined);
    const session = makeSession();
    session.lastSubscriptionUsage = { kind: 'subscription', utilization: 0.1, windowLabel: 'own' };
    const events = await drain({ type: 'result', total_cost_usd: 0.25, modelUsage: {} }, session);
    const status = events.find((e) => e.type === 'session_status')!;
    expect((status.data as { usage?: UsageStatus }).usage).toEqual({
      kind: 'subscription',
      utilization: 0.1,
      windowLabel: 'own',
      costUsd: 0.25,
    });
  });

  it('a rate_limit_event shows the store window, keeping the event detail', async () => {
    sessionSubscriptionUsage.mockReturnValue(fromStore);
    const events = await drain({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.2,
        isUsingOverage: true,
      },
    });
    expect((events[0]!.data as { usage?: UsageStatus }).usage).toEqual({
      ...fromStore,
      detail: 'Using overage capacity',
    });
  });
});
