import {
  driveClaudeOriginalRelayDocument,
  stopClaudeOriginalRelayDocumentDrive,
} from '../../../runtimes/claude-code/claude-code-runtime.js';

import {
  consumeServerNativeRelayConstruction,
  type ServerNativeRelayConstruction,
} from '@dorkos/db/internal-server';
import {
  requireOriginalNativePrincipalPort,
  requireNativePrincipalDatabase,
} from '../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { OriginalFrozenRelayDocumentSource } from './relay-native-types.js';
import { type Db, eq, sessionMessageAcceptanceReceipts } from '@dorkos/db';
import {
  consumeServerDocumentRelayOrigin,
  type ServerDocumentRelayOrigin,
  consumeInstalledDocumentAdapterOrigin,
  type InstalledDocumentAdapterOrigin,
} from '@dorkos/relay/server-private-document';
import {
  requireOriginalDocumentRelayStore,
  requireOriginalDocGrantStore,
  requireDocChannelStoreDatabase,
  type DocChannelStore,
} from '../store.js';
import { requireOriginalDocumentRelayGrants } from '../grant-revalidation.js';
import type { DocChannelGrants } from '../grants.js';
import { currentRoomDueServicePort, type DocChannelService } from '../service.js';
import {
  readDocBatchAuthority,
  refuseDocBatch,
  type DocBatchAuthority,
} from './batch-authority.js';

import {
  createIsolatedRelaySourceCustody,
  type OriginalRelaySourceCustody,
} from './relay-source-custody.js';
import * as preparation from './relay-preparation-operations.js';
import type { OriginalRelayPreparationView } from './relay-preparation-context.js';

const originalCustody: OriginalRelaySourceCustody = createIsolatedRelaySourceCustody();
const {
  originalRelayAvailability,
  originalRelayGenericClaimGuards,
  originalRelayReceiptWakes,
  originalRelaySources,
  settleOriginalClosedRelaySource,
} = originalCustody;
/** Original installed Relay operation; actual custody is module-private. */
export const readOriginalDocumentRelayAvailability = (
  ...args: Parameters<typeof originalCustody.readOriginalDocumentRelayAvailability>
): ReturnType<typeof originalCustody.readOriginalDocumentRelayAvailability> =>
  originalCustody.readOriginalDocumentRelayAvailability(...args);
/** Original installed Relay operation; actual custody is module-private. */
export const originalRelayReceiptNeedsNativeDispatch = (
  ...args: Parameters<typeof originalCustody.originalRelayReceiptNeedsNativeDispatch>
): ReturnType<typeof originalCustody.originalRelayReceiptNeedsNativeDispatch> =>
  originalCustody.originalRelayReceiptNeedsNativeDispatch(...args);
/** Original installed Relay operation; actual custody is module-private. */
export const wakeOriginalRelayAcceptedReceipts = (
  ...args: Parameters<typeof originalCustody.wakeOriginalRelayAcceptedReceipts>
): ReturnType<typeof originalCustody.wakeOriginalRelayAcceptedReceipts> =>
  originalCustody.wakeOriginalRelayAcceptedReceipts(...args);
/** Original installed Relay operation; actual custody is module-private. */
export const readOriginalFrozenRelayDocumentTarget = (
  ...args: Parameters<typeof originalCustody.readOriginalFrozenRelayDocumentTarget>
): ReturnType<typeof originalCustody.readOriginalFrozenRelayDocumentTarget> =>
  originalCustody.readOriginalFrozenRelayDocumentTarget(...args);
/** Original installed Relay operation; actual custody is module-private. */
export const readOriginalFrozenRelayDocumentLaunchInput = (
  ...args: Parameters<typeof originalCustody.readOriginalFrozenRelayDocumentLaunchInput>
): ReturnType<typeof originalCustody.readOriginalFrozenRelayDocumentLaunchInput> =>
  originalCustody.readOriginalFrozenRelayDocumentLaunchInput(...args);
/** Original installed Relay operation; actual custody is module-private. */
export const reserveOriginalFrozenRelayDocumentProcess = (
  ...args: Parameters<typeof originalCustody.reserveOriginalFrozenRelayDocumentProcess>
): ReturnType<typeof originalCustody.reserveOriginalFrozenRelayDocumentProcess> =>
  originalCustody.reserveOriginalFrozenRelayDocumentProcess(...args);
/** Original installed Relay operation; actual custody is module-private. */
export const claimOriginalPreparedRelayDocumentFacts = (
  ...args: Parameters<typeof originalCustody.claimOriginalPreparedRelayDocumentFacts>
): ReturnType<typeof originalCustody.claimOriginalPreparedRelayDocumentFacts> =>
  originalCustody.claimOriginalPreparedRelayDocumentFacts(...args);
/** Original installed Relay operation; actual custody is module-private. */
export const requireOriginalPreparedRelayDocumentClaimCurrent = (
  ...args: Parameters<typeof originalCustody.requireOriginalPreparedRelayDocumentClaimCurrent>
): ReturnType<typeof originalCustody.requireOriginalPreparedRelayDocumentClaimCurrent> =>
  originalCustody.requireOriginalPreparedRelayDocumentClaimCurrent(...args);

const preparationViews = new WeakMap<object, OriginalRelayPreparationView>();
const preparationGet = WeakMap.prototype.get;
const preparationSet = WeakMap.prototype.set;
const preparationApply = Reflect.apply;
/** Require the exact private installation key before any original preparation effect. */
export function readOriginalRelayPreparationView(owner: object): OriginalRelayPreparationView {
  const view = preparationApply(preparationGet, preparationViews, [owner]) as
    OriginalRelayPreparationView | undefined;
  if (!view) throw new Error('Original installed Relay preparation required');
  return view;
}

/** One installation consumes one genuine freshly constructed bus origin. */
export function createDocumentRelaySourceAuthority(
  origin: ServerDocumentRelayOrigin,
  store: DocChannelStore,
  grants: DocChannelGrants,
  nativePrincipals?: ConnectorRuntimePrincipalPort,
  ownDb?: Db,
  serverNativeRelayConstruction?: ServerNativeRelayConstruction,
  installedAdapterOrigin?: InstalledDocumentAdapterOrigin,
  roomService?: DocChannelService
) {
  if (nativePrincipals || ownDb) {
    if (!nativePrincipals || !ownDb || !serverNativeRelayConstruction || !installedAdapterOrigin)
      throw new Error('Original Relay principal/database/installed adapter assembly required.');
    requireOriginalNativePrincipalPort(nativePrincipals);
    requireNativePrincipalDatabase(nativePrincipals, ownDb);
    requireDocChannelStoreDatabase(store, ownDb);
  }
  if (serverNativeRelayConstruction && (!nativePrincipals || !ownDb))
    throw new Error('Original Relay native assembly required');
  const native =
    serverNativeRelayConstruction && ownDb
      ? consumeServerNativeRelayConstruction(serverNativeRelayConstruction, ownDb)
      : undefined;
  const adapter = installedAdapterOrigin
    ? consumeInstalledDocumentAdapterOrigin(installedAdapterOrigin)
    : undefined;
  const access = consumeServerDocumentRelayOrigin(origin);
  const originalStore = requireOriginalDocumentRelayStore(store);
  const originalGrants = requireOriginalDocumentRelayGrants(grants, store);
  const roomDue = roomService ? currentRoomDueServicePort(roomService) : undefined;
  const originalGrantStore = ownDb ? requireOriginalDocGrantStore(store, ownDb) : undefined;
  const preparationKey = Object.freeze({});
  const readRoomWake = (
    ...args: Parameters<typeof preparation.readRoomWake> extends [object, ...infer A] ? A : never
  ) => preparation.readRoomWake(preparationKey, ...args);
  const readAccepted = (
    ...args: Parameters<typeof preparation.readAccepted> extends [object, ...infer A] ? A : never
  ) => preparation.readAccepted(preparationKey, ...args);
  const currentAccepted = (
    ...args: Parameters<typeof preparation.currentAccepted> extends [object, ...infer A] ? A : never
  ) => preparation.currentAccepted(preparationKey, ...args);
  const prepareOriginalNativeSource = (
    ...args: Parameters<typeof preparation.prepareOriginalNativeSource> extends [object, ...infer A]
      ? A
      : never
  ) => preparation.prepareOriginalNativeSource(preparationKey, ...args);
  const active = new Map<
    string,
    {
      source?: OriginalFrozenRelayDocumentSource;
      runtime?: object;
      driveStarted: boolean;
      work?: Promise<void>;
    }
  >();
  let stopped = false,
    stopMemo: Promise<void> | undefined,
    unsubscribe: (() => void) | undefined,
    unsubscribeRoomRelay: (() => void) | undefined;
  const pendingWakes = new Set<Promise<readonly string[]>>();
  let wakeFailed = false,
    firstWakeCause: unknown;
  let operationalFailed = false,
    firstOperationalCause: unknown;
  let sinkFailed = false,
    firstSinkCause: unknown;
  const rememberSinkFailure = (cause: unknown) => {
    if (!sinkFailed) {
      sinkFailed = true;
      firstSinkCause = cause;
    }
  };
  const remember = (cause: unknown) => {
    rememberSinkFailure(cause);
    if (!operationalFailed) {
      operationalFailed = true;
      firstOperationalCause = cause;
    }
  };
  preparationApply(preparationSet, preparationViews, [
    preparationKey,
    Object.freeze({
      access,
      originalStore,
      originalGrants,
      originalGrantStore,
      roomDue,
      nativePrincipals,
      ownDb,
      serverNativeRelayConstruction,
      adapter,
      native,
      originalRelaySources,
      pendingWakes,
      rememberSinkFailure,
      get stopped() {
        return stopped;
      },
      get wakeFailed() {
        return wakeFailed;
      },
      set wakeFailed(value: boolean) {
        wakeFailed = value;
      },
      get firstWakeCause() {
        return firstWakeCause;
      },
      set firstWakeCause(value: unknown) {
        firstWakeCause = value;
      },
    } satisfies OriginalRelayPreparationView),
  ]);
  if (native && nativePrincipals && ownDb && adapter) {
    adapter.requireReady();
    originalRelayAvailability.set(grants, (target, opener) => {
      if (stopped) return 'relay_disabled';
      if (
        !opener ||
        !target.agentId ||
        !target.sessionId ||
        !target.agentPath ||
        target.runtime !== 'claude-code' ||
        !target.scope.startsWith('session:')
      )
        return 'runtime_unavailable';
      try {
        access.requireOpen();
        adapter.requireReady();
        adapter.readRuntime('claude-code');
      } catch {
        return 'relay_disabled';
      }
      try {
        access.requireExplicitOpenerAccess(opener, target.agentId);
      } catch {
        return 'relay_access_denied';
      }
      return undefined;
    });
    if (originalRelayGenericClaimGuards.has(ownDb))
      throw new Error('Original Relay native source already installed');
    originalRelayGenericClaimGuards.set(ownDb, (tx, id) => {
      const receipt = tx
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, id))
        .get();
      if (!receipt || receipt.sourceKind !== 'document_event_batch') return false;
      const batch = originalStore.getBatch(receipt.sourceId, tx);
      if (
        !batch ||
        batch.generation !== receipt.sourceGeneration ||
        batch.admissionReceiptId !== id
      )
        throw new Error('Original Relay generic claim source link differs');
      const authority = readDocBatchAuthority(originalStore, originalGrants, tx, batch);
      return (
        !!authority.grant.openerAgentId &&
        authority.target.runtime === 'claude-code' &&
        !!authority.target.agentId &&
        !authority.batch.scope.startsWith('room:')
      );
    }); // Retained after stop: stopped native owners never fall back to generic dispatch.
    const publishingRoom = new Set<string>();
    unsubscribeRoomRelay = roomDue?.subscribeRelay((documentId, batchId, generation) => {
      if (stopped) return;
      const key = JSON.stringify([batchId, generation]);
      if (publishingRoom.has(key)) return;
      if (publishingRoom.size >= 100) {
        if (!wakeFailed) {
          wakeFailed = true;
          firstWakeCause = new Error('Original Relay Room publication finite active frontier');
          rememberSinkFailure(firstWakeCause);
        }
        return;
      }
      publishingRoom.add(key);
      const work = Promise.resolve()
        .then(async () => {
          if (stopped) return Object.freeze([] as string[]);
          const current = readRoomWake(batchId, generation, { documentId });
          if (!current) return Object.freeze([] as string[]);
          if (current.batch.documentId !== documentId)
            throw new Error('Original Room publication source changed');
          await access.publishAcceptedDocumentWake({
            documentId,
            batchId,
            generation,
            openerAgentId: current.grant.openerAgentId!,
            targetAgentId: current.target.agentId!,
          });
          return Object.freeze([] as string[]);
        })
        .catch((cause) => {
          if (!wakeFailed) {
            wakeFailed = true;
            firstWakeCause = cause;
            rememberSinkFailure(cause);
          }
          throw cause;
        });
      pendingWakes.add(work);
      const release = () => {
        publishingRoom.delete(key);
        pendingWakes.delete(work);
      };
      void work.then(release, release);
    });
    unsubscribe = access.subscribeDocumentWakes((wake) => {
      if (stopped) return;
      const key = JSON.stringify([wake.batchId, wake.generation]);
      if (active.has(key)) return;
      if (active.size >= 100) throw new Error('Original Relay native sink finite active frontier');
      // Reserve the exact immutable DATA identity before source/native callbacks can reenter.
      const slot = {
        source: undefined as OriginalFrozenRelayDocumentSource | undefined,
        runtime: undefined as object | undefined,
        driveStarted: false,
        work: undefined as Promise<void> | undefined,
      };
      const work = Promise.resolve()
        .then(async () => {
          if (stopped) return;
          const selected = originalStore.getBatch(wake.batchId);
          if (selected?.scope.startsWith('room:')) {
            const room = readRoomWake(wake.batchId, wake.generation, wake);
            if (!room) return;
            if (
              room.batch.documentId !== wake.documentId ||
              room.grant.openerAgentId !== wake.openerAgentId ||
              room.target.agentId !== wake.targetAgentId
            )
              throw new Error('Original Relay Room wake/source correlation differs');
            roomDue!.hintRelay(wake.documentId, wake.batchId, wake.generation);
            return;
          }
          const source = prepareOriginalNativeSource(wake.batchId, wake.generation),
            own = originalRelaySources.get(source)!;
          if (
            own.authority.batch.documentId !== wake.documentId ||
            own.authority.grant.openerAgentId !== wake.openerAgentId ||
            own.authority.target.agentId !== wake.targetAgentId
          )
            throw new Error('Original Relay wake/source correlation differs');
          own.adapter.requireReady();
          const runtime = own.adapter.readRuntime('claude-code');
          slot.source = source;
          slot.runtime = runtime;
          if (stopped) return; // Captured source has no launched drive/process yet.
          const driving = driveClaudeOriginalRelayDocument(runtime, source);
          slot.driveStarted = true;
          let failed = false,
            first: unknown,
            closed = true,
            driveResult: 'busy' | 'drained' | undefined;
          const retain = (cause: unknown) => {
            rememberSinkFailure(cause);
            if (!failed) {
              failed = true;
              first = cause;
            }
          };
          try {
            driveResult = await driving;
          } catch (cause) {
            retain(cause);
          }
          // Attempt both actual closure recognizers without replacing an original operation failure.
          try {
            await stopClaudeOriginalRelayDocumentDrive(runtime, source);
          } catch (cause) {
            closed = false;
            retain(cause);
          }
          try {
            native.requireClosed();
          } catch (cause) {
            closed = false;
            retain(cause);
          }
          if (closed && !failed && driveResult === 'drained') {
            try {
              settleOriginalClosedRelaySource(source, runtime);
            } catch (cause) {
              retain(cause);
            }
          }
          // Terminal SQL owns a new original frame; earlier drive closure cannot certify it.
          try {
            native.requireClosed();
          } catch (cause) {
            closed = false;
            retain(cause);
          }
          if (closed && active.get(key) === slot) active.delete(key);
          if (failed) throw first;
        })
        .catch(remember)
        .finally(() => {
          // Identifier-only handoff acquired no native turn/custody to drain.
          if (!slot.source && active.get(key) === slot) active.delete(key);
        });
      slot.work = work;
      active.set(key, slot);
    });
  }
  const stopOriginalNativeSink = () => {
    if (stopMemo) return stopMemo;
    stopped = true;
    stopMemo = Promise.resolve().then(async () => {
      let failed = false,
        first: unknown;
      const retain = (cause: unknown) => {
        rememberSinkFailure(cause);
        if (!failed) {
          failed = true;
          first = firstSinkCause;
        }
      };
      if (operationalFailed) retain(firstOperationalCause);
      if (wakeFailed) retain(firstWakeCause); // Earlier original publication failure remains first.
      try {
        unsubscribeRoomRelay?.();
        unsubscribe?.();
      } catch (cause) {
        retain(cause);
      }
      const peers: Promise<unknown>[] = [
        ...pendingWakes,
        ...[...active.values()].flatMap((slot) => {
          const tasks: Promise<unknown>[] = [];
          // Launch cancellation independently before waiting for the real held stream/drive.
          if (slot.driveStarted && slot.source && slot.runtime)
            tasks.push(
              Promise.resolve().then(() =>
                stopClaudeOriginalRelayDocumentDrive(slot.runtime!, slot.source!)
              )
            );
          if (slot.work) tasks.push(slot.work);
          return tasks;
        }),
      ];
      await Promise.allSettled(peers.map((peer) => peer.catch(retain)));
      if (operationalFailed) retain(firstOperationalCause);
      if (wakeFailed) retain(firstWakeCause);
      try {
        native?.requireClosed();
      } catch (cause) {
        retain(cause);
      }
      if (failed) throw first;
      active.clear();
    });
    return stopMemo;
  };
  const owner = Object.freeze({
    stopOriginalNativeSink,
    readOriginalSinkDiagnostic() {
      return Object.freeze({ stopped, active: active.size, operationalFailed });
    },
    /** Original accepted-source reread precedes actual protected bus publication.
     * DeliveredTo/trace rows remain transport DATA, never native acceptance. */
    publishAcceptedWake(batchId: string, generation: string) {
      const selected = originalStore.getBatch(batchId);
      const authority = selected?.scope.startsWith('room:')
        ? readRoomWake(batchId, generation)
        : currentAccepted(batchId, generation);
      if (!authority) return Promise.resolve(undefined);
      const { batch, grant, target } = authority;
      if (!grant.openerAgentId || !target.agentId) refuseDocBatch('document_relay_opener_required');
      return access.publishAcceptedDocumentWake({
        documentId: batch.documentId,
        batchId: batch.batchId,
        generation: batch.generation,
        openerAgentId: grant.openerAgentId,
        targetAgentId: target.agentId,
      });
    },
    prepareOriginalNativeSource,
    readAccepted(batchId: string, generation: string): DocBatchAuthority {
      access.requireOpen();
      const initial = originalStore.getBatch(batchId);
      if (!initial || initial.generation !== generation) refuseDocBatch('document_batch_changed');
      // Manifest suspension must commit outside the source transaction, as in the original source.
      originalGrants.refreshGrantedAuthority(initial.grantId);
      return originalStore.transaction((tx) => readAccepted(tx, batchId, generation));
    },
  });
  if (native && nativePrincipals && ownDb && adapter) {
    originalRelayReceiptWakes.set(owner, {
      db: ownDb,
      wake(sessionId, receiptIds) {
        return preparation.wakeOriginalPreparedRelayReceipts(preparationKey, sessionId, receiptIds);
      },
    });
  }
  return owner;
}
