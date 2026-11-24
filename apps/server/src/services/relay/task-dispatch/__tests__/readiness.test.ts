import { describe, it, expect, vi } from 'vitest';
import type { AdapterStatus, RelayAdapter } from '@dorkos/relay';
import {
  assessTaskDispatch,
  describeRelayRefusal,
  RELAY_NOT_BUILT,
  type RelayDispatchRefusal,
} from '../readiness.js';

/** An adapter reporting a chosen connection state. */
function receiver(state: AdapterStatus['state'] = 'connected'): RelayAdapter {
  return {
    id: 'claude-code',
    subjectPrefix: ['relay.system.tasks.'],
    displayName: 'Claude Code',
    start: vi.fn(),
    stop: vi.fn(),
    deliver: vi.fn(),
    getStatus: () => ({ state, messageCount: { inbound: 0, outbound: 0 }, errorCount: 0 }),
  } as unknown as RelayAdapter;
}

describe('assessTaskDispatch', () => {
  it('says yes only when a connected receiver holds the runtime', () => {
    expect(assessTaskDispatch(receiver(), true)).toEqual({ deliverable: true });
    expect(assessTaskDispatch(receiver(), false)).toMatchObject({ reason: 'runtime-not-on-bus' });
    expect(RELAY_NOT_BUILT).toEqual({ deliverable: false, reason: 'relay-not-built' });
    for (const state of [
      'disconnected',
      'error',
      'starting',
      'stopping',
      'reconnecting',
    ] as const) {
      expect(assessTaskDispatch(receiver(state), true), state).toMatchObject({
        reason: 'receiver-not-connected',
      });
    }
  });

  it('reports the missing receiver BEFORE the missing runtime', () => {
    // Answering runtime-not-on-bus would send an operator to the wrong settings.
    expect(assessTaskDispatch(undefined, false)).toEqual({
      deliverable: false,
      reason: 'no-receiver',
    });
  });
});

it('describeRelayRefusal has a distinct sentence for every refusal', () => {
  const reasons: RelayDispatchRefusal[] = [
    'relay-off',
    'relay-not-built',
    'no-receiver',
    'receiver-not-connected',
    'runtime-not-on-bus',
  ];
  const sentences = reasons.map(describeRelayRefusal);
  expect(new Set(sentences).size).toBe(reasons.length);
  for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(10);
});
