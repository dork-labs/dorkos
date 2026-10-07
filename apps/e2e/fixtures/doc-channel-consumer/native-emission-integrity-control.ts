/** Fixed isolated-host fault controls. No production route, issuer or callback registrar. */
import {
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocEvents,
  and,
  eq,
  type Db,
} from '@dorkos/db';

import {
  readServiceOriginalRoomScenarioEvidence,
  type DocChannelService,
} from '../../../server/src/services/canvas/doc-channel/service.js';

export type NativeEmissionIntegrityCase = 'none' | 'select-builder' | 'event-codec';
export type NativeEmissionIntegrityData = Readonly<{
  caseName: NativeEmissionIntegrityCase;
  phase: 'waiting' | 'armed' | 'restored';
  ackId: string | null;
  replacementCalls: number;
  retired: boolean | null;
  observerFailed: boolean;
}>;

function sameDescriptor(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
) {
  if (!left || !right) return left === right;
  return (
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

/** Construct only in the owned worker, from the same original native fixture Db.
 * The literal startup case cannot supply a descriptor, SQL, source or callback.
 * An owned finite observer arms after the real first app.ack; read is DATA-only. Restore after the
 * genuine held operation settles, before native replay and resource teardown.
 */
export function createNativeEmissionIntegrityControl(
  db: Db,
  documentId: string,
  service: DocChannelService,
  caseName: NativeEmissionIntegrityCase
): Readonly<{ read(): NativeEmissionIntegrityData; stop(): Promise<void> }> {
  if (caseName !== 'none' && caseName !== 'select-builder' && caseName !== 'event-codec')
    throw new Error('Finite native integrity case required');
  let phase: NativeEmissionIntegrityData['phase'] = 'waiting';
  let ackId: string | null = null;
  let replacementCalls = 0;
  let batchId: string | undefined;
  let generation: string | undefined;
  let retired: boolean | null = null;
  let observerFailed = false;
  let observerCause: unknown;
  let stopped = false;
  let retirement: Promise<void> | undefined;
  let target: object | undefined;
  let key: '_prepare' | 'mapFromDriverValue' | undefined;
  let original: PropertyDescriptor | undefined;
  let installed: PropertyDescriptor | undefined;
  const data = (): NativeEmissionIntegrityData =>
    Object.freeze({
      caseName,
      phase,
      ackId,
      replacementCalls,
      retired,
      observerFailed,
    });
  const observe = () => {
    if (phase === 'armed') {
      if (!batchId || !generation) throw new Error('Original fault subject lost');
      const evidence = readServiceOriginalRoomScenarioEvidence(
        service,
        documentId,
        batchId,
        generation
      );
      retired = evidence?.retired ?? null;
      if (evidence?.scenarioStarts === 1 && evidence.retired === true) restore();
      return data();
    }
    if (phase !== 'waiting' || caseName === 'none') return data();
    // Native rows precede the fault. A page, prompt or IPC DTO cannot provide them.
    const query = db
      .select()
      .from(canvasDocEvents)
      .where(eq(canvasDocEvents.documentId, documentId));
    const rows = query.limit(65).all();
    if (rows.length > 64) throw new Error('Native integrity fixture row frontier');
    const acknowledgements = rows.filter((row) => row.type === 'app.ack');
    if (acknowledgements.length === 0) return data();
    if (acknowledgements.length !== 1 || rows.some((row) => row.type === 'agent.reply'))
      throw new Error('Original first acknowledgement boundary unavailable');
    const acknowledgement = acknowledgements[0]!;
    const payload = acknowledgement.payload as {
      eventIds?: unknown;
      outcome?: unknown;
      batchId?: unknown;
    };
    if (
      !payload ||
      !Array.isArray(payload.eventIds) ||
      payload.eventIds.length !== 1 ||
      typeof payload.eventIds[0] !== 'string' ||
      payload.outcome !== 'handled' ||
      typeof payload.batchId !== 'string'
    )
      throw new Error('Original partial acknowledgement unavailable');
    const batch = db
      .select()
      .from(canvasDocBatches)
      .where(eq(canvasDocBatches.batchId, payload.batchId))
      .get();
    if (
      !batch ||
      batch.documentId !== documentId ||
      batch.routeId !== 'consumer' ||
      batch.inputEventIds.length !== 2 ||
      !batch.inputEventIds.includes(payload.eventIds[0])
    )
      throw new Error('Original two-input fault subject unavailable');
    const evidence = readServiceOriginalRoomScenarioEvidence(
      service,
      documentId,
      batch.batchId,
      batch.generation
    );
    if (evidence?.scenarioStarts !== 1 || evidence.retired !== false)
      throw new Error('Original native acknowledgement hold unavailable');
    batchId = batch.batchId;
    generation = batch.generation;
    retired = false;
    const retainedDeliveries = db
      .select()
      .from(canvasDocDeliveries)
      .where(
        and(
          eq(canvasDocDeliveries.documentId, documentId),
          eq(canvasDocDeliveries.batchId, batch.batchId),
          eq(canvasDocDeliveries.routeId, batch.routeId)
        )
      )
      .limit(3)
      .all();
    if (
      retainedDeliveries.length !== 2 ||
      !batch.inputEventIds.every((id) => retainedDeliveries.some((row) => row.eventId === id))
    )
      throw new Error('Original pair delivery rows unavailable');
    const remainingInput = rows.find((row) => row.eventId === batch.inputEventIds[1]);
    if (!remainingInput) throw new Error('Original remaining input payload unavailable');
    ackId = acknowledgement.eventId;
    if (caseName === 'select-builder') {
      // Drizzle owns all on each instance; target the genuine shared preparation method.
      target = Object.getPrototypeOf(query);
      while (target && !Object.hasOwn(target, '_prepare')) target = Object.getPrototypeOf(target);
      key = '_prepare';
    } else {
      // Shadow the exact queried JSON field decoder, not a copied schema column.
      target = canvasDocEvents.payload;
      key = 'mapFromDriverValue';
    }
    if (!target || !key) throw new Error('Original native fault target unavailable');
    original = Object.getOwnPropertyDescriptor(target, key);
    if (original && !original.configurable) throw new Error('Native fault descriptor is fixed');
    if (!original && !Object.isExtensible(target)) throw new Error('Native fault field is fixed');
    const originalPrepare = caseName === 'select-builder' ? original?.value : undefined;
    const originalToSQL = query.toSQL;
    if (caseName === 'select-builder' && typeof originalPrepare !== 'function')
      throw new Error('Original select preparation unavailable');
    const replacement =
      caseName === 'select-builder'
        ? function (this: unknown, ...args: unknown[]) {
            // Preserve Better Auth and step HTTP reachability. Only genuine delivery
            // SELECTs for this retained document/input pair receive stale matching rows.
            let selected: { sql: string; params: unknown[] } | undefined;
            try {
              selected = Reflect.apply(originalToSQL, this, []) as typeof selected;
            } catch {
              /* Non-select delegates. */
            }
            if (
              selected &&
              /\bfrom\s+"canvas_doc_deliveries"/i.test(selected.sql) &&
              selected.params.includes(documentId)
            ) {
              const eventId = batch.inputEventIds.find((id) => selected!.params.includes(id));
              if (eventId) {
                const prepared = Reflect.apply(originalPrepare, this, args);
                Object.defineProperty(prepared, 'all', {
                  configurable: true,
                  value: () => {
                    replacementCalls++;
                    return retainedDeliveries.filter((row) => row.eventId === eventId);
                  },
                });
                return prepared;
              }
            }
            return Reflect.apply(originalPrepare, this, args);
          }
        : function () {
            replacementCalls++;
            return remainingInput.payload;
          };
    installed = {
      value: replacement,
      configurable: true,
      enumerable: original?.enumerable ?? false,
      writable: true,
    };
    Object.defineProperty(target, key, installed);
    phase = 'armed';
    return data();
  };
  const restore = () => {
    if (phase === 'restored') return;
    if (phase === 'armed') {
      if (
        !target ||
        !key ||
        !sameDescriptor(Object.getOwnPropertyDescriptor(target, key), installed)
      )
        throw new Error('Original native fault restoration custody lost');
      if (original) Object.defineProperty(target, key, original);
      else if (!Reflect.deleteProperty(target, key))
        throw new Error('Original field decoder restoration failed');
      if (!sameDescriptor(Object.getOwnPropertyDescriptor(target, key), original))
        throw new Error('Original native fault descriptor did not restore');
    }
    phase = 'restored';
  };
  // Startup-selected observer owns its finite work independently of IPC reads.
  const observer = (async () => {
    if (caseName === 'none') return;
    for (let attempts = 0; attempts < 1000 && !stopped; attempts++) {
      if (observe().phase === 'restored') return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (!stopped && data().phase !== 'restored')
      throw new Error('Native integrity observer frontier');
  })();
  // Install failure custody immediately; DATA never exposes or classifies the raw cause.
  const settledObserver = observer.catch((cause) => {
    observerFailed = true;
    observerCause = cause;
  });
  const stop = () => {
    if (retirement) return retirement;
    stopped = true;
    retirement = (async () => {
      await settledObserver;
      // The fixture must first drain the genuine scheduler operation. Missing/active
      // evidence refuses restoration and therefore retains the shared Db/resources.
      let failed = observerFailed;
      let first = observerCause;
      try {
        if (phase === 'armed') {
          if (!batchId || !generation) throw new Error('Original fault subject lost');
          const evidence = readServiceOriginalRoomScenarioEvidence(
            service,
            documentId,
            batchId,
            generation
          );
          if (evidence?.scenarioStarts !== 1 || evidence.retired !== true)
            throw new Error('Original native fault operation is not retired');
          retired = true;
          restore();
        }
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
      if (failed) throw first;
    })();
    return retirement;
  };
  return Object.freeze({ read: data, stop });
}
