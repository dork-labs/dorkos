import { requireOriginalWorkerOperations } from '../server-worker.js';
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage7(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'native-widget-action'
  ) {
    const row = message as { id?: unknown; action?: unknown };
    if (
      !Number.isInteger(row.id) ||
      Number(row.id) < 1 ||
      Number(row.id) > 6 ||
      !['open', 'patch', 'disconnect', 'next', 'reset', 'revoke'].includes(String(row.action))
    )
      return true;
    if (
      context.retired ||
      context.widgetActionPending ||
      context.widgetActionCount >= 6 ||
      row.id !== context.widgetActionCount + 1 ||
      row.action !==
        ['open', 'patch', 'disconnect', 'next', 'reset', 'revoke'][context.widgetActionCount]
    )
      return true;
    context.widgetActionCount++;
    context.widgetActionPending = true;
    context.widgetActionWork = (async () => {
      let ok = false,
        data: unknown;
      let undefinedCause = false;
      try {
        if (!context.fixture || context.retired) throw new Error('Original widget fixture retired');
        data =
          row.action === 'open'
            ? await context.fixture.native.openBoundWidget()
            : row.action === 'patch'
              ? await context.fixture.native.patchBoundWidget()
              : row.action === 'disconnect'
                ? await context.fixture.disconnectBoundWidgetStream()
                : row.action === 'next'
                  ? await context.fixture.native.patchBoundWidget(true)
                  : row.action === 'reset'
                    ? await context.fixture.native.resetBoundWidgetHistory()
                    : await context.fixture.native.revokeBoundWidgetGrant();
        ok = true;
      } catch (cause) {
        if (!context.widgetActionFailure) context.widgetActionFailure = { cause };
        undefinedCause = cause === undefined;
      }
      if (process.connected)
        process.send?.({ kind: 'native-widget-result', id: row.id, ok, data, undefinedCause });
    })()
      .catch((cause) => {
        if (!context.widgetActionFailure) context.widgetActionFailure = { cause };
      })
      .finally(() => {
        context.widgetActionPending = false;
        context.widgetActionWork = undefined;
      });
    return true;
  }
  return false;
}
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage8(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'lose-writer-response'
  ) {
    const id = (message as { id?: unknown }).id;
    if (!Number.isInteger(id) || (id as number) < 1 || (id as number) > 16) return true;
    let ok = false;
    if (context.fixture && !context.retired) {
      context.fixture.loseNextWriterResponse();
      ok = true;
    }
    if (process.connected) process.send?.({ kind: 'writer-fault-armed', id, ok });
    return true;
  }
  return false;
}
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage9(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (message && typeof message === 'object' && (message as { kind?: unknown }).kind === 'close') {
    const disconnectAfterClose = () => {
      const firstCloseWitness = !context.postCloseWitnessInstalled;
      context.postCloseWitnessInstalled = true;
      if (firstCloseWitness) {
        context.postCloseResources('closed-before-disconnect');
        process.once('beforeExit', () => context.postCloseResources('before-exit'));
      }
      if (process.connected) process.disconnect();
      if (firstCloseWitness) context.postCloseResources('closed-after-disconnect');
    };
    void context.close().then(disconnectAfterClose, () => {
      process.exitCode = 1;
      disconnectAfterClose();
    });
    return true;
  }
  return false;
}
