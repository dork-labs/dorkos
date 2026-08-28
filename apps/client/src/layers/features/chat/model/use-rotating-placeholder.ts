import { useState, useEffect, useRef } from 'react';
import { STORAGE_KEYS } from '@/layers/shared/lib';

/** Interval between placeholder text transitions (ms). */
const DEFAULT_INTERVAL_MS = 5000;

/**
 * Complete passes through the hint list before the placeholder settles on the
 * static default for good. The hints exist to teach; once they have, a resting
 * composer should rest.
 */
const MAX_HINT_CYCLES = 3;

/** Read how many full hint cycles this browser has already been shown. */
function readCompletedCycles(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEYS.PLACEHOLDER_HINT_CYCLES));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

/** Record one more completed hint cycle and return the new total. */
function recordCompletedCycle(): number {
  const next = readCompletedCycles() + 1;
  try {
    localStorage.setItem(STORAGE_KEYS.PLACEHOLDER_HINT_CYCLES, String(next));
  } catch {}
  return next;
}

interface UseRotatingPlaceholderOptions {
  /** Text shown between hints (the default placeholder). */
  defaultText: string;
  /** Hint strings to interleave with the default text. */
  hints: readonly string[];
  /** Whether the rotation cycle is active. */
  enabled: boolean;
  /** Time between transitions in milliseconds. */
  intervalMs?: number;
}

interface RotatingPlaceholderResult {
  /** The current placeholder text to display. */
  text: string;
  /** A monotonically increasing key for AnimatePresence transitions. */
  key: number;
}

/** One rendered placeholder frame. */
interface PlaceholderFrame {
  /** Monotonic transition counter, for AnimatePresence. */
  key: number;
  /** Index into the shuffled hints, or -1 while the default text shows. */
  hintIndex: number;
}

/** Fisher-Yates shuffle (returns new array). */
function shuffle<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i]!, result[j]!] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Cycle between a default placeholder and shuffled hints, then settle.
 *
 * Pattern: default → hint[0] → default → hint[1] → … Returns to the default
 * text whenever `enabled` goes false, and picks the hint sequence back up where
 * it left off, so a user who types every few seconds still sees every hint.
 * After {@link MAX_HINT_CYCLES} complete passes through the list — counted
 * across page loads — the rotation stops for good and the default text stays.
 */
export function useRotatingPlaceholder({
  defaultText,
  hints,
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseRotatingPlaceholderOptions): RotatingPlaceholderResult {
  const [shuffled] = useState(() => (hints.length > 0 ? shuffle(hints) : []));
  const [settled, setSettled] = useState(() => readCompletedCycles() >= MAX_HINT_CYCLES);
  const [frame, setFrame] = useState<PlaceholderFrame>({ key: 0, hintIndex: -1 });
  const keyRef = useRef(0);
  const hintsShownRef = useRef(0);
  const showingHintRef = useRef(false);

  useEffect(() => {
    if (settled || !enabled || hints.length === 0) {
      // Snap back to the default text; leave the hint cursor where it is.
      if (showingHintRef.current) {
        showingHintRef.current = false;
        keyRef.current += 1;
        setFrame({ key: keyRef.current, hintIndex: -1 });
      }
      return;
    }
    const id = setInterval(() => {
      keyRef.current += 1;
      showingHintRef.current = !showingHintRef.current;
      if (!showingHintRef.current) {
        setFrame({ key: keyRef.current, hintIndex: -1 });
        return;
      }
      const hintIndex = hintsShownRef.current % hints.length;
      hintsShownRef.current += 1;
      if (hintsShownRef.current % hints.length === 0 && recordCompletedCycle() >= MAX_HINT_CYCLES) {
        setSettled(true);
      }
      setFrame({ key: keyRef.current, hintIndex });
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, hints.length, intervalMs, settled]);

  const text = frame.hintIndex >= 0 ? (shuffled[frame.hintIndex] ?? defaultText) : defaultText;

  return { text, key: frame.key };
}
