export const startupPhases = Object.freeze([
  'admission-import',
  'native-fixture',
  'vault-create',
  'api-listen',
  'writer-listen',
  'boundary-import',
  'boundary-init',
  'native-store',
  'app-import',
  'front-door-import',
  'agents-import',
  'upgrade-import',
  'stream-routes-import',
  'preview-import',
  'vite-import',
  'vite-create',
  'vite-listen',
  'config-import',
  'standalone-token',
] as const);
let startupSequence = 0;
function startupFrontier(
  phase: (typeof startupPhases)[number],
  state: 'begin' | 'done' | 'failed',
  causeType: 'undefined' | 'error' | 'other' | null = null
) {
  if (process.argv[2] !== '--consumer-native-worker' || !process.connected || startupSequence >= 64)
    return;
  try {
    process.send?.(
      { kind: 'startup-frontier', sequence: ++startupSequence, phase, state, causeType },
      () => {
        /* Diagnostic delivery cannot replace an original setup cause. */
      }
    );
  } catch {
    /* Diagnostics are secondary to original readiness and cleanup. */
  }
}
/** Preserve original awaited startup work with bounded failure DATA only. */
export async function startupAwait<T>(
  phase: (typeof startupPhases)[number],
  run: () => Promise<T>
) {
  startupFrontier(phase, 'begin');
  try {
    const result = await run();
    startupFrontier(phase, 'done');
    return result;
  } catch (cause) {
    startupFrontier(
      phase,
      'failed',
      cause === undefined ? 'undefined' : cause instanceof Error ? 'error' : 'other'
    );
    throw cause;
  }
}
