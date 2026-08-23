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

describe('mapResultEvent — error category classification', () => {
  /** The `data` payload of the emitted `error` event, if any. */
  function errorData(events: StreamEvent[]): Record<string, unknown> | undefined {
    const error = events.find((e) => e.type === 'error');
    return error?.data as Record<string, unknown> | undefined;
  }

  it('tags a revoked-OAuth result as auth_error (the exact 401 example)', async () => {
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'result',
          subtype: 'error_during_execution',
          errors: [
            'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
          ],
        }),
        makeSession(),
        SESSION_ID
      )
    );
    const data = errorData(events);
    expect(data?.category).toBe('auth_error');
    expect(data?.message).toContain('Failed to authenticate');
  });

  it('keeps a non-auth execution failure as execution_error', async () => {
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['Tool run_command exited with code 1'],
        }),
        makeSession(),
        SESSION_ID
      )
    );
    expect(errorData(events)?.category).toBe('execution_error');
  });

  it('leaves no error frame on a stop the CLI acked (DOR-1320)', async () => {
    // The exact shape every observed Stop produced: an error subtype whose own
    // terminal reason says the turn was cut short, carrying the CLI's internal
    // `[ede_diagnostic]` line. A person stopped this turn; the durable record
    // may not call it a crash.
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_streaming',
          errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
        }),
        makeSession(),
        SESSION_ID
      )
    );
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // And the turn still ends, still saying it was cut short — the reason the
    // projector settles as `interrupted`.
    const status = events.find((e) => e.type === 'session_status');
    expect((status?.data as Record<string, unknown>).terminalReason).toBe('aborted_streaming');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('still reports a failure that aborted its tools for a reason nobody asked for', async () => {
    // `aborted_tools` names a stop too, so this is the boundary case: the same
    // suppression, and the same terminal. What must NOT happen is the
    // suppression widening to every error subtype — a genuine failure carries
    // no abort reason at all and keeps its error frame.
    const events = await drain(
      mapResultEvent(
        msg({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          errors: ['the turn limit was reached'],
        }),
        makeSession(),
        SESSION_ID
      )
    );
    expect(errorData(events)?.category).toBe('max_turns');
  });
});
