import { useRef, useCallback } from 'react';
import { useTransport } from '@/layers/shared/model';
import type { TransportScanOptions } from '@dorkos/shared/mesh-schemas';
import { useDiscoveryStore } from './discovery-store';

/**
 * Shared discovery scan hook backed by the Zustand discovery store.
 *
 * Wraps `transport.scan()` with AbortController support so the caller
 * can stop an in-progress scan. State is written to `useDiscoveryStore`
 * and is therefore shared across any component that subscribes to it.
 *
 * @returns `startScan` to begin a scan and `stopScan` to cancel it.
 */
export function useDiscoveryScan() {
  const transport = useTransport();
  const abortRef = useRef<AbortController | null>(null);

  const {
    startScan: storeStartScan,
    addCandidate,
    setProgress,
    completeScan,
    setError,
  } = useDiscoveryStore();

  const startScan = useCallback(
    (options: TransportScanOptions = { roots: [] }) => {
      // Cancel any in-flight scan
      abortRef.current?.abort();

      const controller = new AbortController();
      abortRef.current = controller;

      storeStartScan();

      void transport
        .scan(
          options,
          (event) => {
            switch (event.type) {
              case 'candidate':
                addCandidate(event.data);
                break;
              case 'progress':
                setProgress(event.data);
                break;
              case 'complete':
                completeScan(event.data);
                break;
              case 'error':
                setError(event.data.error);
                break;
            }
          },
          controller.signal
        )
        .catch((err: unknown) => {
          if (err instanceof Error && err.name !== 'AbortError') {
            setError(err.message);
          }
        });
    },
    [transport, storeStartScan, addCandidate, setProgress, completeScan, setError]
  );

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  return { startScan, stopScan };
}
