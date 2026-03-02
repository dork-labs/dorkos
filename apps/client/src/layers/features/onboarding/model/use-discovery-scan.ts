import { useState, useCallback, useRef } from 'react';

/** Progress snapshot emitted during scanning. */
export interface ScanProgress {
  scannedDirs: number;
  foundAgents: number;
}

/** A discovered project as returned by the scan SSE endpoint. */
export interface ScanCandidate {
  path: string;
  name: string;
  markers: string[];
  gitBranch: string | null;
  gitRemote: string | null;
  hasDorkManifest: boolean;
}

/** Options for starting a discovery scan. */
export interface ScanOptions {
  root?: string;
  maxDepth?: number;
  timeout?: number;
}

/**
 * Stream discovery scan results from `POST /api/discovery/scan` via SSE.
 *
 * Manages candidates, progress, and scanning state. The scan endpoint
 * returns an SSE stream with `candidate`, `progress`, and `complete` events.
 *
 * Note: This hook uses raw `fetch()` because the discovery endpoint uses
 * SSE streaming (POST + progressive events), which the Transport abstraction
 * does not support. The relative `/api/` URL works via Vite's dev proxy.
 */
export function useDiscoveryScan() {
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startScan = useCallback((options?: ScanOptions) => {
    // Abort any in-flight scan
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    setCandidates([]);
    setProgress(null);
    setError(null);
    setIsScanning(true);

    // Fire-and-forget the async SSE reader
    void (async () => {
      try {
        const response = await fetch('/api/discovery/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options ?? {}),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({ error: response.statusText }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let eventType = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ') && eventType) {
              const data = JSON.parse(line.slice(6));
              handleEvent(eventType, data);
              eventType = '';
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Scan failed');
        }
      } finally {
        setIsScanning(false);
      }
    })();
  }, []);

  /** Dispatch parsed SSE events to the appropriate state setter. */
  function handleEvent(type: string, data: unknown) {
    switch (type) {
      case 'candidate':
        setCandidates((prev) => [...prev, data as ScanCandidate]);
        setProgress((prev) =>
          prev ? { ...prev, foundAgents: prev.foundAgents + 1 } : { scannedDirs: 0, foundAgents: 1 }
        );
        break;
      case 'progress':
        setProgress(data as ScanProgress);
        break;
      case 'complete':
        setProgress(data as ScanProgress);
        break;
      case 'error':
        setError((data as { error: string }).error);
        break;
    }
  }

  return {
    candidates,
    isScanning,
    progress,
    startScan,
    error,
  };
}
