import { requireOriginalConsumerInitial } from '../channel-store.js';
/** Preserve original setup failure and conditional native-owner cleanup. */
export async function failOriginalConsumerConstruction(
  ownerKey: object,
  cause: unknown
): Promise<never> {
  const context = requireOriginalConsumerInitial(ownerKey);
  const { clearRoomService, clearCanvasService, setAgentHomeRegistry, db } = context;
  try {
    await context.stopDocNotifications?.();
  } catch {
    /* Preserve setup's first raw cause; unresolved subscription retains shared Db. */
  }
  try {
    await context.stopMcpAppFixture?.();
  } catch {
    /* Original MCP setup cause first; unknown producer retains shared Db. */
  }
  try {
    await context.stopWidgetProducer?.();
  } catch {
    /* Unknown native producer retains shared resources. */
  }
  try {
    if (context.roomScheduler) {
      await context.roomScheduler.stop();
      context.roomSchedulerClosed = true;
    }
  } catch {
    /* Preserve original setup cause, including undefined; retain native ownership. */
  }
  try {
    if (context.integrityControl) {
      await context.integrityControl.stop();
      context.integrityClosed = true;
    }
  } catch {
    /* Raw setup cause first; unresolved descriptor owner retains Db. */
  }
  try {
    if (context.stopHttpFileWrites) {
      await context.stopHttpFileWrites();
      context.httpFileWritesClosed = true;
    }
  } catch {
    /* Preserve setup raw first cause; unresolved child keeps shared native resources owned. */
  }
  try {
    if (context.stopDocOperations) {
      await context.stopDocOperations();
      context.docOperationsClosed = true;
    }
  } catch {
    /* Preserve original setup cause; current-operation UNKNOWN retains native resources. */
  }
  const nativeOwnersClosed =
    context.mcpFixtureClosed &&
    context.docNotificationsClosed &&
    context.docOperationsClosed &&
    context.widgetProducerClosed &&
    (!context.integrityConstructionStarted || context.integrityClosed) &&
    (!context.httpConstructionStarted || context.httpFileWritesClosed) &&
    (!context.roomScheduler || context.roomSchedulerClosed);
  if (nativeOwnersClosed) {
    try {
      context.stopFollowingSessionRekeys?.();
      context.disposeRoomCanvas?.();
    } catch {
      /* Original owning removal registration. */
    }
  }
  if (context.ownedRooms && nativeOwnersClosed) {
    try {
      clearRoomService(context.ownedRooms.service);
    } catch {
      /* Independent exact-owner cleanup. */
    }
    try {
      clearCanvasService(context.ownedRooms.canvas);
    } catch {
      /* Never clear a later replacement. */
    }
  }
  if (nativeOwnersClosed && context.agentHomeRegistryInstalled) {
    try {
      setAgentHomeRegistry(undefined);
      context.agentHomeRegistryInstalled = false;
    } catch {
      /* Original setup cause stays first; unknown native ownership remains retained. */
    }
  }
  if (nativeOwnersClosed) {
    try {
      db.$client.close();
    } catch {
      /* Positively drained original owners only. */
    }
  }
  throw cause;
}
