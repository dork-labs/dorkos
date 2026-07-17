/**
 * Short-lived, per-edge activity store for the topology's relay-flow pulse.
 *
 * Keyed by edge id (`binding:{bindingId}`), this store is the single source
 * of truth `BindingEdge` reads to decide whether to render a traveling pulse.
 * Entries are self-expiring — they are cleared by the edge's own
 * animation-complete callback, not a wall-clock timer — so there is nothing
 * to leak.
 *
 * @module features/mesh/model/relay-flow-store
 */
import { create } from 'zustand';
import type { RelayFlowDirection } from '@dorkos/shared/relay-schemas';
import { MAX_CONCURRENT_PULSES } from '../config/relay-flow-constants';

/** A transient, self-expiring activity entry for one binding edge. */
export interface EdgeActivity {
  /** Travel direction, forwarded from the server's `relay_flow` event. */
  direction: RelayFlowDirection;
  /** Monotonic id so a fresh pulse re-keys the motion element even back-to-back. */
  nonce: number;
}

/** State + actions backing the relay-flow pulse. */
export interface RelayFlowState {
  /** Keyed by edge id (`binding:{bindingId}`). Absent = idle. */
  activity: Record<string, EdgeActivity>;
  /** Register a delivered message on an edge (coalesced per edge). */
  pulse: (edgeId: string, direction: RelayFlowDirection) => void;
  /** Clear one edge's entry (called on animation-complete). */
  clear: (edgeId: string) => void;
  /** Drop all activity (topology unmount). */
  reset: () => void;
}

/** Monotonic counter for {@link EdgeActivity.nonce}, module-scoped across pulses. */
let nonceCounter = 0;

/**
 * Store backing the topology's relay-flow pulse. `pulse` is a no-op while an
 * edge already has an in-flight entry (single in-flight per edge — bursts
 * collapse to one pulse, no strobe) and drops the new entry once
 * {@link MAX_CONCURRENT_PULSES} is reached (bounded concurrency). Distinct
 * edge ids are independent — ten agents receiving at once is ten wires
 * pulsing, the fleet signal.
 */
export const useRelayFlowStore = create<RelayFlowState>((set, get) => ({
  activity: {},
  pulse: (edgeId, direction) => {
    const { activity } = get();
    if (activity[edgeId]) return;
    if (Object.keys(activity).length >= MAX_CONCURRENT_PULSES) return;
    nonceCounter += 1;
    set({ activity: { ...activity, [edgeId]: { direction, nonce: nonceCounter } } });
  },
  clear: (edgeId) => {
    const { activity } = get();
    if (!(edgeId in activity)) return;
    const next = { ...activity };
    delete next[edgeId];
    set({ activity: next });
  },
  reset: () => set({ activity: {} }),
}));
