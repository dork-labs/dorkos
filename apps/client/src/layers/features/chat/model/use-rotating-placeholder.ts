import { useState, useEffect, useRef } from 'react';

/** Interval between placeholder text transitions (ms). */
const DEFAULT_INTERVAL_MS = 5000;

interface UseRotatingPlaceholderOptions {
  /** Text shown on even ticks (the default placeholder). */
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
  /** Whether the current text is a hint (true) or the default (false). */
  isHint: boolean;
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
 * Cycle between a default placeholder and shuffled hints.
 *
 * Pattern: default → hint[0] → default → hint[1] → … (wraps).
 * Resets to the default whenever `enabled` transitions to `true`.
 */
export function useRotatingPlaceholder({
  defaultText,
  hints,
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseRotatingPlaceholderOptions): RotatingPlaceholderResult {
  const [tick, setTick] = useState(0);
  const shuffledRef = useRef<string[]>([]);

  // Shuffle hints on first use
  if (shuffledRef.current.length === 0 && hints.length > 0) {
    shuffledRef.current = shuffle(hints);
  }

  useEffect(() => {
    if (!enabled || hints.length === 0) {
      setTick(0);
      return;
    }
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [enabled, hints.length, intervalMs]);

  // Even ticks show default, odd ticks show a hint
  const isHint = tick > 0 && tick % 2 === 1;
  const hintIndex = Math.floor(tick / 2) % (shuffledRef.current.length || 1);
  const text = isHint ? (shuffledRef.current[hintIndex] ?? defaultText) : defaultText;

  return { text, key: tick, isHint };
}
