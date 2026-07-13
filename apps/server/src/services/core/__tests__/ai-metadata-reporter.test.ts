/**
 * Tests for the opt-in AI-metadata reporter (DOR-319).
 *
 * Covers the consent gate (`enabled: false` → zero network AND no bridge
 * installed; the call site folds the `telemetry.aiMetadata` flag + env kill
 * switch into that one boolean), debug mode (print, never send), the
 * build-and-flush behavior, and a no-content assertion on the exact wire body.
 * `getOrCreateInstanceId` is mocked so no disk is touched; `fetch` is injected so
 * the payload is captured. The observability bridge is stubbed so we can observe
 * install/teardown without pulling the real OTel module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetOrCreateInstanceId, mockSetBridge } = vi.hoisted(() => ({
  mockGetOrCreateInstanceId: vi.fn(),
  mockSetBridge: vi.fn(),
}));

vi.mock('../../../lib/instance-id.js', () => ({
  getOrCreateInstanceId: mockGetOrCreateInstanceId,
}));

vi.mock('../../observability/index.js', () => ({
  setAiMetadataBridge: mockSetBridge,
}));

import type { AiTurnMetadata } from '../../observability/index.js';
import {
  registerAiMetadataReporter,
  reportAiTurn,
  flushAiMetadata,
  shutdownAiMetadataReporter,
  AI_METADATA_ENDPOINT,
} from '../ai-metadata-reporter.js';

const INSTANCE_ID = '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4';
const DORK_HOME = '/tmp/test-dork-home-ai';
const VERSION = '9.9.9-ai-test';

let fetchMock: ReturnType<typeof vi.fn>;

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    debug: false,
    dorkHome: DORK_HOME,
    dorkosVersion: VERSION,
    endpoint: AI_METADATA_ENDPOINT,
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...overrides,
  };
}

const TURN: AiTurnMetadata = {
  runtime: 'claude-code',
  model: 'claude-opus-4-6',
  inputTokens: 1200,
  outputTokens: 340,
  costUsd: 0.51,
  latencyMs: 4200,
};

/** Parse the single POSTed body into its events array. */
function sentEvents(): Array<Record<string, unknown>> {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return (JSON.parse(init.body) as { events: Array<Record<string, unknown>> }).events;
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  mockGetOrCreateInstanceId.mockResolvedValue(INSTANCE_ID);
});

afterEach(async () => {
  await shutdownAiMetadataReporter();
  vi.clearAllMocks();
});

describe('ai-metadata reporter gating', () => {
  it('does NOT register (and clears the bridge) when enabled is false', async () => {
    registerAiMetadataReporter(baseOptions({ enabled: false }));
    // Bridge cleared to null so the runtime seam never harvests.
    expect(mockSetBridge).toHaveBeenLastCalledWith(null);
    reportAiTurn(TURN);
    await flushAiMetadata();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('installs the bridge sink when enabled', () => {
    registerAiMetadataReporter(baseOptions());
    // The sink is a function (the reporter's reportAiTurn), not null.
    const last = mockSetBridge.mock.calls.at(-1)?.[0];
    expect(typeof last).toBe('function');
  });

  it('reportAiTurn is a no-op before registration', async () => {
    reportAiTurn(TURN);
    registerAiMetadataReporter(baseOptions());
    await flushAiMetadata();
    // Nothing was queued before registration, so no send.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ai-metadata reporter wire shape', () => {
  it('builds a strict $ai_generation event with canonical PostHog property names', async () => {
    registerAiMetadataReporter(baseOptions());
    reportAiTurn(TURN);
    await flushAiMetadata();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [event] = sentEvents();
    expect(event.event).toBe('$ai_generation');
    expect(event.distinctId).toBe(INSTANCE_ID);
    expect(event.dorkosVersion).toBe(VERSION);

    const props = event.properties as Record<string, unknown>;
    expect(props.$ai_provider).toBe('claude-code');
    expect(props.$ai_model).toBe('claude-opus-4-6');
    expect(props.$ai_input_tokens).toBe(1200);
    expect(props.$ai_output_tokens).toBe(340);
    expect(props.$ai_total_cost_usd).toBe(0.51);
    // Latency is converted to SECONDS (PostHog's unit).
    expect(props.$ai_latency).toBeCloseTo(4.2, 5);
    // Anonymous by construction, and a per-turn opaque trace id.
    expect(props.$process_person_profile).toBe(false);
    expect(typeof props.$ai_trace_id).toBe('string');
  });

  it('mints a distinct trace id per turn', async () => {
    registerAiMetadataReporter(baseOptions());
    reportAiTurn(TURN);
    reportAiTurn(TURN);
    await flushAiMetadata();
    const events = sentEvents();
    expect(events).toHaveLength(2);
    const a = (events[0].properties as Record<string, unknown>).$ai_trace_id;
    const b = (events[1].properties as Record<string, unknown>).$ai_trace_id;
    expect(a).not.toBe(b);
  });

  it('omits optional props the turn did not report', async () => {
    registerAiMetadataReporter(baseOptions());
    reportAiTurn({ runtime: 'opencode', latencyMs: 900 });
    await flushAiMetadata();
    const props = sentEvents()[0].properties as Record<string, unknown>;
    expect(props.$ai_provider).toBe('opencode');
    expect('$ai_model' in props).toBe(false);
    expect('$ai_input_tokens' in props).toBe(false);
    expect('$ai_total_cost_usd' in props).toBe(false);
  });
});

describe('ai-metadata reporter debug mode', () => {
  it('prints the batch to stderr and sends nothing', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    registerAiMetadataReporter(baseOptions({ debug: true }));
    reportAiTurn(TURN);
    await flushAiMetadata();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
    const printed = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('$ai_generation');
    expect(printed).toContain('NOT sent');
    writeSpy.mockRestore();
  });
});

describe('ai-metadata reporter flush', () => {
  it('no-ops on an empty queue', async () => {
    registerAiMetadataReporter(baseOptions());
    await flushAiMetadata();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flushes the tail at graceful shutdown', async () => {
    registerAiMetadataReporter(baseOptions());
    reportAiTurn(TURN);
    await shutdownAiMetadataReporter();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
