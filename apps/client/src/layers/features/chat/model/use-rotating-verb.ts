import { useState, useEffect, useRef, useCallback } from 'react';

interface RotatingVerbResult {
  verb: string;
  key: string;
}

export function useRotatingVerb(
  verbs: readonly string[],
  intervalMs: number,
): RotatingVerbResult {
  const keyCounterRef = useRef(0);
  const lastVerbRef = useRef<string | null>(null);

  const pickRandom = useCallback((): string => {
    if (verbs.length === 0) return '';
    if (verbs.length === 1) return verbs[0];

    let next: string;
    do {
      next = verbs[Math.floor(Math.random() * verbs.length)];
    } while (next === lastVerbRef.current);

    lastVerbRef.current = next;
    return next;
  }, [verbs]);

  const [verb, setVerb] = useState<string>(() => {
    const initial = pickRandom();
    return initial;
  });

  useEffect(() => {
    const id = setInterval(() => {
      keyCounterRef.current += 1;
      setVerb(pickRandom());
    }, intervalMs);

    return () => clearInterval(id);
  }, [intervalMs, pickRandom]);

  return {
    verb,
    key: `verb-${keyCounterRef.current}`,
  };
}
