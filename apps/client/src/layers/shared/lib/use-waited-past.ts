/**
 * A wait that has gone on too long.
 *
 * @module shared/lib/use-waited-past
 */
import { useEffect, useRef, useState } from 'react';

/**
 * How long a chat holds its messages back for want of an agent's name, in
 * milliseconds (DOR-3074). Past it the chat shows anyway, so an answer that never
 * comes can't keep someone from their own history.
 */
export const AGENT_IDENTITY_LIMIT_MS = 8_000;

/**
 * Whether a wait has gone on longer than a limit.
 *
 * @param waiting - Whether the wait is on now. Ending it answers `false` at once.
 * @param key - What is being waited for; each one gets its own wait.
 * @param limitMs - The limit, in milliseconds.
 */
export function useWaitedPast(waiting: boolean, key: string, limitMs: number): boolean {
  const [waitedPast, setWaitedPast] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setWaitedPast(key), limitMs);
    return () => {
      clearTimeout(timer);
      setWaitedPast(null);
    };
  }, [waiting, key, limitMs]);
  return waiting && waitedPast === key;
}

/**
 * Whether to stop waiting for good: {@link useWaitedPast}, except the clock runs
 * from the first time this key waited, whatever restarts it, and the answer stays
 * `true`. A wait that a refetch could reset is a wait that may never end.
 *
 * @param waiting - Whether the wait is on now.
 * @param key - What is being waited for; each one gets its own clock.
 * @param limitMs - The limit, in milliseconds.
 */
export function useGaveUpWaiting(waiting: boolean, key: string, limitMs: number): boolean {
  const firstWait = useRef<{ key: string; at: number } | null>(null);
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting || gaveUpOn === key) return;
    if (firstWait.current?.key !== key) firstWait.current = { key, at: Date.now() };
    const waited = Date.now() - firstWait.current.at;
    const timer = setTimeout(() => setGaveUpOn(key), Math.max(0, limitMs - waited));
    return () => clearTimeout(timer);
  }, [waiting, key, limitMs, gaveUpOn]);
  return gaveUpOn === key;
}
