import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { UsageStatusSchema } from '@dorkos/shared/schemas';
import type { AgentSession } from '../../../agent-types.js';
import { mapResultEvent } from '../result-event-mapper.js';

const SESSION_ID = 'sess-1';

/** Minimal AgentSession the result mapper reads (usage-holding + request usage). */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: '',
    lastActivity: 0,
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

/** Cast a loose object literal to the SDKMessage union for mapping. */
function msg(obj: Record<string, unknown>): SDKMessage {
  return obj as unknown as SDKMessage;
}

/** Drain the async generator into an array of StreamEvents. */
async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** The `usage` payload folded onto a `session_status` event, if any. */
function usageOf(events: StreamEvent[]): unknown {
  const status = events.find((e) => e.type === 'session_status');
  return (status?.data as Record<string, unknown> | undefined)?.usage;
}

describe('mapResultEvent — rate_limit_event usage projection', () => {
  it('projects subscription usage (utilization + windowLabel + state) onto session_status', async () => {
    const session = makeSession();
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'rate_limit_event',
          retry_after: 12,
          rate_limit_info: {
            status: 'allowed_warning',
            utilization: 0.82,
            resetsAt: 1_800_000_000,
            rateLimitType: 'five_hour',
          },
        }),
        session,
        SESSION_ID
      )
    );

    // Still emits the rate_limit event for the strip countdown.
    expect(events.some((e) => e.type === 'rate_limit')).toBe(true);

    const usage = usageOf(events);
    expect(UsageStatusSchema.parse(usage)).toMatchObject({
      kind: 'subscription',
      utilization: 0.82,
      windowLabel: '5-hour window',
      state: 'warning',
      resetsAt: new Date(1_800_000_000 * 1000).toISOString(),
    });
    // The mapped usage is held for a later cost-only result to re-attach.
    expect(session.lastSubscriptionUsage).toMatchObject({
      kind: 'subscription',
      utilization: 0.82,
    });
  });

  it('maps isUsingOverage to the detail field and rejected status to exhausted', async () => {
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', utilization: 1, isUsingOverage: true },
        }),
        makeSession(),
        SESSION_ID
      )
    );
    expect(usageOf(events)).toMatchObject({
      kind: 'subscription',
      state: 'exhausted',
      detail: 'Using overage capacity',
    });
  });
});

describe('mapResultEvent — result usage stamping', () => {
  it('re-attaches held subscription utilization onto the cost-bearing result (no kind flicker)', async () => {
    const session = makeSession({
      lastSubscriptionUsage: {
        kind: 'subscription',
        utilization: 0.4,
        windowLabel: '5-hour window',
        state: 'ok',
      },
    });
    const events = await drain(
      mapResultEvent(
        msg({ type: 'result', subtype: 'success', total_cost_usd: 0.75, model: 'claude-opus-4-6' }),
        session,
        SESSION_ID
      )
    );
    expect(usageOf(events)).toMatchObject({
      kind: 'subscription',
      utilization: 0.4,
      windowLabel: '5-hour window',
      costUsd: 0.75,
    });
  });

  it('reports pay-as-you-go when no rate-limit signal has been observed', async () => {
    const events = await drain(
      mapResultEvent(
        msg({ type: 'result', subtype: 'success', total_cost_usd: 0.5, model: 'claude-opus-4-6' }),
        makeSession(),
        SESSION_ID
      )
    );
    expect(usageOf(events)).toMatchObject({ kind: 'pay-as-you-go', costUsd: 0.5 });
  });

  it('omits usage on a result with no cost and no prior subscription signal', async () => {
    const events = await drain(
      mapResultEvent(
        msg({ type: 'result', subtype: 'success', model: 'claude-opus-4-6' }),
        makeSession(),
        SESSION_ID
      )
    );
    expect(usageOf(events)).toBeUndefined();
  });
});

describe('mapResultEvent — turn-total token metadata (AI observability, DOR-319)', () => {
  /** The status-event data object, if any. */
  function statusData(events: StreamEvent[]): Record<string, unknown> | undefined {
    const status = events.find((e) => e.type === 'session_status');
    return status?.data as Record<string, unknown> | undefined;
  }

  it('sums modelUsage input/output tokens into turn totals for the result status', async () => {
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.3,
          model: 'claude-opus-4-6',
          modelUsage: {
            'claude-opus-4-6': { inputTokens: 1000, outputTokens: 200, contextWindow: 200000 },
            'claude-haiku': { inputTokens: 250, outputTokens: 50, contextWindow: 200000 },
          },
        }),
        makeSession(),
        SESSION_ID
      )
    );
    const data = statusData(events)!;
    expect(data.turnInputTokens).toBe(1250);
    expect(data.turnOutputTokens).toBe(250);
  });

  it('omits the turn-total fields when the SDK reported no modelUsage', async () => {
    const events = await drain(
      mapResultEvent(
        msg({ type: 'result', subtype: 'success', total_cost_usd: 0.1, model: 'claude-opus-4-6' }),
        makeSession(),
        SESSION_ID
      )
    );
    const data = statusData(events)!;
    expect('turnInputTokens' in data).toBe(false);
    expect('turnOutputTokens' in data).toBe(false);
  });

  it('omits the turn-total fields when modelUsage is present but EMPTY (no data ≠ zero tokens)', async () => {
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.1,
          model: 'claude-opus-4-6',
          modelUsage: {},
        }),
        makeSession(),
        SESSION_ID
      )
    );
    const data = statusData(events)!;
    expect('turnInputTokens' in data).toBe(false);
    expect('turnOutputTokens' in data).toBe(false);
  });
});
