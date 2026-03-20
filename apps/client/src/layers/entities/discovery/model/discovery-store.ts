import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { DiscoveryCandidate, ScanProgress } from '@dorkos/shared/mesh-schemas';

/** State managed by the shared discovery store. */
export interface DiscoveryState {
  /** Candidates discovered during the current or most recent scan. */
  candidates: DiscoveryCandidate[];
  /** Most recent progress snapshot from the scan stream. */
  progress: ScanProgress | null;
  /** Whether a scan is currently in progress. */
  isScanning: boolean;
  /** Error message from the most recent scan, if any. */
  error: string | null;
  /** ISO timestamp of when the most recent scan completed, or null if never scanned. */
  lastScanAt: string | null;
}

/** Actions available on the discovery store. */
export interface DiscoveryActions {
  /** Mark the store as scanning and reset ephemeral state. */
  startScan: () => void;
  /** Append a discovered candidate. */
  addCandidate: (candidate: DiscoveryCandidate) => void;
  /** Update scan progress. */
  setProgress: (progress: ScanProgress) => void;
  /** Mark the scan as complete and record timestamp. */
  completeScan: (finalProgress: ScanProgress & { timedOut: boolean }) => void;
  /** Record a scan error and stop scanning. */
  setError: (error: string) => void;
  /** Reset all state back to initial. */
  reset: () => void;
}

const INITIAL_STATE: DiscoveryState = {
  candidates: [],
  progress: null,
  isScanning: false,
  error: null,
  lastScanAt: null,
};

/**
 * Zustand store for shared discovery scan state.
 *
 * Shared across onboarding and mesh panel features so both views
 * reflect the same in-progress and completed scan results.
 */
export const useDiscoveryStore = create<DiscoveryState & DiscoveryActions>()(
  devtools(
    (set) => ({
      ...INITIAL_STATE,

      startScan: () =>
        set(
          { candidates: [], progress: null, isScanning: true, error: null },
          false,
          'discovery/startScan'
        ),

      addCandidate: (candidate) =>
        set(
          (state) => ({ candidates: [...state.candidates, candidate] }),
          false,
          'discovery/addCandidate'
        ),

      setProgress: (progress) => set({ progress }, false, 'discovery/setProgress'),

      completeScan: (finalProgress) =>
        set(
          { progress: finalProgress, isScanning: false, lastScanAt: new Date().toISOString() },
          false,
          'discovery/completeScan'
        ),

      setError: (error) => set({ error, isScanning: false }, false, 'discovery/setError'),

      reset: () => set(INITIAL_STATE, false, 'discovery/reset'),
    }),
    { name: 'DiscoveryStore' }
  )
);
