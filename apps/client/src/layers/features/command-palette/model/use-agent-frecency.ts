import { useCallback, useMemo, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'dorkos:agent-frecency-v2';
const MAX_TIMESTAMPS = 10;

/** Epoch-ms bucket boundaries and their point values. */
const BUCKETS: Array<{ maxAgeMs: number; points: number }> = [
  { maxAgeMs: 4 * 60 * 60 * 1000, points: 100 }, // Past 4 hours
  { maxAgeMs: 24 * 60 * 60 * 1000, points: 80 }, // Past 24 hours
  { maxAgeMs: 3 * 24 * 60 * 60 * 1000, points: 60 }, // Past 3 days
  { maxAgeMs: 7 * 24 * 60 * 60 * 1000, points: 40 }, // Past week
  { maxAgeMs: 30 * 24 * 60 * 60 * 1000, points: 20 }, // Past month
  { maxAgeMs: 90 * 24 * 60 * 60 * 1000, points: 10 }, // Past 90 days
];

export interface FrecencyRecord {
  agentId: string;
  /** Epoch-ms timestamps, most recent first. Max 10 entries. */
  timestamps: number[];
  totalCount: number;
}

/** Calculate the bucket score for a single timestamp. */
function bucketScore(timestamp: number, now: number): number {
  const age = now - timestamp;
  for (const bucket of BUCKETS) {
    if (age <= bucket.maxAgeMs) return bucket.points;
  }
  return 0; // Beyond 90 days
}

/**
 * Calculate the frecency score for a record using Slack's bucket algorithm.
 *
 * Formula: totalCount * bucketSum / min(timestamps.length, MAX_TIMESTAMPS)
 * The denominator caps at MAX_TIMESTAMPS to prevent old high-frequency items
 * from dominating through sheer volume.
 *
 * @param record - The frecency record to score
 * @param now - Current epoch-ms timestamp (defaults to Date.now())
 */
export function calcFrecencyScore(record: FrecencyRecord, now: number = Date.now()): number {
  if (record.timestamps.length === 0) return 0;
  const bucketSum = record.timestamps.reduce((sum, ts) => sum + bucketScore(ts, now), 0);
  const denominator = Math.min(record.timestamps.length, MAX_TIMESTAMPS);
  return (record.totalCount * bucketSum) / denominator;
}

function readRecords(): FrecencyRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FrecencyRecord[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function writeRecords(records: FrecencyRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // localStorage unavailable -- silently degrade
  }
}

// External store listeners for useSyncExternalStore
let listeners: Array<() => void> = [];

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function emitChange(): void {
  listeners.forEach((l) => l());
}

function getSnapshot(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '[]';
  } catch {
    return '[]';
  }
}

/**
 * Track and retrieve agent usage frecency using Slack's bucket algorithm.
 *
 * Storage key: dorkos:agent-frecency-v2 (new key, old data left in place and ignored).
 * Stores up to 10 timestamps per agent, most recent first.
 * Score formula: totalCount * bucketSum / min(timestamps.length, 10)
 */
export function useAgentFrecency() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => '[]');
  const records = useMemo(() => {
    try {
      const parsed = JSON.parse(raw) as FrecencyRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [raw]);

  const recordUsage = useCallback((agentId: string) => {
    const current = readRecords();
    const now = Date.now();
    const existing = current.find((r) => r.agentId === agentId);

    let updated: FrecencyRecord[];
    if (existing) {
      updated = current.map((r) =>
        r.agentId === agentId
          ? {
              ...r,
              timestamps: [now, ...r.timestamps].slice(0, MAX_TIMESTAMPS),
              totalCount: r.totalCount + 1,
            }
          : r,
      );
    } else {
      updated = [...current, { agentId, timestamps: [now], totalCount: 1 }];
    }
    writeRecords(updated);
    emitChange();
  }, []);

  const getSortedAgentIds = useCallback(
    (allAgentIds: string[]): string[] => {
      const now = Date.now();
      const scoreMap = new Map<string, number>();
      for (const record of records) {
        scoreMap.set(record.agentId, calcFrecencyScore(record, now));
      }
      return [...allAgentIds].sort((a, b) => {
        const scoreA = scoreMap.get(a) ?? -1;
        const scoreB = scoreMap.get(b) ?? -1;
        if (scoreA === scoreB) return a.localeCompare(b);
        return scoreB - scoreA;
      });
    },
    [records],
  );

  return { entries: records, recordUsage, getSortedAgentIds };
}
