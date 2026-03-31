/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { DiscoveryCandidate, ExistingAgent, ScanProgress } from '@dorkos/shared/mesh-schemas';
import { useDiscoveryStore } from '../model/discovery-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeCandidate = (path: string): DiscoveryCandidate => ({
  path,
  strategy: 'claude-md',
  discoveredAt: new Date().toISOString(),
  hints: {
    suggestedName: 'test-project',
    detectedRuntime: 'claude-code',
  },
});

const makeExistingAgent = (path: string): ExistingAgent => ({
  path,
  name: 'existing-agent',
  runtime: 'claude-code',
  description: 'An existing agent',
});

const makeProgress = (scannedDirs: number, foundAgents: number): ScanProgress => ({
  scannedDirs,
  foundAgents,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDiscoveryStore', () => {
  beforeEach(() => {
    useDiscoveryStore.getState().reset();
  });

  it('starts with empty initial state', () => {
    const state = useDiscoveryStore.getState();
    expect(state.candidates).toEqual([]);
    expect(state.existingAgents).toEqual([]);
    expect(state.progress).toBeNull();
    expect(state.isScanning).toBe(false);
    expect(state.error).toBeNull();
    expect(state.lastScanAt).toBeNull();
  });

  it('startScan clears previous state and sets isScanning', () => {
    const store = useDiscoveryStore.getState();
    // Pre-seed some state
    store.addCandidate(makeCandidate('/some/path'));
    store.addExistingAgent(makeExistingAgent('/existing'));
    store.setProgress(makeProgress(10, 1));
    store.setError('previous error');

    store.startScan();

    const state = useDiscoveryStore.getState();
    expect(state.isScanning).toBe(true);
    expect(state.candidates).toEqual([]);
    expect(state.existingAgents).toEqual([]);
    expect(state.progress).toBeNull();
    expect(state.error).toBeNull();
  });

  it('addCandidate appends to candidates array', () => {
    const store = useDiscoveryStore.getState();
    const c1 = makeCandidate('/proj/a');
    const c2 = makeCandidate('/proj/b');

    store.addCandidate(c1);
    store.addCandidate(c2);

    expect(useDiscoveryStore.getState().candidates).toEqual([c1, c2]);
  });

  it('addExistingAgent appends to existingAgents array', () => {
    const store = useDiscoveryStore.getState();
    const a1 = makeExistingAgent('/existing/a');
    const a2 = makeExistingAgent('/existing/b');

    store.addExistingAgent(a1);
    store.addExistingAgent(a2);

    expect(useDiscoveryStore.getState().existingAgents).toEqual([a1, a2]);
  });

  it('completeScan sets lastScanAt, stops scanning, and records final progress', () => {
    const store = useDiscoveryStore.getState();
    store.startScan();
    const finalProgress = { scannedDirs: 200, foundAgents: 3, timedOut: false };
    store.completeScan(finalProgress);

    const state = useDiscoveryStore.getState();
    expect(state.isScanning).toBe(false);
    expect(state.progress).toEqual(finalProgress);
    expect(state.lastScanAt).not.toBeNull();
    expect(new Date(state.lastScanAt!).getTime()).toBeGreaterThan(0);
  });
});
