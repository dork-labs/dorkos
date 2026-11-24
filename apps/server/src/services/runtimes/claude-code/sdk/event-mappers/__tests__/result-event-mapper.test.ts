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
        makeSession({ usageLedger: {} }),
        SESSION_ID
      )
    );
    const data = statusData(events)!;
    expect(data.turnInputTokens).toBe(1250);
    expect(data.turnOutputTokens).toBe(250);
  });

  /** A success result whose `modelUsage` carries the given running totals. */
  function runningTotals(
    perModel: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
  ): SDKMessage {
    const total = Object.values(perModel).reduce((sum, u) => sum + u.costUSD, 0);
    return msg({
      type: 'result',
      subtype: 'success',
      total_cost_usd: total,
      model: 'claude-haiku-4-5',
      modelUsage: Object.fromEntries(
        Object.entries(perModel).map(([m, u]) => [m, { ...u, contextWindow: 200000 }])
      ),
    });
  }

  // The figures below are the ones observed live on 2026-09-22 (a two-turn
  // streaming query on haiku, then a resume of it; see sdk/turn-usage.ts).
  it('reports a warm second turn as its own share, not the running total', async () => {
    const session = makeSession({ usageLedger: {} });
    await drain(
      mapResultEvent(
        runningTotals({ haiku: { inputTokens: 4252, outputTokens: 42, costUSD: 0.004462 } }),
        session,
        SESSION_ID
      )
    );
    const second = statusData(
      await drain(
        mapResultEvent(
          runningTotals({ haiku: { inputTokens: 7684, outputTokens: 75, costUSD: 0.008059 } }),
          session,
          SESSION_ID
        )
      )
    )!;
    expect(second.turnInputTokens).toBe(3432);
    expect(second.turnOutputTokens).toBe(33);
    expect(second.turnCostUsd).toBeCloseTo(0.003597, 9);
    // The session's running cost stays the running cost: the Usage & cost item
    // reads it as the session's spend.
    expect(second.costUsd).toBeCloseTo(0.008059, 9);
  });

  it('does not report the whole history after an error result with lower (zeroed) totals', async () => {
    const session = makeSession({
      usageLedger: { haiku: { inputTokens: 7684, outputTokens: 75, costUsd: 0.008059 } },
    });
    const crashed = msg({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['crash'],
      modelUsage: {
        haiku: { inputTokens: 10, outputTokens: 0, costUSD: 0, contextWindow: 200000 },
      },
    });
    expect(
      'turnInputTokens' in statusData(await drain(mapResultEvent(crashed, session, SESSION_ID)))!
    ).toBe(false);

    const next = statusData(
      await drain(
        mapResultEvent(
          runningTotals({ haiku: { inputTokens: 11196, outputTokens: 106, costUSD: 0.011726 } }),
          session,
          SESSION_ID
        )
      )
    )!;
    expect('turnInputTokens' in next).toBe(false);
    expect('turnCostUsd' in next).toBe(false);
  });
});

describe('mapResultEvent — error category classification', () => {
  /** The `data` payload of the emitted `error` event, if any. */
  function errorData(events: StreamEvent[]): Record<string, unknown> | undefined {
    const error = events.find((e) => e.type === 'error');
    return error?.data as Record<string, unknown> | undefined;
  }

  it('answers a revoked-OAuth result in DorkOS words and keeps the CLI text in details', async () => {
    // DOR-1656: this channel used to forward the CLI's own sentence verbatim
    // while the assistant channel said something else for the same expiry, so
    // which words a person met depended only on how the CLI reported it.
    const vendorText =
      'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.';
    const events = await drain(
      mapResultEvent(
        msg({ type: 'result', subtype: 'error_during_execution', errors: [vendorText] }),
        makeSession(),
        SESSION_ID
      )
    );
    const data = errorData(events);
    expect(data?.category).toBe('auth_error');
    expect(data?.message).toBe(
      'Your Claude Code sign-in stopped working. Sign in again to keep going.'
    );
    // Translated, not deleted: the raw line stays reachable for debugging.
    expect(data?.details).toBe(vendorText);
  });
});

describe('mapResultEvent — a turn a person stopped is not an error (DOR-1320)', () => {
  /** The `data` payload of the emitted `error` event, if any. */
  function errorData(events: StreamEvent[]): Record<string, unknown> | undefined {
    return events.find((e) => e.type === 'error')?.data as Record<string, unknown> | undefined;
  }

  /**
   * The exact `result` every observed Stop produced: an error subtype, the
   * CLI's internal `[ede_diagnostic]` line, and a terminal reason naming the
   * abort.
   */
  function abortedResult(terminalReason = 'aborted_streaming'): SDKMessage {
    return msg({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: terminalReason,
      errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    });
  }

  it('leaves no error frame when DorkOS asked for the stop', async () => {
    const events = await drain(
      mapResultEvent(abortedResult(), makeSession(), SESSION_ID, () => true)
    );

    expect(events.some((e) => e.type === 'error')).toBe(false);
    // The turn still ends, still saying it was cut short — the reason the
    // projector settles as `interrupted`.
    const status = events.find((e) => e.type === 'session_status');
    expect((status?.data as Record<string, unknown>).terminalReason).toBe('aborted_streaming');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('KEEPS the error frame when nobody asked for the stop', async () => {
    // The discriminating case, and the reason shape alone is not the gate. The
    // CLI drives `aborted_streaming` from one `signal.aborted` check and
    // collapses nine causes into it — `refusal-fallback-edit` (an API refusal
    // aborting the main turn controller) is the provable non-operator one. A
    // shape-only gate dropped that failure's error frame and told the operator
    // they stopped a turn they never touched (DOR-1320 review, SF1).
    const events = await drain(
      mapResultEvent(abortedResult(), makeSession(), SESSION_ID, () => false)
    );

    expect(errorData(events)?.category).toBe('execution_error');
    expect(errorData(events)?.code).toBe('error_during_execution');
  });

  // Keeping the error frame was never enough on its own: settlement read the
  // abort reason, called the turn `interrupted` and erased the very frame this
  // mapper had deliberately preserved. So the intent travels WITH the reason.
  describe('the stop record it stamps on session_status', () => {
    /** The `data` payload of the emitted `session_status`. */
    function statusData(events: StreamEvent[]): Record<string, unknown> {
      return events.find((e) => e.type === 'session_status')?.data as Record<string, unknown>;
    }

    it.each([true, false])('reports stopWasRequested:%s beside an abort reason', async (stop) => {
      const events = await drain(
        mapResultEvent(abortedResult(), makeSession(), SESSION_ID, () => stop)
      );
      expect(statusData(events).stopWasRequested).toBe(stop);
    });
  });
});

describe('mapResultEvent — context window of a 1M model', () => {
  /** A result shaped like SDK 0.3.280's for `claude-opus-5-5[1m]`: Haiku first. */
  const opus1mResult = msg({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.1,
    modelUsage: {
      'claude-haiku-4-5-20251001': {
        inputTokens: 10,
        outputTokens: 1,
        contextWindow: 200_000,
        canonicalModel: 'claude-haiku-4-5',
      },
      'claude-opus-5-5[1m]': {
        inputTokens: 300_000,
        outputTokens: 50,
        contextWindow: 1_000_000,
        canonicalModel: 'claude-opus-5-5',
      },
    },
  });
  const lastRequestUsage = { inputTokens: 1, cacheReadTokens: 299_999, cacheCreationTokens: 0 };

  function statusData(events: StreamEvent[]): Record<string, unknown> {
    return events.find((e) => e.type === 'session_status')!.data as Record<string, unknown>;
  }

  it("prefers the SDK's own turn-end measurement when it answered", async () => {
    const events = await drain(
      mapResultEvent(
        opus1mResult,
        makeSession({
          lastRequestUsage,
          lastRequestModel: 'claude-haiku-4-5-20251001',
          contextBreakdown: {
            totalTokens: 300_000,
            maxTokens: 1_000_000,
            percentage: 30,
            model: 'claude-opus-5-5[1m]',
            categories: [],
          },
        }),
        SESSION_ID
      )
    );
    expect(statusData(events).contextMaxTokens).toBe(1_000_000);
  });
});
