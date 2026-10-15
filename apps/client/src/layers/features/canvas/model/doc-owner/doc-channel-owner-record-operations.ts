import type { SetStateAction } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { sameCanvasDocIncarnation } from '@dorkos/shared/canvas-doc-frame-wire';
import { createDocChannelNativePorts } from '../doc-frame/doc-channel-native-ports';
import { readOwnedFrameForCore, readOwnedCursor } from './doc-channel-owner-replay';
import {
  captureOwnedFrameRetirement,
  consumeOwnedFrameRetirement,
  readOwnedFrameFacade,
  readOwnedNativeBinding,
} from './doc-channel-owner-frame';
import {
  emptyDocChannelView as empty,
  mergeDocChannelSnapshot,
  appendDocChannelFrame,
  type DocChannelView as View,
  type DocChannelSnapshot as Snapshot,
} from '../doc-channel-view';
import {
  requireOriginalRecordOperationOwner,
  readOwnedProjection,
  ownedProjectionCurrent,
  recordSubjectCurrent,
  ownedRunCurrent,
  readOwnedFacts,
  projectOwnedView,
} from './doc-channel-owner-record';
/** Guard deferred React projection against captured owner, epoch, run and subject changes. */
export function projectOwnedViewFromOwner(
  operationKey: object,
  update: SetStateAction<View>,
  run?: object
): void {
  const { custodyKey } = requireOriginalRecordOperationOwner(operationKey);
  const capture = readOwnedProjection(custodyKey);
  const subject = capture.subject;
  const matches = () => ownedProjectionCurrent(custodyKey, capture, run);
  if (!subject || !recordSubjectCurrent(custodyKey, subject)) {
    const ticket = captureOwnedFrameRetirement(custodyKey);
    consumeOwnedFrameRetirement(custodyKey, ticket);
  }
  if (!matches()) return;
  const binding = subject && readOwnedNativeBinding(custodyKey, subject);
  const frameAdmission = readOwnedFrameFacade(custodyKey);
  const mcpBinding = subject && readRecordMcpBinding(operationKey, subject);
  capture.dispatch((previous) => {
    if (!matches()) return previous;
    const base =
      previous.binding?.owner === subject ? previous : empty(capture.documentId, capture.transport);
    const next = typeof update === 'function' ? update(base) : update;
    if (!matches()) return previous;
    return {
      ...next,
      ...(next.snapshot ? { snapshot: Object.freeze({ ...next.snapshot }) } : {}),
      binding,
      frameAdmission,
      mcpBinding,
    };
  });
}
/** Install an owned snapshot and project its immutable routing facts through the current owner. */
export function projectOwnedSnapshotFromOwner(
  operationKey: object,
  snapshot: Snapshot,
  routingCurrent: boolean,
  qualified: boolean,
  run?: object
): void {
  const { custodyKey, recordFor } = requireOriginalRecordOperationOwner(operationKey);
  const capture = readOwnedProjection(custodyKey);
  const record = recordFor();
  if (!ownedProjectionCurrent(custodyKey, capture, run)) return;
  if (record) record.snapshot = snapshot;
  projectOwnedView(
    custodyKey,
    (previous) =>
      mergeDocChannelSnapshot(
        previous,
        snapshot,
        capture.documentId,
        capture.transport,
        routingCurrent,
        qualified
      ),
    run
  );
}
/** Advance and project only the frame retained by the exact owned run witness. */
export function projectOwnedFrameFromOwner(
  operationKey: object,
  run: object,
  ticket: object,
  pending: boolean
): boolean {
  const { custodyKey, advanceFrame } = requireOriginalRecordOperationOwner(operationKey);
  const value = readOwnedFrameForCore(custodyKey, run, ticket, pending);
  if (!ownedRunCurrent(custodyKey, run) || !value) return false;
  if (value.docSeq <= readOwnedCursor(custodyKey).highest) return ownedRunCurrent(custodyKey, run);
  advanceFrame(run, ticket, pending, value);
  if (!ownedRunCurrent(custodyKey, run)) return false;
  const capture = readOwnedProjection(custodyKey);
  projectOwnedView(
    custodyKey,
    (previous) => appendDocChannelFrame(previous, value, capture.documentId, capture.transport),
    run
  );
  return ownedRunCurrent(custodyKey, run);
}
/** No mutable record or bound Transport is returned; only closed native operations. */
export function readRecordNativeOperationsFromOwner(operationKey: object, subject: object) {
  const { custodyKey, recordFor } = requireOriginalRecordOperationOwner(operationKey);
  const record = recordFor(subject);
  if (!record) return undefined;
  const documentId = readOwnedFacts(custodyKey).documentId;
  return {
    current: (purpose: 'read' | 'submit') =>
      recordSubjectCurrent(custodyKey, subject, purpose === 'submit'),
    submit: (event: Parameters<Transport['ingestCanvasEvent']>[1], signal: AbortSignal) =>
      record.submit(documentId, event, { expectedGeneration: record.birth.generation }, signal),
    inspect: (id: string, signal: AbortSignal) =>
      record.inspect(documentId, id, { expectedGeneration: record.birth.generation }, signal),
    capture: () => {
      const baseline = record.httpBaseline;
      if (
        !baseline ||
        !recordSubjectCurrent(custodyKey, subject, true) ||
        !sameCanvasDocIncarnation(baseline.birth, record.birth)
      )
        return null;
      return Object.freeze({
        current: (purpose: 'read' | 'submit') =>
          recordSubjectCurrent(custodyKey, subject, purpose === 'submit') &&
          (purpose === 'read' || record.httpBaseline === baseline),
        submit: (event: Parameters<Transport['ingestCanvasEvent']>[1], signal: AbortSignal) =>
          record.submit(
            documentId,
            event,
            { expectedGeneration: baseline.birth.generation },
            signal
          ),
        inspect: (id: string, signal: AbortSignal) =>
          record.inspect(documentId, id, { expectedGeneration: baseline.birth.generation }, signal),
      });
    },
  };
}
/** Closed recording operations for the captured native frame; routing still belongs to the server. */
export function readRecordFrameOperationsFromOwner(operationKey: object, subject: object) {
  const { custodyKey, recordFor } = requireOriginalRecordOperationOwner(operationKey);
  const record = recordFor(subject);
  if (!record) return undefined;
  const documentId = readOwnedFacts(custodyKey).documentId;
  return {
    current: () => recordSubjectCurrent(custodyKey, subject),
    submit: (event: Parameters<Transport['ingestCanvasEvent']>[1], signal: AbortSignal) =>
      record.submit(documentId, event, { expectedGeneration: record.birth.generation }, signal),
    inspect: (id: string, signal: AbortSignal) =>
      record.inspect(documentId, id, { expectedGeneration: record.birth.generation }, signal),
    capture: () => {
      const baseline = record.httpBaseline;
      if (
        !baseline ||
        !recordSubjectCurrent(custodyKey, subject) ||
        !sameCanvasDocIncarnation(baseline.birth, record.birth)
      )
        return null;
      return Object.freeze({
        current: (purpose: 'read' | 'submit') =>
          recordSubjectCurrent(custodyKey, subject) &&
          (purpose === 'read' || record.httpBaseline === baseline),
        submit: (event: Parameters<Transport['ingestCanvasEvent']>[1], signal: AbortSignal) =>
          record.submit(
            documentId,
            event,
            { expectedGeneration: baseline.birth.generation },
            signal
          ),
        inspect: (id: string, signal: AbortSignal) =>
          record.inspect(documentId, id, { expectedGeneration: baseline.birth.generation }, signal),
      });
    },
  };
}
/** Capture only this owned HTTP record's actual MCP source; ordinary routing guards are unchanged. */
function readRecordMcpBinding(operationKey: object, subject: object) {
  const { custodyKey, recordFor } = requireOriginalRecordOperationOwner(operationKey);
  const record = recordFor(subject);
  const origin = record?.mcpOrigin;
  if (!record || !origin || !record.httpBaseline || !recordSubjectCurrent(custodyKey, subject))
    return undefined;
  if (record.mcpBinding?.current('read')) return record.mcpBinding;
  const sameOrigin = () => {
    const current = recordFor(subject)?.mcpOrigin;
    return (
      !!current &&
      current.canonicalSessionId === origin.canonicalSessionId &&
      current.serverName === origin.serverName &&
      current.uri === origin.uri &&
      current.physicalRevision === origin.physicalRevision &&
      current.declarationHash === origin.declarationHash
    );
  };
  const current = () => recordSubjectCurrent(custodyKey, subject) && sameOrigin();
  const operations = {
    current,
    submit: (event: PageEvent, signal: AbortSignal) =>
      record.submit(
        record.birth.documentId,
        event,
        { expectedGeneration: record.birth.generation },
        signal
      ),
    inspect: (id: string, signal: AbortSignal) =>
      record.inspect(
        record.birth.documentId,
        id,
        { expectedGeneration: record.birth.generation },
        signal
      ),
    capture: () => {
      const baseline = record.httpBaseline;
      if (!baseline || !current() || !sameCanvasDocIncarnation(baseline.birth, record.birth))
        return null;
      return Object.freeze({
        current: (purpose: 'read' | 'submit') =>
          current() && (purpose === 'read' || record.httpBaseline === baseline),
        submit: operations.submit,
        inspect: operations.inspect,
      });
    },
  };
  const native = createDocChannelNativePorts(operations);
  record.mcpBinding = Object.freeze({
    owner: subject,
    documentId: record.birth.documentId,
    generation: record.birth.generation,
    origin,
    current: native.current,
    captureOriginal: native.captureOriginal,
  });
  return record.mcpBinding;
}
