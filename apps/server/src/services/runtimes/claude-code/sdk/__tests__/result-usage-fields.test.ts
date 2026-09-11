/**
 * The two `ModelUsage` fields the result mapper learned to read at SDK
 * 0.3.268: `costBasis` (0.3.246) and `thinkingTokens` (0.3.257).
 *
 * Both are about not overclaiming. A cost whose price table is not the published
 * one must say which table it came from, because the client renders the number
 * as a fact. A missing thinking count must not arrive as a zero, because zero
 * says the model did not think and absence says nobody measured.
 */
import { describe, it, expect } from 'vitest';
import { mapResultEvent } from '../event-mappers/result-event-mapper.js';
import type { AgentSession } from '../../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';

type ModelUsageFixture = Record<string, Record<string, unknown>>;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    lastRequestUsage: { inputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ...overrides,
  } as unknown as AgentSession;
}

// `null` means "the turn reported no cost", spelled as a value because an
// explicit `undefined` argument re-triggers the default parameter.
function resultMessage(modelUsage: ModelUsageFixture, costUsd: number | null = 0.05) {
  return {
    type: 'result',
    subtype: 'success',
    model: 'claude-opus-4-8',
    ...(costUsd === null ? {} : { total_cost_usd: costUsd }),
    usage: { input_tokens: 1000, output_tokens: 500 },
    modelUsage,
  } as unknown as Parameters<typeof mapResultEvent>[0];
}

/** The `session_status` the result yields, which is always its first event. */
async function statusFor(
  modelUsage: ModelUsageFixture,
  session: AgentSession = makeSession(),
  costUsd: number | null = 0.05
): Promise<Record<string, unknown>> {
  const events: StreamEvent[] = [];
  for await (const event of mapResultEvent(resultMessage(modelUsage, costUsd), session, 's1')) {
    events.push(event);
  }
  const status = events.find((e) => e.type === 'session_status');
  expect(status).toBeDefined();
  return status!.data as Record<string, unknown>;
}

const MODEL = 'claude-opus-4-8';
const OTHER = 'claude-haiku-4-5';

describe('turnThinkingTokens', () => {
  it('sums the reported thinking tokens across every model in the turn', async () => {
    const status = await statusFor({
      [MODEL]: { inputTokens: 100, outputTokens: 900, thinkingTokens: 700 },
      [OTHER]: { inputTokens: 50, outputTokens: 200, thinkingTokens: 40 },
    });

    expect(status.turnThinkingTokens).toBe(740);
    // A share of the output, not an addition to it: a reader that adds the two
    // double-counts, so the sum must stay under the output total.
    expect(status.turnOutputTokens).toBe(1100);
  });

  it('is ABSENT, not zero, when no model reported the field', async () => {
    // Every turn on a CLI that predates the field lands here. A `0` would read as
    // "the model did not think", which is a measurement nobody took.
    const status = await statusFor({
      [MODEL]: { inputTokens: 100, outputTokens: 900 },
    });

    expect(status).not.toHaveProperty('turnThinkingTokens');
    expect(status.turnOutputTokens).toBe(900);
  });

  it('reports the partial sum when only some models recorded it', async () => {
    // A session resumed across a CLI upgrade. Partial is what the SDK documents
    // and what the field doc warns a reader about; silently dropping it would
    // throw away the half that IS known.
    const status = await statusFor({
      [MODEL]: { inputTokens: 100, outputTokens: 900, thinkingTokens: 700 },
      [OTHER]: { inputTokens: 50, outputTokens: 200 },
    });

    expect(status.turnThinkingTokens).toBe(700);
  });
});

describe('costBasis', () => {
  it('reports `list` when every model priced off the published table', async () => {
    const status = await statusFor({
      [MODEL]: { inputTokens: 1, outputTokens: 1, costBasis: 'list' },
      [OTHER]: { inputTokens: 1, outputTokens: 1, costBasis: 'list' },
    });

    expect(status.usage).toMatchObject({ costUsd: 0.05, costBasis: 'list' });
  });

  it('reads a model with no basis yet as `list`', async () => {
    // The SDK's own field doc says to: absent means this process has not priced a
    // request for the model yet, not that the price was odd. It is also what every
    // DorkOS cost figure meant before the field existed.
    const status = await statusFor({
      [MODEL]: { inputTokens: 1, outputTokens: 1 },
    });

    expect(status.usage).toMatchObject({ costBasis: 'list' });
  });

  it('reports `managed` when any model was priced at the organization’s rates', async () => {
    const status = await statusFor({
      [MODEL]: { inputTokens: 1, outputTokens: 1, costBasis: 'list' },
      [OTHER]: { inputTokens: 1, outputTokens: 1, costBasis: 'managed' },
    });

    expect(status.usage).toMatchObject({ costBasis: 'managed' });
  });

  it('reports `unknown` as soon as one model was priced at a guess', async () => {
    // The weakest claim wins: one unpriced model makes the whole summed figure a
    // guess, and calling that sum `managed` because the other model was would be
    // the more confident of two available answers.
    const status = await statusFor({
      [MODEL]: { inputTokens: 1, outputTokens: 1, costBasis: 'managed' },
      [OTHER]: { inputTokens: 1, outputTokens: 1, costBasis: 'unknown' },
    });

    expect(status.usage).toMatchObject({ costBasis: 'unknown' });
  });

  it('is absent when the result carried no models at all', async () => {
    const status = await statusFor({});

    expect(status.usage).toEqual({ kind: 'pay-as-you-go', costUsd: 0.05 });
  });

  it('rides beside a held subscription usage without disturbing it', async () => {
    const session = makeSession({
      lastSubscriptionUsage: {
        kind: 'subscription',
        utilization: 0.4,
        windowLabel: '5-hour window',
        state: 'ok',
      },
    });

    const status = await statusFor(
      { [MODEL]: { inputTokens: 1, outputTokens: 1, costBasis: 'unknown' } },
      session
    );

    expect(status.usage).toEqual({
      kind: 'subscription',
      utilization: 0.4,
      windowLabel: '5-hour window',
      state: 'ok',
      costUsd: 0.05,
      costBasis: 'unknown',
    });
  });

  it('is not attached when the turn reported no cost to describe', async () => {
    // A basis with no figure under it describes nothing, and would linger on the
    // session's held subscription usage as a claim about a number that is gone.
    const session = makeSession({
      lastSubscriptionUsage: { kind: 'subscription', utilization: 0.4 },
    });

    const status = await statusFor(
      { [MODEL]: { inputTokens: 1, outputTokens: 1, costBasis: 'unknown' } },
      session,
      null
    );

    expect(status.usage).toEqual({ kind: 'subscription', utilization: 0.4 });
  });
});
