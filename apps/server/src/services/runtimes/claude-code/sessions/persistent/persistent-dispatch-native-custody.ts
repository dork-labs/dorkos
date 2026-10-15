const persistentCustodyFreeze = Object.freeze;

/** Allocate unrelated persistent-pump custody; the dispatcher alone retains its actual instance. */
export function createIsolatedPersistentDispatchCustody() {
  const originalPersistentCapacity = new WeakMap<
    object,
    (key: string) => import('../warm-process/session-pump-contract.js').PumpState | undefined
  >();

  const originalRoomPumpDispatches = new WeakMap<
    object,
    { pump: object; effect(): void; consumed?: boolean }
  >();

  return persistentCustodyFreeze({
    originalPersistentCapacity,
    originalRoomPumpDispatches,
  });
}
