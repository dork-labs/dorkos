import { useCallback, useMemo, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'dorkos-agent-frecency';
const MAX_ENTRIES = 50;
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface FrecencyEntry {
  agentId: string;
  lastUsed: string; // ISO timestamp
  useCount: number;
}

/** Calculate frecency score: higher is more recent/frequent. */
function calcScore(entry: FrecencyEntry): number {
  const hoursSinceUse = (Date.now() - new Date(entry.lastUsed).getTime()) / (1000 * 60 * 60);
  return entry.useCount / (1 + hoursSinceUse * 0.1);
}

function readEntries(): FrecencyEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FrecencyEntry[];
    if (!Array.isArray(parsed)) return [];
    // Prune old entries on read
    const cutoff = Date.now() - PRUNE_AGE_MS;
    return parsed.filter((e) => new Date(e.lastUsed).getTime() > cutoff).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeEntries(entries: FrecencyEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // localStorage unavailable — silently degrade
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
 * Track and retrieve agent usage frecency from localStorage.
 *
 * Frecency = useCount / (1 + hoursSinceUse * 0.1).
 * Entries older than 30 days with 0 recent usage are pruned on read.
 * Maximum 50 entries stored.
 */
export function useAgentFrecency() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => '[]');
  const entries = useMemo(() => {
    try {
      const parsed = JSON.parse(raw) as FrecencyEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [raw]);

  const recordUsage = useCallback((agentId: string) => {
    const current = readEntries();
    const existing = current.find((e) => e.agentId === agentId);
    let updated: FrecencyEntry[];
    if (existing) {
      updated = current.map((e) =>
        e.agentId === agentId
          ? { ...e, lastUsed: new Date().toISOString(), useCount: e.useCount + 1 }
          : e,
      );
    } else {
      updated = [...current, { agentId, lastUsed: new Date().toISOString(), useCount: 1 }];
    }
    writeEntries(updated);
    emitChange();
  }, []);

  const getSortedAgentIds = useCallback(
    (allAgentIds: string[]): string[] => {
      const scoreMap = new Map<string, number>();
      for (const entry of entries) {
        scoreMap.set(entry.agentId, calcScore(entry));
      }
      return [...allAgentIds].sort((a, b) => {
        const scoreA = scoreMap.get(a) ?? -1;
        const scoreB = scoreMap.get(b) ?? -1;
        if (scoreA === scoreB) return a.localeCompare(b); // alphabetical fallback
        return scoreB - scoreA; // higher score first
      });
    },
    [entries],
  );

  return { entries, recordUsage, getSortedAgentIds };
}
