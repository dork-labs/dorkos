import { describe, it, expect, vi } from 'vitest';
import type { AdapterStatus, RelayAdapter } from '@dorkos/relay';
import {
  assessTaskDispatch,
  describeRelayRefusal,
  RELAY_NOT_BUILT,
  type RelayDispatchRefusal,
} from '../readiness.js';

/**
 * An adapter reporting a chosen connection state, and nothing else the rule
 * reads.
 *
 * @param state - What `getStatus()` reports.
 */
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
  it('says yes only when something live holds the runtime', () => {
    expect(assessTaskDispatch(receiver(), true)).toEqual({ deliverable: true });
  });

  it('reports the missing receiver BEFORE the missing runtime', () => {
    // Order is the message. Both facts are false here, and answering
    // `runtime-not-on-bus` would send an operator to the runtime settings for
    // an adapter that is simply not running.
    expect(assessTaskDispatch(undefined, false)).toEqual({
      deliverable: false,
      reason: 'no-receiver',
    });
  });

  it('refuses every state that is not connected', () => {
    const states: AdapterStatus['state'][] = [
      'disconnected',
      'error',
      'starting',
      'stopping',
      'reconnecting',
    ];
    for (const state of states) {
      expect(assessTaskDispatch(receiver(state), true), state).toEqual({
        deliverable: false,
        reason: 'receiver-not-connected',
      });
    }
  });

  it('refuses a live receiver that does not hold the runtime', () => {
    expect(assessTaskDispatch(receiver(), false)).toEqual({
      deliverable: false,
      reason: 'runtime-not-on-bus',
    });
  });

  it('says a relay that never built is not deliverable', () => {
    expect(RELAY_NOT_BUILT).toEqual({ deliverable: false, reason: 'relay-not-built' });
  });
});

describe('describeRelayRefusal', () => {
  it('has a distinct sentence for every refusal', () => {
    // The reason exists to be read. A duplicated or empty sentence is a state
    // an operator cannot tell apart from another one.
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
});
