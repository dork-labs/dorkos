import { performance } from 'node:perf_hooks';
import type { JobRole } from './contracts.js';

type Phase = 'intake' | 'prepare' | 'birth' | 'return';
type State = 'start' | 'settled' | 'failed';

/** Private observation only: original producers and their custody remain authoritative. */
export function createOriginalInstallationPhaseObserver(
  clock: () => number,
  write: (row: string) => void | boolean
) {
  const begin = (role: JobRole, phase: Phase) => {
    let origin: number | undefined;
    let finished = false;
    const emit = (state: State): void => {
      try {
        const now = clock();
        if (!Number.isFinite(now) || now < 0) return;
        if (state === 'start') origin = now;
        if (origin === undefined || now < origin) return;
        const elapsedMilliseconds = Math.round(now - origin);
        if (!Number.isFinite(elapsedMilliseconds)) return;
        write(
          JSON.stringify({
            kind: 'browser-installation-phase',
            role,
            phase,
            state,
            elapsedMilliseconds,
          }) + '\n'
        );
      } catch {
        // Clock, formatting, and sink failures cannot alter original work or its cause.
      }
    };
    emit('start');
    return (state: 'settled' | 'failed'): void => {
      if (finished) return;
      finished = true;
      emit(state);
    };
  };
  const observe = async <T>(
    role: JobRole,
    phase: Phase,
    producer: () => Promise<T>
  ): Promise<T> => {
    const finish = begin(role, phase);
    try {
      const result = await producer();
      finish('settled');
      return result;
    } catch (value) {
      finish('failed');
      throw value;
    }
  };
  return Object.freeze({ begin, observe });
}

/** Fixed, bounded job phases; stdout remains the original fresh-verifier reply channel. */
export const originalInstallationPhases = createOriginalInstallationPhaseObserver(
  () => performance.now(),
  (row) => process.stderr.write(row)
);
