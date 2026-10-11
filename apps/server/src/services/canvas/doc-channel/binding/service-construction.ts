import { updateAuthorizedOriginalDocPresence } from '../authorization.js';
import {
  prepareAuthorizedOriginalDocumentSave,
  completeAuthorizedOriginalDocumentSave,
} from '../authorization.js';
import { readOriginalDocumentFileSaveIdentity } from '../writes/installation-file-writes.js';
import { copyCurrentDocData } from '../current/current-operation-data.js';
import { CanvasChannelSelectionRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { askAuthorizedOriginalDocSelection } from '../authorization.js';
import { replayAuthorizedOriginalExpiredDocBatch } from '../authorization.js';
import { readAuthorizedDocManagement } from '../authorization.js';
import { inspectAuthorizedOriginalTokenInputReceipt } from '../authorization.js';
import { bindAuthorizedOriginalTokenService } from '../authorization.js';
import {
  drainDataAuthorizedOriginalTokenOwner,
  stateAuthorizedOriginalTokenStream,
  closedAuthorizedOriginalTokenStream,
  openAuthorizedOriginalTokenStream,
  nextAuthorizedOriginalTokenStream,
  closeAuthorizedOriginalTokenStream,
  restoreAuthorizedOriginalTokenScope,
  replayAuthorizedOriginalTokenScope,
  readAuthorizedOriginalTokenEvent,
} from '../authorization.js';
import {
  admitAuthorizedOriginalTokenIngress,
  submitAuthorizedOriginalTokenIngress,
  issueAuthorizedOriginalDocToken,
  revokeAuthorizedOriginalDocToken,
} from '../authorization.js';
import { requireAuthorizedDocumentInTransaction } from '../authorization.js';
import {
  prepareAuthorizedCheckboxSource,
  completeAuthorizedCheckboxSource,
  publishAuthorizedCheckboxSource,
  abandonAuthorizedCheckboxSource,
} from '../authorization.js';
import {
  pumpAuthorizedRoomDue,
  stopAuthorizedRoomPump,
  readAuthorizedRoomScenarioEvidence,
} from '../authorization.js';
/** Current-authorized document channel reads and durable event acceptance. */
import { CanvasChannelBatchReplayRequestSchema } from '@dorkos/shared/canvas-channel-schemas';

import {
  prepareAuthorizedRoomResponder,
  captureAuthorizedCurrentDocument,
  replayAuthorizedDocumentAuthority,
  inspectAuthorizedDocumentAuthority,
  submitAuthorizedDocumentAuthority,
  requireAuthorizedCurrentDocument,
  commitAuthorizedRoomResponder,
  readAuthorizedRoomDueAt,
  wakeAuthorizedRoomDue,
  hintAuthorizedRoomRelay,
  subscribeAuthorizedRoomRelay,
  maintainAuthorizedDocHistory,
  replayAuthorizedCurrentDoc,
  submitAuthorizedCurrentDocEvent,
  inspectCurrentDocReceipt,
  requireCurrentDocConstructorEngines,
} from '../authorization.js';
import { captureCurrentDocConfiguration } from '../current/current-operation-data.js';

import { DocIngestRefusal } from '../ingest-data/ingest-types.js';

import { DocChannelNotFoundError } from '../authorization.js';

import { readOriginalServiceConstructionView } from '../service.js';
/** Install original captured service callbacks only for the constructor-private key. */
export function constructOriginalCurrentService(owner: object): void {
  const facet = readOriginalServiceConstructionView(owner);
  const { events, authorization, channels } = facet;
  const captured = events ? captureCurrentDocConfiguration(events) : undefined;
  const currentEvents = captured
    ? Object.freeze({ ingest: captured.ingest, grants: captured.grants })
    : undefined;
  requireCurrentDocConstructorEngines(
    authorization,
    channels,
    currentEvents?.ingest,
    currentEvents?.grants
  );
  facet.bind({
    presence: (id, actor, raw) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return updateAuthorizedOriginalDocPresence(
        authorization,
        channels,
        currentEvents.ingest,
        currentEvents.grants,
        id,
        actor,
        raw
      );
    },
    documentReplay: (authority, since, limit) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return replayAuthorizedDocumentAuthority(
        authorization,
        channels,
        currentEvents.grants,
        authority,
        since,
        limit
      );
    },
    documentInspect: (authority, eventId) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return inspectAuthorizedDocumentAuthority(
        authorization,
        channels,
        currentEvents.grants,
        authority,
        eventId
      );
    },
    documentSubmit: async (authority, raw) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      const result = await submitAuthorizedDocumentAuthority(
        authorization,
        channels,
        currentEvents.ingest,
        currentEvents.grants,
        authority,
        raw
      );
      if (result.receipt.status === 'recorded') {
        for (const listener of facet.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
      }
      const inspected = await inspectAuthorizedDocumentAuthority(
        authorization,
        channels,
        currentEvents.grants,
        authority,
        result.receipt.id
      );
      if (
        inspected.kind !== 'receipt' ||
        inspected.event.receipt.id !== result.receipt.id ||
        inspected.event.receipt.docSeq !== result.receipt.docSeq
      )
        throw new DocChannelNotFoundError();
      return Object.freeze({
        receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
        deliveries: inspected.event.deliveries,
      });
    },
    restoreToken: (hash) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return restoreAuthorizedOriginalTokenScope(
        authorization,
        channels,
        currentEvents.grants,
        hash
      );
    },
    tokenOpenStream: (scope, since) =>
      openAuthorizedOriginalTokenStream(authorization, scope, since),
    tokenStreamNext: (stream) => nextAuthorizedOriginalTokenStream(authorization, stream),
    tokenDrainData: () => drainDataAuthorizedOriginalTokenOwner(authorization),
    tokenStreamState: (stream) => stateAuthorizedOriginalTokenStream(authorization, stream),
    tokenStreamClosed: (stream) => closedAuthorizedOriginalTokenStream(authorization, stream),
    tokenCloseStream: (stream) => closeAuthorizedOriginalTokenStream(authorization, stream),
    tokenReplay: (scope, since, limit, permission) =>
      replayAuthorizedOriginalTokenScope(authorization, scope, since, limit, permission),
    tokenEvent: (scope, eventId, permission) =>
      readAuthorizedOriginalTokenEvent(authorization, scope, eventId, permission),
    tokenIngressCurrent: (scope) => admitAuthorizedOriginalTokenIngress(authorization, scope),
    tokenSubmit: async (scope, raw) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      const result = await submitAuthorizedOriginalTokenIngress(
        authorization,
        channels,
        currentEvents.ingest,
        currentEvents.grants,
        scope,
        raw
      );
      if (result.receipt.status === 'recorded')
        for (const listener of facet.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
      const inspected = await inspectAuthorizedOriginalTokenInputReceipt(
        authorization,
        scope,
        result.receipt.id
      );
      if (
        inspected.receipt.id !== result.receipt.id ||
        inspected.receipt.docSeq !== result.receipt.docSeq
      )
        throw new DocChannelNotFoundError();
      return Object.freeze({
        receipt: Object.freeze({ ...inspected.receipt, status: result.receipt.status }),
        deliveries: inspected.deliveries,
      });
    },
    revokeToken: (actor, documentId, tokenId) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return revokeAuthorizedOriginalDocToken(
        authorization,
        channels,
        currentEvents.grants,
        actor,
        documentId,
        tokenId
      );
    },
    issueToken: (actor, request, grantIds) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return issueAuthorizedOriginalDocToken(
        authorization,
        channels,
        currentEvents.grants,
        actor,
        request,
        grantIds
      );
    },
    captureDocument: (documentId, actor, grantIds) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return captureAuthorizedCurrentDocument(
        authorization,
        channels,
        currentEvents.grants,
        documentId,
        actor,
        grantIds
      );
    },
    requireTokenDependencies: (candidateAuthorization, store, grants) => {
      if (
        candidateAuthorization !== authorization ||
        !currentEvents ||
        store !== channels ||
        grants !== currentEvents.grants
      )
        throw new DocChannelNotFoundError();
      requireCurrentDocConstructorEngines(authorization, channels, undefined, grants);
    },
    requireGrantDependencies: (store, grants) => {
      if (!currentEvents || channels !== store || currentEvents.grants !== grants)
        throw new DocChannelNotFoundError();
      requireCurrentDocConstructorEngines(authorization, channels, undefined, grants);
    },
    requireDocumentInTransaction: (authority, tx) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      requireAuthorizedDocumentInTransaction(
        authorization,
        channels,
        currentEvents.grants,
        authority,
        tx
      );
    },
    requireDocument: (authority) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return requireAuthorizedCurrentDocument(
        authorization,
        channels,
        currentEvents.grants,
        authority
      );
    },
    commitRoomResponder: (runtime, prepared) =>
      commitAuthorizedRoomResponder(authorization, runtime, prepared),
    prepareRoomResponder: (runtime, holder, key) =>
      prepareAuthorizedRoomResponder(authorization, runtime, holder, key),
    nextRoomDueAt: () => readAuthorizedRoomDueAt(authorization),
    wakeRoomDue: () => wakeAuthorizedRoomDue(authorization),
    hintRoomRelay: (documentId, batchId, generation) => {
      if (!hintAuthorizedRoomRelay(authorization, documentId, batchId, generation)) return false;
      for (const listener of facet.committedInputListeners) {
        try {
          listener();
        } catch {}
      }
      return true;
    },
    subscribeRoomRelay: (listener) => subscribeAuthorizedRoomRelay(authorization, listener),
    pumpRoomDue: (registry) => pumpAuthorizedRoomDue(authorization, registry),
    stopRoomPump: () => stopAuthorizedRoomPump(authorization),
    readRoomScenarioEvidence: (documentId, batchId, generation) =>
      readAuthorizedRoomScenarioEvidence(authorization, documentId, batchId, generation),
    prepareCheckbox: (owner) => prepareAuthorizedCheckboxSource(authorization, channels, owner),
    completeCheckbox: (owner, tx) => {
      if (!currentEvents) throw new DocChannelNotFoundError();
      return completeAuthorizedCheckboxSource(
        authorization,
        channels,
        currentEvents.grants,
        owner,
        tx
      );
    },
    publishCheckbox: (owner, tx) =>
      publishAuthorizedCheckboxSource(authorization, channels, owner, tx),
    abandonCheckbox: (owner, tx) => abandonAuthorizedCheckboxSource(authorization, owner, tx),
    notifyCheckboxCommitted: () => {
      for (const listener of facet.committedInputListeners) {
        try {
          listener();
        } catch {}
      }
      return undefined;
    },
    maintainHistory: () => maintainAuthorizedDocHistory(authorization, channels),
    subscribeRoomDue: (listener) => {
      facet.committedInputListeners.add(listener);
      return () => {
        facet.committedInputListeners.delete(listener);
      };
    },
    replayExpired: async (raw, actor) => {
      const request = CanvasChannelBatchReplayRequestSchema.parse(copyCurrentDocData(raw));
      if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
      const result = await replayAuthorizedOriginalExpiredDocBatch(
        authorization,
        channels,
        currentEvents.ingest,
        currentEvents.grants,
        request,
        actor
      );
      if (result.status === 'pending') {
        for (const listener of facet.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
      }
      // Postcommit callbacks precede the original current receipt/disclosure gate.
      const inspected = await inspectCurrentDocReceipt(
        authorization,
        channels,
        result.documentId,
        result.eventId,
        actor,
        { expectedGeneration: request.expectedGeneration }
      );
      if (inspected.kind !== 'receipt' || inspected.event.receipt.id !== result.eventId)
        throw new DocChannelNotFoundError();
      return result;
    },
    management: (documentId, actor) =>
      readAuthorizedDocManagement(authorization, channels, documentId, actor),
    replay: (documentId, actor, since, limit) =>
      replayAuthorizedCurrentDoc(authorization, channels, documentId, actor, since, limit),
    prepareDocumentSave: (scope, actor) => {
      if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
      return prepareAuthorizedOriginalDocumentSave(
        authorization,
        channels,
        currentEvents.grants,
        scope,
        actor
      );
    },
    completeDocumentSave: async (scope, actor) => {
      if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
      const request = copyCurrentDocData(readOriginalDocumentFileSaveIdentity(scope, channels));
      const result = await completeAuthorizedOriginalDocumentSave(
        authorization,
        channels,
        currentEvents.ingest,
        currentEvents.grants,
        scope,
        actor
      );
      if (result.receipt.status === 'recorded') {
        for (const listener of facet.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
      }
      const inspected = await inspectCurrentDocReceipt(
        authorization,
        channels,
        request.documentId,
        request.eventId,
        actor,
        { expectedGeneration: request.expectedGeneration }
      );
      if (inspected.kind !== 'receipt' || inspected.event.receipt.docSeq !== result.receipt.docSeq)
        throw new DocChannelNotFoundError();
      return Object.freeze({
        receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
        deliveries: inspected.event.deliveries,
      });
    },
    selection: async (raw, actor) => {
      const request = CanvasChannelSelectionRequestSchema.parse(copyCurrentDocData(raw));
      if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
      const result = await askAuthorizedOriginalDocSelection(
        authorization,
        channels,
        currentEvents.ingest,
        currentEvents.grants,
        request,
        actor
      );
      if (result.receipt.status === 'recorded') {
        for (const listener of facet.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
      }
      const inspected = await inspectCurrentDocReceipt(
        authorization,
        channels,
        request.documentId,
        request.eventId,
        actor,
        { expectedGeneration: request.expectedGeneration }
      );
      if (
        inspected.kind !== 'receipt' ||
        inspected.event.receipt.id !== request.eventId ||
        inspected.event.receipt.docSeq !== result.receipt.docSeq
      )
        throw new DocChannelNotFoundError();
      return Object.freeze({
        receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
        deliveries: inspected.event.deliveries,
      });
    },
    submit: async (documentId, raw, actor, condition) => {
      if (!currentEvents) throw new DocIngestRefusal('DOC_CHANNEL_UNAVAILABLE', 503);
      const result = await submitAuthorizedCurrentDocEvent(
        authorization,
        channels,
        currentEvents.ingest,
        currentEvents.grants,
        documentId,
        raw,
        actor,
        condition
      );
      if (result.receipt.status === 'recorded') {
        for (const listener of facet.committedInputListeners) {
          try {
            listener();
          } catch {}
        }
      }
      // Listener/configured postcommit side effects precede a fresh fixed inspection/currentness boundary.
      const inspected = await inspectCurrentDocReceipt(
        authorization,
        channels,
        documentId,
        result.receipt.id,
        actor,
        condition
      );
      if (
        inspected.kind !== 'receipt' ||
        inspected.event.receipt.id !== result.receipt.id ||
        inspected.event.receipt.docSeq !== result.receipt.docSeq
      )
        throw new Error('Committed original receipt is no longer inspectable.');
      // Return only the freshly captured conditional inspection; no observable listener/getter/await remains.
      return Object.freeze({
        receipt: Object.freeze({ ...inspected.event.receipt, status: result.receipt.status }),
        deliveries: inspected.event.deliveries,
      });
    },
    inspect: (documentId, eventId, actor, condition) =>
      inspectCurrentDocReceipt(authorization, channels, documentId, eventId, actor, condition),
  });
  if (currentEvents)
    bindAuthorizedOriginalTokenService(
      authorization,
      facet.service,
      channels,
      currentEvents.grants
    );
}
