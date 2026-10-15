import { readOriginalEngineCoreProjectionFacet } from '../current-operation-engine.js';
import type { CurrentDocOperationEngineCore } from '../current-operation-types.js';
import {
  readOriginalRoomPendingWriteCount,
  readOriginalRoomOperatorSource,
} from '../../operations/room-current-operation.js';
import {
  captureCurrentHttpDocActor,
  DocChannelNotFoundError,
  requireCurrentDocEngineOrigin,
  failCurrentDocOperation,
} from '../../authorization.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { CanvasChannelPresenceRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { withCheckboxReadOnlyGate } from '../../writes/authority/authority-snapshot.js';
import { requireOriginalRoomEmissionFrameTransaction } from '../../operations/room-responder-operation.js';
import { requireServiceOriginalTokenDependencies } from '../../service.js';
import {
  requireOriginalCheckboxCompletionOwner,
  requireOriginalCheckboxCompletionCommitted,
} from '../../writes/completion.js';
import { requireDocChannelStoreDatabase } from '../../store.js';

/** Build only the original frozen public projection after exact private engine recognition. */
export function createOriginalEngineCoreProjection(
  engineOwner: object
): CurrentDocOperationEngineCore {
  const facet = readOriginalEngineCoreProjectionFacet(engineOwner);
  return Object.freeze<CurrentDocOperationEngineCore>({
    roomPendingWrites: (tx) =>
      facet.state.room ? readOriginalRoomPendingWriteCount(facet.state.room, tx) : 0,
    presence: (store, ingest, grants, id, rawActor, raw) => {
      const actor = captureCurrentHttpDocActor(rawActor);
      if (actor.surface !== 'http') throw new DocChannelNotFoundError();
      const request = copyCurrentDocData(CanvasChannelPresenceRequestSchema.parse(raw));
      return facet.queuePresence(async () => {
        const response =
          request.action === 'focus'
            ? await facet.delegates.focusPresence(store, ingest, grants, id, actor, request)
            : await facet.delegates.updatePresence(store, id, actor, request);
        if (!response) throw new DocChannelNotFoundError();
        return response;
      });
    },

    requireCurrentAccess: (documentId, rawActor, write, tx) => {
      requireCurrentDocEngineOrigin(facet.state.authorization, facet.state.core, facet.state.db);
      const actor = captureCurrentHttpDocActor(rawActor);
      return withCheckboxReadOnlyGate(facet.state.db, () =>
        facet.delegates.fixedCurrent(documentId, actor, write, tx, true)
      );
    },

    captureRoomOperatorProducer: (store, tx) =>
      facet.delegates.captureRoomOperatorProducer(store, tx),
    requireRoomOperatorSource: (source) => facet.delegates.requireRoomOperatorSource(source),
    requireRoomOperatorNativeSource: (source, stage, tx, emitter) => {
      requireOriginalRoomEmissionFrameTransaction(stage, facet.state.db, tx, emitter);
      const own = readOriginalRoomOperatorSource(source, facet.state.core, facet.state.db);
      facet.delegates.requireOperatorRows(own.producer, tx);
      requireOriginalRoomEmissionFrameTransaction(stage, facet.state.db, tx, emitter);
      if (
        !sameCurrentDocData(
          readOriginalRoomOperatorSource(source, facet.state.core, facet.state.db),
          own
        )
      )
        throw new DocChannelNotFoundError();
    },
    tokenIngressCurrent: (scope) =>
      facet.trackTokenOperation(() => {
        const own = facet.state.restoredTokens.get(scope);
        if (!own) throw new DocChannelNotFoundError();
        const current = facet.delegates.prepareTokenNativeRead(own);
        if (
          !current.data.permissions.includes('ingest') ||
          !current.data.directions.includes('upstream')
        )
          throw new DocChannelNotFoundError();
        return Promise.resolve(
          Object.freeze({
            documentId: current.header.documentId,
            generation: current.header.generation,
          })
        );
      }),
    bindTokenService: (service, store, grants) => {
      if (facet.state.tokenSourceDependencies) throw new DocChannelNotFoundError();
      requireServiceOriginalTokenDependencies(service, facet.state.authorization, store, grants);
      // The genuine constructor tuple is retained before any manifest/native reader acquisition.
      facet.state.tokenSourceDependencies = { service, store, grants };
    },
    inspectTokenInputReceipt: (scope, eventId) =>
      facet.trackTokenOperation(() => facet.delegates.inspectTokenInputReceipt(scope, eventId)),
    submitToken: (store, ingest, grants, scope, raw) =>
      facet.trackTokenOperation(() =>
        facet.delegates.submitTokenCurrent(store, ingest, grants, scope, raw)
      ),
    captureRoomTokenProducer: (store, tx) => facet.delegates.captureRoomTokenProducer(store, tx),
    requireRoomTokenSource: (source) => facet.delegates.requireRoomTokenSource(source),
    revokeToken: (store, grants, actor, documentId, tokenId) =>
      facet.trackTokenOperation(() =>
        facet.delegates.revokeToken(store, grants, actor, documentId, tokenId)
      ),
    tokenOpenStream: (scope, since) =>
      facet.trackTokenOperation(() => facet.delegates.openTokenStream(scope, since)),
    tokenStreamNext: (stream) =>
      facet.trackTokenOperation(() => facet.delegates.nextTokenStream(stream)),
    tokenDrainData: () =>
      Object.freeze({
        roomPeerClosed: facet.state.tokenRoomPeerClosed,
        roomConstructed: facet.state.room !== undefined,
        activeTokenOperations: facet.state.activeTokenOperations.size,
        liveTokenStreams: facet.state.liveTokenStreams.size,
      }),
    tokenStreamState: (stream) => {
      const state = facet.state.tokenStreams.get(stream);
      if (!state) throw new DocChannelNotFoundError();
      return Object.freeze({ waiting: state.timer !== undefined, closed: state.closed });
    },
    tokenStreamClosed: (stream) => {
      const state = facet.state.tokenStreams.get(stream);
      if (!state) throw new DocChannelNotFoundError();
      return state.closedPromise;
    },
    tokenCloseStream: (stream) => facet.delegates.closeTokenStream(stream),
    restoreTokenScope: (store, grants, hash) =>
      facet.trackTokenOperation(() => facet.delegates.restoreTokenScope(store, grants, hash)),
    tokenReplay: (scope, since, limit, permission) =>
      facet.trackTokenOperation(() =>
        facet.delegates.readTokenReplay(scope, since, limit, permission)
      ),
    tokenEvent: (scope, eventId, permission) =>
      facet.trackTokenOperation(() => facet.delegates.readTokenEvent(scope, eventId, permission)),
    prepareTokenIssuance: (store, grants, actor, request, grantIds) =>
      facet.trackTokenOperation(() =>
        facet.delegates.prepareTokenIssuance(store, grants, actor, request, grantIds)
      ),
    commitTokenIssuance: (stage) =>
      facet.trackTokenOperation(() => facet.delegates.commitTokenIssuance(stage)),
    replayExpired: (store, ingest, grants, raw, actor) =>
      facet.trackTokenOperation(() =>
        facet.delegates.replayExpiredCurrent(store, ingest, grants, raw, actor)
      ),
    captureDocument: (store, grants, documentId, actor, grantIds) =>
      facet.delegates.captureDocument(store, grants, documentId, actor, grantIds),
    documentReplay: (store, grants, authority, since, limit) => {
      const own = facet.delegates.readDocumentAuthority(store, grants, authority);
      return facet.delegates.replayCurrent(
        store,
        own.documentId,
        own.actor,
        since,
        limit,
        authority
      );
    },
    documentInspect: (store, grants, authority, eventId) => {
      const own = facet.delegates.readDocumentAuthority(store, grants, authority);
      return facet.delegates.inspectCurrent(
        store,
        own.documentId,
        eventId,
        own.actor,
        { expectedGeneration: own.data.generation },
        authority
      );
    },
    documentSubmit: (store, ingest, grants, authority, raw) => {
      const own = facet.delegates.readDocumentAuthority(store, grants, authority);
      return facet.delegates.submitCurrent(
        store,
        ingest,
        grants,
        own.documentId,
        raw,
        own.actor,
        { expectedGeneration: own.data.generation },
        authority
      );
    },
    requireDocumentInTransaction: (store, grants, authority, tx) => {
      const own = facet.delegates.readDocumentAuthority(store, grants, authority);
      const scope = facet.delegates.beginCurrent(
        store,
        tx,
        own.documentId,
        own.actor,
        true,
        { expectedGeneration: own.data.generation },
        authority
      );
      try {
        facet.delegates.finalCurrent(store, tx);
      } catch (cause) {
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        facet.delegates.retireCurrent(tx);
      }
    },
    requireDocument: (store, grants, authority) => {
      const own = facet.state.documentAuthorities.get(authority);
      if (!own || own.store !== store || own.grants !== grants) throw new DocChannelNotFoundError();
      return facet.delegates.captureDocument(
        store,
        grants,
        own.documentId,
        own.actor,
        own.grantIds,
        authority
      );
    },
    commitRoomResponder: (runtime, prepared) => {
      if (facet.state.roomPumpStopped) throw new Error('Original Room pump admission is stopped.');
      if (!facet.state.room) throw new Error('Original Room source is unavailable.');
      return facet.state.room.commitResponder(runtime, prepared);
    },
    prepareRoomResponder: (runtime, holder, key) => {
      if (facet.state.roomPumpStopped) throw new Error('Original Room pump admission is stopped.');
      if (!facet.state.room) throw new Error('Original Room source is unavailable.');
      return facet.state.room.prepareResponder(runtime, holder, key);
    },
    prepareCheckbox: (store, owner) => {
      requireOriginalCheckboxCompletionOwner(owner, store);
      requireDocChannelStoreDatabase(store, facet.state.db);
      if (facet.state.db.$client.inTransaction || facet.state.currentEntry)
        throw new Error('Original checkbox source preparation cannot nest.');
      facet.delegates.ensureRoom();
    },
    completeCheckbox: (store, grants, owner, tx) =>
      facet.delegates.completeCheckbox(store, grants, owner, tx),
    publishCheckbox: (store, owner, tx) => {
      requireOriginalCheckboxCompletionCommitted(owner, store, tx);
      if (facet.state.db.$client.inTransaction)
        throw new Error('Checkbox source lacks outer commit.');
      const own = facet.state.checkboxCommits.get(tx);
      if (!own) return;
      if (own.owner !== owner || own.store !== store)
        throw new Error('Foreign checkbox source commit.');
      facet.state.checkboxCommits.delete(tx);
      // Only Room ingress has a sealed original producer draft to publish.
      if (own.roomPrepared) facet.state.room!.committed(tx, own.now);
      // A session FILE inverse still owns the same genuine writer COMMIT tuple.
      // The original native facade independently refuses any admitted/claimed/ACKed batch.
      facet.state.room!.cancelOriginalCheckboxUndoPair(store, owner, tx, own);
    },
    abandonCheckbox: (owner, tx) => {
      const own = facet.state.checkboxCommits.get(tx);
      if (own && own.owner !== owner) throw new Error('Foreign checkbox source abandonment.');
      facet.state.checkboxCommits.delete(tx);
      facet.state.room?.abandoned(tx);
    },
    maintainHistory: (store) => facet.delegates.maintainHistory(store),
    nextRoomDueAt: () =>
      facet.state.roomPumpStopped ? undefined : facet.delegates.ensureRoom()?.nextDueAt(),
    wakeRoomDue: () => {
      if (!facet.state.roomPumpStopped) facet.delegates.ensureRoom()?.freezeDue();
    },
    hintRoomRelay: (documentId, batchId, generation) =>
      !facet.state.roomPumpStopped &&
      (facet.state.room?.hintRelay(documentId, batchId, generation) ?? false),
    subscribeRoomRelay: (listener) =>
      facet.state.roomPumpStopped
        ? () => {}
        : (facet.delegates.ensureRoom()?.subscribeRelay(listener) ?? (() => {})),
    pumpRoomDue: async (registry) => {
      if (!facet.state.roomPumpStopped) await facet.delegates.ensureRoom()?.pump(registry);
    },
    stopRoomPump: () => facet.stopRoomPump(),
    readRoomScenarioEvidence: (documentId, batchId, generation) =>
      facet.state.room?.readScenarioEvidence(documentId, batchId, generation),
    prepareDocumentSave: (store, grants, scope, actor) =>
      facet.trackTokenOperation(() =>
        facet.delegates.prepareDocumentSave(store, grants, scope, actor)
      ),
    completeDocumentSave: (store, ingest, grants, scope, actor) =>
      facet.trackTokenOperation(() =>
        facet.delegates.completeDocumentSave(store, ingest, grants, scope, actor)
      ),
    selection: (store, ingest, grants, raw, actor) =>
      facet.trackTokenOperation(() =>
        facet.delegates.selectionCurrent(store, ingest, grants, raw, actor)
      ),
    submit: (store, ingest, grants, documentId, raw, actor, condition) =>
      facet.delegates.submitCurrent(store, ingest, grants, documentId, raw, actor, condition),
    inspect: (store, documentId, eventId, actor, condition) =>
      facet.delegates.inspectCurrent(store, documentId, eventId, actor, condition),
    management: (store, documentId, actor) =>
      facet.delegates.managementCurrent(store, documentId, actor),
    replay: (store, documentId, actor, since, limit) =>
      facet.delegates.replayCurrent(store, documentId, actor, since, limit),
    final: (store, tx) => {
      try {
        facet.delegates.finalCurrent(store, tx);
      } catch (cause) {
        return failCurrentDocOperation(store, tx, cause);
      }
    },
  });
}
