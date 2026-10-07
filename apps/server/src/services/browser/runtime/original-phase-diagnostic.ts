import { performance } from 'node:perf_hooks';
import { logger } from '../../../lib/logger.js';
type OriginalPhase =
  | 'startup.authenticate'
  | 'startup.import-mode'
  | 'startup.import-routes'
  | 'mode.capture-owner'
  | 'mode.resolve-package'
  | 'mode.inspect-initial'
  | 'mode.native-journal'
  | 'mode.verify-existing'
  | 'mode.inspect-after-verify'
  | 'mode.resolve-journal-after'
  | 'mode.inspect-proof'
  | 'mode.native-proof'
  | 'mode.resolve-proof-journal'
  | 'session.authorize-workspace'
  | 'session.network-open'
  | 'owner.resolve-package'
  | 'owner.verify-existing'
  | 'owner.inspect-existing'
  | 'owner.engine-open';
/** Fixed original stage timings only. Diagnostics confer no native/actor readiness and cannot heal failure. */
export async function observeOriginalStartupPhase<T>(
  phase: OriginalPhase,
  producer: () => Promise<T> | T
): Promise<T> {
  // initLogger replaces the exported logger. Capture this phase's current original receiver,
  // never the pre-initialization console-only instance imported by passive startup.
  let originalInfo: typeof logger.info | undefined;
  try {
    const originalLogger = logger;
    originalInfo = originalLogger.info.bind(originalLogger);
  } catch {
    /* Diagnostics have no authority over producer admission. */
  }
  const started = performance.now();
  const emit = (event: 'start' | 'settled' | 'failed', failure?: Readonly<{ value: unknown }>) => {
    try {
      originalInfo?.('Browser runtime original stage', {
        phase,
        event,
        elapsedMilliseconds: Math.round(performance.now() - started),
        ...(failure
          ? {
              failure:
                failure.value === undefined
                  ? 'undefined'
                  : failure.value === false
                    ? 'false'
                    : 'opaque',
            }
          : {}),
      });
    } catch {
      /* Original diagnostic sink is non-authoritative. */
    }
  };
  emit('start');
  try {
    const result = await producer();
    emit('settled');
    return result;
  } catch (value) {
    emit('failed', { value });
    throw value;
  }
}
