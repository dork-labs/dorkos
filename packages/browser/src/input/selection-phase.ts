import { performance } from 'node:perf_hooks';

type Phase =
  | 'session-opening'
  | 'initial-tree'
  | 'world'
  | 'read'
  | 'final-tree'
  | 'result'
  | 'authority'
  | 'detach';
/** Observation-only fixed original selection phases; no page contents or failure values enter the sink. */
export function createOriginalSelectionPhaseObserver(
  clock: () => number,
  write: (row: string) => void | boolean
) {
  const begin = (phase: Phase) => {
    let origin: number | undefined;
    let finished = false;
    const emit = (state: 'start' | 'settled' | 'failed') => {
      try {
        const now = clock();
        if (!Number.isFinite(now) || now < 0) return;
        if (state === 'start') origin = now;
        if (origin === undefined || now < origin) return;
        write(
          JSON.stringify({
            kind: 'browser-selection-phase',
            phase,
            state,
            elapsedMilliseconds: Math.round(now - origin),
          }) + '\n'
        );
      } catch {
        /* The original producer and its first cause remain authoritative. */
      }
    };
    emit('start');
    return (state: 'settled' | 'failed') => {
      if (finished) return;
      finished = true;
      emit(state);
    };
  };
  const observe = async <T>(phase: Phase, producer: () => Promise<T>): Promise<T> => {
    const finish = begin(phase);
    try {
      const result = await producer();
      finish('settled');
      return result;
    } catch (value) {
      finish('failed');
      throw value;
    }
  };
  const observeSync = <T>(phase: Phase, producer: () => T): T => {
    const finish = begin(phase);
    try {
      const result = producer();
      finish('settled');
      return result;
    } catch (value) {
      finish('failed');
      throw value;
    }
  };
  return Object.freeze({ begin, observe, observeSync });
}
/** Private runtime sink only; diagnostics never establish selection or actor authority. */
export const originalSelectionPhases = createOriginalSelectionPhaseObserver(
  () => performance.now(),
  (row) => process.stderr.write(row)
);
