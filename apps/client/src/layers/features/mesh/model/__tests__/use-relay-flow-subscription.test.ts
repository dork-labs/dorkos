// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// Mock useEventSubscription from the shared model barrel so we can capture
// and drive the handler without an SSE connection.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
  };
});

// Mock the reduced-motion hook — same pattern as BindingEdge.test.tsx.
const mockUsePrefersReducedMotion = vi.fn(() => false);
vi.mock('../../lib/use-reduced-motion', () => ({
  usePrefersReducedMotion: () => mockUsePrefersReducedMotion(),
}));

import { useRelayFlowSubscription } from '../use-relay-flow-subscription';
import { useEventSubscription } from '@/layers/shared/model';
import { useRelayFlowStore } from '../relay-flow-store';

beforeEach(() => {
  vi.clearAllMocks();
  useRelayFlowStore.setState({ activity: {} });
  mockUsePrefersReducedMotion.mockReturnValue(false);
});

afterEach(cleanup);

const VALID_FLOW_EVENT = {
  bindingId: 'binding-1',
  adapterId: 'adapter-1',
  agentId: 'agent-1',
  direction: 'inbound' as const,
  at: new Date().toISOString(),
};

function captureHandler(): (raw: unknown) => void {
  let handler: ((raw: unknown) => void) | undefined;
  vi.mocked(useEventSubscription).mockImplementation((_event, h) => {
    handler = h as (raw: unknown) => void;
  });
  return (raw) => handler!(raw);
}

describe('useRelayFlowSubscription', () => {
  it('subscribes to the relay_flow event on mount', () => {
    renderHook(() => useRelayFlowSubscription(true));

    expect(useEventSubscription).toHaveBeenCalledWith('relay_flow', expect.any(Function));
  });

  it('pulses binding:{bindingId} with the event direction on a valid payload while enabled', () => {
    // Purpose: parse-and-route wiring is correct.
    const dispatch = captureHandler();
    renderHook(() => useRelayFlowSubscription(true));

    dispatch(VALID_FLOW_EVENT);

    expect(useRelayFlowStore.getState().activity['binding:binding-1']).toMatchObject({
      direction: 'inbound',
    });
  });

  it('ignores a malformed payload (safeParse failure) without throwing', () => {
    // Purpose: a bad payload is silently dropped, no store write, no throw.
    const dispatch = captureHandler();
    renderHook(() => useRelayFlowSubscription(true));

    const { direction: _direction, ...malformed } = VALID_FLOW_EVENT;
    expect(() => dispatch(malformed)).not.toThrow();
    expect(useRelayFlowStore.getState().activity).toEqual({});
  });

  it('ignores an otherwise-valid payload when enabled=false', () => {
    // Purpose: the relay-off gate holds even if a stray event arrives.
    const dispatch = captureHandler();
    renderHook(() => useRelayFlowSubscription(false));

    dispatch(VALID_FLOW_EVENT);

    expect(useRelayFlowStore.getState().activity).toEqual({});
  });

  it('does not write to the store when reduced-motion is preferred, even with a valid payload and enabled=true', () => {
    // Purpose: an entry that will never animate must never be written, so it
    // can never accumulate and replay as a flurry once reduced-motion is off.
    mockUsePrefersReducedMotion.mockReturnValue(true);
    const dispatch = captureHandler();
    renderHook(() => useRelayFlowSubscription(true));

    dispatch(VALID_FLOW_EVENT);

    expect(useRelayFlowStore.getState().activity).toEqual({});
  });
});
