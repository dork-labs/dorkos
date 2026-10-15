import { requireOriginalWorkerOperations } from '../server-worker.js';
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage3(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'native-saved-action'
  ) {
    const row = message as { id?: unknown; action?: unknown };
    if (
      context.retired ||
      context.savedActionPending ||
      row.id !== context.savedActionSequence + 1 ||
      row.action !== ['open', 'pump', 'arm-failure'][context.savedActionSequence]
    )
      return true;
    context.savedActionSequence++;
    context.savedActionPending = true;
    context.savedActionWork = (async () => {
      let ok = false,
        data: unknown;
      try {
        if (!context.fixture || context.retired)
          throw new Error('Original saved FILE fixture retired');
        data =
          row.action === 'open'
            ? await context.fixture.native.openDocumentSaveFile()
            : row.action === 'arm-failure'
              ? context.fixture.native.armOriginalSavedInsertFailure()
              : await context.fixture.native.pumpOriginalSavedDocument();
        ok = true;
      } catch (cause) {
        if (!context.savedActionFailure) context.savedActionFailure = { cause };
        console.error('Original saved FILE action failed; raw undefined:', cause === undefined);
        console.error(cause);
      }
      if (process.connected) process.send?.({ kind: 'native-saved-result', id: row.id, ok, data });
    })()
      .catch((cause) => {
        if (!context.savedActionFailure) context.savedActionFailure = { cause };
      })
      .finally(() => {
        context.savedActionPending = false;
        context.savedActionWork = undefined;
      });
    return true;
  }
  return false;
}
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage4(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'native-reviewed-replay-action'
  ) {
    const row = message as { id?: unknown; action?: unknown };
    if (
      context.retired ||
      context.reviewedActionPending ||
      row.id !== context.reviewedActionSequence + 1 ||
      row.action !== ['open', 'expire', 'pump'][context.reviewedActionSequence]
    )
      return true;
    context.reviewedActionSequence++;
    context.reviewedActionPending = true;
    context.reviewedActionWork = (async () => {
      let ok = false,
        data: unknown;
      try {
        if (!context.fixture || context.retired)
          throw new Error('Original reviewed replay fixture retired');
        data =
          row.action === 'open'
            ? await context.fixture.native.openReviewedReplayFile()
            : row.action === 'expire'
              ? await context.fixture.native.expireOriginalReviewedReplay()
              : await context.fixture.native.pumpOriginalReviewedReplay();
        ok = true;
      } catch (cause) {
        if (!context.reviewedActionFailure) context.reviewedActionFailure = { cause };
      }
      if (process.connected)
        process.send?.({ kind: 'native-reviewed-replay-result', id: row.id, ok, data });
    })()
      .catch((cause) => {
        if (!context.reviewedActionFailure) context.reviewedActionFailure = { cause };
      })
      .finally(() => {
        context.reviewedActionPending = false;
        context.reviewedActionWork = undefined;
      });
    return true;
  }
  return false;
}
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage5(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'native-mcp-app-action'
  ) {
    const row = message as { id?: unknown; action?: unknown };
    if (
      context.retired ||
      context.mcpActionPending ||
      row.id !== context.mcpActionSequence + 1 ||
      row.action !== ['open', 'pump', 'emit'][context.mcpActionSequence]
    )
      return true;
    context.mcpActionSequence++;
    context.mcpActionPending = true;
    context.mcpActionWork = (async () => {
      let ok = false,
        data: unknown;
      try {
        if (!context.fixture || context.retired)
          throw new Error('Original MCP App fixture retired');
        data =
          row.action === 'open'
            ? await context.fixture.native.openOriginalMcpApp()
            : row.action === 'pump'
              ? await context.fixture.native.pumpOriginalMcpApp()
              : await context.fixture.native.emitOriginalMcpAppDownstream();
        ok = true;
      } catch (cause) {
        context.mcpActionFailure ??= { cause };
        console.error('Original MCP App action failed; raw undefined:', cause === undefined);
        console.error(cause);
      }
      if (process.connected)
        process.send?.({ kind: 'native-mcp-app-result', id: row.id, ok, data });
    })()
      .catch((cause) => {
        context.mcpActionFailure ??= { cause };
      })
      .finally(() => {
        context.mcpActionPending = false;
        context.mcpActionWork = undefined;
      });
    return true;
  }
  return false;
}
/** Exact finite original IPC branch; no supplied resource or ownership context. */
export function handleOriginalWorkerMessage6(operationKey: object, message: unknown): boolean {
  const context = requireOriginalWorkerOperations(operationKey);
  if (
    message &&
    typeof message === 'object' &&
    (message as { kind?: unknown }).kind === 'native-selection-action'
  ) {
    const row = message as { id?: unknown; action?: unknown };
    if (
      context.retired ||
      context.selectionActionPending ||
      row.id !== context.selectionActionSequence + 1 ||
      row.action !== ['open', 'pump'][context.selectionActionSequence]
    )
      return true;
    context.selectionActionSequence++;
    context.selectionActionPending = true;
    context.selectionActionWork = (async () => {
      let ok = false,
        data: unknown;
      try {
        if (!context.fixture || context.retired)
          throw new Error('Original selection fixture retired');
        data =
          row.action === 'open'
            ? await context.fixture.native.openSelectionFile()
            : await context.fixture.native.pumpOriginalSelection();
        ok = true;
      } catch (cause) {
        if (!context.selectionActionFailure) context.selectionActionFailure = { cause };
        console.error('Original selection action failed; raw undefined:', cause === undefined);
        console.error(cause);
      }
      if (process.connected)
        process.send?.({ kind: 'native-selection-result', id: row.id, ok, data });
    })()
      .catch((cause) => {
        if (!context.selectionActionFailure) context.selectionActionFailure = { cause };
      })
      .finally(() => {
        context.selectionActionPending = false;
        context.selectionActionWork = undefined;
      });
    return true;
  }
  return false;
}
