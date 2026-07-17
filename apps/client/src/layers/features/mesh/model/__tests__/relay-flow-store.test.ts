import { describe, it, expect, beforeEach } from 'vitest';
import { useRelayFlowStore } from '../relay-flow-store';
import { MAX_CONCURRENT_PULSES } from '../../config/relay-flow-constants';

beforeEach(() => {
  useRelayFlowStore.setState({ activity: {} });
});

describe('useRelayFlowStore', () => {
  it('pulse(edgeId) sets an entry with a defined nonce', () => {
    // Purpose: a pulse registers on the store.
    useRelayFlowStore.getState().pulse('binding:edge-1', 'inbound');
    const entry = useRelayFlowStore.getState().activity['binding:edge-1'];
    expect(entry).toBeDefined();
    expect(entry.direction).toBe('inbound');
    expect(entry.nonce).toEqual(expect.any(Number));
  });

  it('a second pulse while the first is in flight is a no-op (no strobe)', () => {
    // Purpose: bursts on one edge collapse to a single pulse.
    useRelayFlowStore.getState().pulse('binding:edge-1', 'inbound');
    const first = useRelayFlowStore.getState().activity['binding:edge-1'];

    useRelayFlowStore.getState().pulse('binding:edge-1', 'inbound');
    const second = useRelayFlowStore.getState().activity['binding:edge-1'];

    expect(second).toEqual(first);
  });

  it('pulse(edgeA) + pulse(edgeB) set two independent entries (cross-edge concurrency)', () => {
    // Purpose: distinct wires lighting up at once is the fleet signal.
    useRelayFlowStore.getState().pulse('binding:edge-a', 'inbound');
    useRelayFlowStore.getState().pulse('binding:edge-b', 'inbound');

    const { activity } = useRelayFlowStore.getState();
    expect(Object.keys(activity)).toEqual(
      expect.arrayContaining(['binding:edge-a', 'binding:edge-b'])
    );
    expect(Object.keys(activity)).toHaveLength(2);
  });

  it('clear(edgeId) removes the entry, and a subsequent pulse re-registers with an incremented nonce', () => {
    // Purpose: the edge is eligible again after the pulse ends, with a fresh re-key.
    useRelayFlowStore.getState().pulse('binding:edge-1', 'inbound');
    const first = useRelayFlowStore.getState().activity['binding:edge-1'];

    useRelayFlowStore.getState().clear('binding:edge-1');
    expect(useRelayFlowStore.getState().activity['binding:edge-1']).toBeUndefined();

    useRelayFlowStore.getState().pulse('binding:edge-1', 'inbound');
    const second = useRelayFlowStore.getState().activity['binding:edge-1'];
    expect(second).toBeDefined();
    expect(second.nonce).toBeGreaterThan(first.nonce);
  });

  it('drops the pulse past MAX_CONCURRENT_PULSES distinct edges (bounded concurrency)', () => {
    // Purpose: bounds the active animation count on a large mesh.
    for (let i = 0; i < MAX_CONCURRENT_PULSES; i++) {
      useRelayFlowStore.getState().pulse(`binding:edge-${i}`, 'inbound');
    }
    expect(Object.keys(useRelayFlowStore.getState().activity)).toHaveLength(MAX_CONCURRENT_PULSES);

    useRelayFlowStore.getState().pulse('binding:edge-overflow', 'inbound');

    expect(Object.keys(useRelayFlowStore.getState().activity)).toHaveLength(MAX_CONCURRENT_PULSES);
    expect(useRelayFlowStore.getState().activity['binding:edge-overflow']).toBeUndefined();
  });

  it('reset() clears all entries regardless of count', () => {
    // Purpose: topology-unmount cleanup — no orphaned entries survive.
    useRelayFlowStore.getState().pulse('binding:edge-a', 'inbound');
    useRelayFlowStore.getState().pulse('binding:edge-b', 'inbound');

    useRelayFlowStore.getState().reset();

    expect(useRelayFlowStore.getState().activity).toEqual({});
  });
});
