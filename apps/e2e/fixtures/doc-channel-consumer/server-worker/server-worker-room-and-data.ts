import { requireOriginalWorkerOperations } from '../server-worker.js';
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage0(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'native-canonical-action'
  ) {
    const row = message as { id?: unknown; action?: unknown };
    if (
      (row.id !== 1 && row.id !== 2 && row.id !== 3) ||
      !['pause', 'capture', 'restart'].includes(String(row.action))
    )
      return true;
    if (context.canonicalActionWork) return true;
    context.canonicalActionWork = (async () => {
      let ok = false,
        data: unknown;
      try {
        if (!context.fixture || context.retired)
          throw new Error('Original canonical fixture retired');
        data =
          row.action === 'pause'
            ? (await context.fixture.native.pauseCanonicalRoomPump(), {})
            : row.action === 'capture'
              ? context.fixture.native.captureCanonicalRecovery()
              : await context.fixture.restartOriginalNativeRoom();
        ok = true;
      } catch (cause) {
        if (!context.canonicalActionFailure) context.canonicalActionFailure = { cause };
      }
      try {
        if (process.connected)
          process.send?.({ kind: 'native-canonical-result', id: row.id, ok, data });
      } catch (cause) {
        if (!context.canonicalActionFailure) context.canonicalActionFailure = { cause };
      }
    })().finally(() => {
      context.canonicalActionWork = undefined;
    });
    return true;
  }
  return false;
}
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage1(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    [
      'read-room-scenario-data',
      'read-native-integrity-data',
      'start-native-integrity-observation',
      'read-checkbox-pair-data',
      'read-canonical-recovery-data',
      'read-selection-data',
      'read-reviewed-replay-data',
      'read-saved-data',
      'read-presence-data',
      'read-mcp-app-data',
    ].includes(String((message as { kind?: unknown }).kind))
  ) {
    const reviewed = (message as { kind?: unknown }).kind === 'read-reviewed-replay-data';
    const mcpApp = (message as { kind?: unknown }).kind === 'read-mcp-app-data';
    const presence = (message as { kind?: unknown }).kind === 'read-presence-data';
    const saved = (message as { kind?: unknown }).kind === 'read-saved-data';
    const selection = (message as { kind?: unknown }).kind === 'read-selection-data';
    const canonical = (message as { kind?: unknown }).kind === 'read-canonical-recovery-data';
    const integrity = (message as { kind?: unknown }).kind === 'read-native-integrity-data';
    const integrityStart =
      (message as { kind?: unknown }).kind === 'start-native-integrity-observation';
    const checkbox = (message as { kind?: unknown }).kind === 'read-checkbox-pair-data';
    const responseKind = integrityStart
      ? 'native-integrity-started'
      : mcpApp
        ? 'mcp-app-data'
        : reviewed
          ? 'reviewed-replay-data'
          : presence
            ? 'presence-data'
            : saved
              ? 'saved-data'
              : selection
                ? 'selection-data'
                : canonical
                  ? 'canonical-recovery-data'
                  : checkbox
                    ? 'checkbox-pair-data'
                    : integrity
                      ? 'native-integrity-data'
                      : 'room-scenario-data';
    const id = (message as { id?: unknown }).id;
    if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > 96) return true;
    if (
      context.scenarioReadPending ||
      context.scenarioReadCount >= 96 ||
      id !== context.scenarioReadCount + 1
    ) {
      if (process.connected) process.send?.({ kind: responseKind, id, ok: false });
      return true;
    }
    context.scenarioReadCount++;
    context.scenarioReadPending = true;
    // Original local owner reads or starts observation of its own retained delivery IDs;
    // the IPC request carries no batch/source/principal or supplied count.
    void (async () => {
      try {
        if (!context.fixture || context.retired) throw new Error('Owned Room fixture retired');
        const data = integrityStart
          ? context.fixture.native.startNativeEmissionIntegrityObservation()
          : mcpApp
            ? context.fixture.native.readOriginalMcpAppData()
            : reviewed
              ? await context.fixture.native.readOriginalReviewedReplayData()
              : presence
                ? context.fixture.native.readOriginalPresenceData()
                : saved
                  ? await context.fixture.native.readOriginalSavedData()
                  : selection
                    ? await context.fixture.native.readOriginalSelectionData()
                    : canonical
                      ? context.fixture.native.readCanonicalRecoveryData()
                      : checkbox
                        ? await context.fixture.native.readOriginalCheckboxPairData()
                        : integrity
                          ? context.fixture.native.readNativeEmissionIntegrityData()
                          : await context.fixture.native.readOriginalRoomScenarioData();
        if (context.retired) throw new Error('Owned Room fixture retired during read');
        if (process.connected) process.send?.({ kind: responseKind, id, ok: true, data });
      } catch (cause) {
        // Diagnostic DATA only; opaque causes stay in this owned stderr capture.
        console.error('Original native evidence read failed; raw undefined:', cause === undefined);
        console.error(cause);
        if (process.connected)
          process.send?.({
            kind: responseKind,
            id,
            ok: false,
            failureMessage: cause instanceof Error ? cause.message.slice(0, 512) : undefined,
            undefinedCause: cause === undefined,
          });
      } finally {
        context.scenarioReadPending = false;
      }
    })();
    return true;
  }
  return false;
}
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage2(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'native-checkbox-action'
  ) {
    const row = message as { id?: unknown; action?: unknown };
    if ((row.id !== 1 && row.id !== 2) || (row.action !== 'open' && row.action !== 'pump'))
      return true;
    void (async () => {
      let ok = false,
        data: unknown;
      try {
        if (!context.fixture || context.retired)
          throw new Error('Original checkbox fixture retired');
        data =
          row.action === 'open'
            ? await context.fixture.native.openCheckboxFile()
            : await context.fixture.native.pumpCheckboxAfterRelease();
        ok = true;
      } catch {
        /* Actual original drains retain custody on failure. */
      }
      if (process.connected)
        process.send?.({ kind: 'native-checkbox-result', id: row.id, ok, data });
    })();
    return true;
  }
  return false;
}
