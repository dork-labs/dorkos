/** Sole private record issuer. All subjects originate in genuine owned HTTP admission. */
import type { Dispatch, SetStateAction } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type {
  CanvasChannelFrame,
  CanvasChannelMcpOrigin,
  PageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';
import { createDocChannelNativePorts } from './doc-channel-native-ports';
import { buildOwnedLifecycle } from './doc-channel-owner-custody';
import {
  readOwnedPageForAdmission,
  readOwnedFrameForCore,
  acceptOwnAdmission,
  advanceOwnedFrameCursor,
  readOwnedCursor,
} from './doc-channel-owner-replay';
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
  type DocChannelBinding,
} from './doc-channel-view';
interface NativeRecord {
  owner: object;
  token: object;
  birth: CanvasDocIncarnation;
  active: boolean;
  verified: boolean;
  snapshot?: Snapshot;
  mcpOrigin?: Readonly<CanvasChannelMcpOrigin>;
  mcpBinding?: import('./doc-channel-view').DocMcpBinding;
  httpBaseline?: Readonly<{ birth: CanvasDocIncarnation; floor: number }>;
  submit: Transport['ingestCanvasEvent'];
  inspect: Transport['getCanvasEventReceipt'];
  transport: Transport;
}
const pageWitnesses = new WeakMap<
  object,
  { owner: object; run: object; witness: NonNullable<ReturnType<typeof readOwnedPageForAdmission>> }
>();
/** Retain only the genuine owned replay page witness for fixed record admission. */
export function readRecordPageForCore(custodyKey: object, run: object, page: object) {
  const witness = readOwnedPageForAdmission(custodyKey, run, page);
  if (!witness) return undefined;
  pageWitnesses.set(page, { owner: custodyKey, run, witness });
  return witness;
}
const issued = new WeakMap<object, NativeRecord>();
const subjects = new WeakMap<object, object>();
const admissions = new WeakMap<
  object,
  Readonly<{ owner: object; run: object; epoch: number; previous?: object; subject: object }>
>();
const advances = new WeakMap<
  object,
  { owner: object; run: object; pending: boolean; frame: CanvasChannelFrame }
>();
function recordFor(custodyKey: object, subject?: object): NativeRecord | undefined {
  requireOwnedCustody(custodyKey);
  const token = subject ?? subjects.get(custodyKey);
  const record = token && issued.get(token);
  return record &&
    record.owner === custodyKey &&
    subjects.get(custodyKey) === token &&
    record.active
    ? record
    : undefined;
}
/** Capture this genuine custody owner’s current opaque record subject. */
export function captureRecordSubject(custodyKey: object): object | undefined {
  requireOwnedCustody(custodyKey);
  return subjects.get(custodyKey);
}
/** Read frozen facts only for the active subject issued to this exact custody owner. */
export function readRecordSubject(custodyKey: object, subject: object) {
  const record = recordFor(custodyKey, subject);
  return record
    ? Object.freeze({
        birth: record.birth,
        httpBaseline: record.httpBaseline,
        snapshot: record.snapshot,
        verified: record.verified,
      })
    : undefined;
}
/** Require the issued active subject and captured Transport, with routing for submit. */
export function recordSubjectCurrent(custodyKey: object, subject: object, submit = false): boolean {
  const record = recordFor(custodyKey, subject);
  const facts = readOwnedFacts(custodyKey);
  return (
    !!record &&
    facts.live &&
    record.verified &&
    record.transport === readOwnedTransport(custodyKey) &&
    (!submit || record.snapshot?.routing?.enabled === true)
  );
}
/** Remove the current subject before invalidating its private record. */
export function retireRecordSubject(custodyKey: object): void {
  const record = recordFor(custodyKey);
  subjects.delete(custodyKey);
  if (record) {
    record.active = false;
    record.verified = false;
  }
}
/** Disable the exact issued subject while owned replay repairs its projection. */
export function unverifyRecordSubject(custodyKey: object, subject: object): void {
  const record = recordFor(custodyKey, subject);
  if (record) record.verified = false;
}
/** Qualify only this captured current replay run’s own active subject. */
export function qualifyRecordSubject(custodyKey: object, run: object, subject: object): boolean {
  const record = recordFor(custodyKey, subject);
  if (!record || !ownedRunCurrent(custodyKey, run)) return false;
  record.verified = true;
  return ownedRunCurrent(custodyKey, run);
}
/** Issue a private subject only from the genuine owned HTTP page admission witness. */
export function issueOwnedHttpRecord(custodyKey: object, run: object, page: object): boolean {
  const selected = pageWitnesses.get(page);
  pageWitnesses.delete(page);
  const witness =
    selected?.owner === custodyKey && selected.run === run ? selected.witness : undefined;
  if (!witness || !ownedRunCurrent(custodyKey, run)) return false;
  const birth = witness.response.incarnation;
  let record = recordFor(custodyKey);
  if (!record && !birth) return ownedRunCurrent(custodyKey, run);
  if (!record && birth) {
    const capture = readOwnedFacts(custodyKey);
    const before = () => {
      const facts = readOwnedFacts(custodyKey);
      return (
        ownedRunCurrent(custodyKey, run) &&
        facts.epoch === capture.epoch &&
        facts.observation === capture.observation &&
        captureRecordSubject(custodyKey) === capture.subject
      );
    };
    const transportOwner = readOwnedTransport(custodyKey);
    const submitMethod = transportOwner.ingestCanvasEvent;
    if (!before()) return false;
    const submit = Function.prototype.bind.call(
      submitMethod,
      transportOwner
    ) as Transport['ingestCanvasEvent'];
    const inspectMethod = transportOwner.getCanvasEventReceipt;
    if (!before()) return false;
    const inspect = Function.prototype.bind.call(
      inspectMethod,
      transportOwner
    ) as Transport['getCanvasEventReceipt'];
    if (!before()) return false;
    record = {
      owner: custodyKey,
      token: Object.freeze({}),
      birth: Object.freeze({ ...birth }),
      active: true,
      verified: false,
      submit,
      inspect,
      transport: transportOwner,
      mcpOrigin: witness.response.mcpOrigin
        ? Object.freeze({ ...witness.response.mcpOrigin })
        : undefined,
    };
    issued.set(record.token, record);
    subjects.set(custodyKey, record.token);
    record.httpBaseline = Object.freeze({
      birth: record.birth,
      floor: witness.response.receiptRetentionFloor,
    });
    admissions.set(
      page,
      Object.freeze({
        owner: custodyKey,
        run,
        epoch: capture.epoch,
        previous: capture.subject,
        subject: record.token,
      })
    );
    try {
      acceptOwnAdmission(custodyKey, run, page);
    } catch (cause) {
      if (recordFor(custodyKey) === record) abortOwnedAdmission(custodyKey, run, page);
      throw cause;
    } finally {
      admissions.delete(page);
    }
    if (!ownedRunCurrent(custodyKey, run)) return false;
  } else if (record) {
    if (!birth || !sameCanvasDocIncarnation(record.birth, birth)) return false;
    record.httpBaseline = Object.freeze({
      birth: record.birth,
      floor: witness.response.receiptRetentionFloor,
    });
    record.mcpOrigin = witness.response.mcpOrigin
      ? Object.freeze({ ...witness.response.mcpOrigin })
      : undefined;
  }
  if (!ownedRunCurrent(custodyKey, run)) return false;
  if (record) record.verified = ownedBirthQualified(custodyKey) || record.verified;
  return true;
}
/** Guard deferred React projection against captured owner, epoch, run and subject changes. */
export function projectOwnedView(
  custodyKey: object,
  update: SetStateAction<View>,
  run?: object
): void {
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
  const mcpBinding = subject && readRecordMcpBinding(custodyKey, subject);
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
export function projectOwnedSnapshot(
  custodyKey: object,
  snapshot: Snapshot,
  routingCurrent: boolean,
  qualified: boolean,
  run?: object
): void {
  const capture = readOwnedProjection(custodyKey);
  const record = recordFor(custodyKey);
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
export function projectOwnedFrame(
  custodyKey: object,
  run: object,
  ticket: object,
  pending: boolean
): boolean {
  const value = readOwnedFrameForCore(custodyKey, run, ticket, pending);
  if (!ownedRunCurrent(custodyKey, run) || !value) return false;
  if (value.docSeq <= readOwnedCursor(custodyKey).highest) return ownedRunCurrent(custodyKey, run);
  advances.set(ticket, { owner: custodyKey, run, pending, frame: value });
  try {
    advanceOwnedFrameCursor(custodyKey, run, ticket, pending);
  } finally {
    advances.delete(ticket);
  }
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
export function readRecordNativeOperations(custodyKey: object, subject: object) {
  const record = recordFor(custodyKey, subject);
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
export function readRecordFrameOperations(custodyKey: object, subject: object) {
  const record = recordFor(custodyKey, subject);
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
/** Read this page’s callback-free handoff from unissued to its own issued subject. */
export function readOwnAdmissionForReplay(custodyKey: object, run: object, page: object) {
  const admission = admissions.get(page);
  const facts = readOwnedFacts(custodyKey);
  return admission &&
    admission.owner === custodyKey &&
    admission.run === run &&
    facts.epoch === admission.epoch &&
    facts.subject === admission.subject &&
    facts.live
    ? admission
    : undefined;
}
/** Select only the advancing frame retained for this exact owner, run and phase. */
export function readOwnedAdvanceForReplay(
  custodyKey: object,
  run: object,
  ticket: object,
  pending: boolean
) {
  const value = advances.get(ticket);
  return value &&
    value.owner === custodyKey &&
    value.run === run &&
    value.pending === pending &&
    ownedRunCurrent(custodyKey, run)
    ? value.frame
    : undefined;
}

export interface OwnedFacts {
  readonly documentId: string;
  readonly live: boolean;
  readonly epoch: number;
  readonly revision: number;
  readonly observation: number;
  readonly subject?: object;
}
export type OwnedAdmission = 'accepted' | 'restart' | 'discard';
export interface CoreEntry {
  facts(): OwnedFacts;
  transport(): Transport;
  subject(): object | undefined;
  subjectFacts(subject: object):
    | Readonly<{
        birth: CanvasDocIncarnation;
        httpBaseline?: Readonly<{ birth: CanvasDocIncarnation; floor: number }>;
      }>
    | undefined;
  subjectCurrent(subject: object, submit?: boolean): boolean;
  binding(subject: object): DocChannelBinding | undefined;
  qualified(): boolean;
  projection(): OwnedProjection;
  projectionCurrent(epoch: number, subject?: object, run?: object): boolean;
  abortAdmission(run: object, page: object): void;
  reserve(run: object): void;
  current(run: object): boolean;
  admit(run: object, page: object): OwnedAdmission;
  frame(run: object, ticket: object, pending: boolean): boolean;
  qualify(run: object): boolean;
  failed(run: object): void;
  unavailable(run: object): void;
  start(recover: () => void): void;
  dispose(): void;
}
const owners = new WeakMap<object, CoreEntry>();
interface OriginalConstruction {
  readonly documentId: string;
  readonly transport: Transport;
  readonly dispatch: Dispatch<SetStateAction<View>>;
}
const constructing = new WeakMap<object, Readonly<OriginalConstruction>>();
/** Consume the private once-only constructor ticket before building its owned lifecycle. */
export function consumeOwnedConstruction(custodyKey: object): Readonly<OriginalConstruction> {
  const original = constructing.get(custodyKey);
  if (!original) throw new Error('Document construction ticket is foreign or consumed.');
  constructing.delete(custodyKey);
  return original;
}
/** Construct one opaque custody key and its genuine lifecycle without a caller installer. */
export function createOwnedCustody(
  documentId: string,
  transport: Transport,
  dispatch: Dispatch<SetStateAction<View>>
): object {
  const custodyKey = Object.freeze({});
  constructing.set(custodyKey, Object.freeze({ documentId, transport, dispatch }));
  try {
    const entry = buildOwnedLifecycle(custodyKey);
    owners.set(custodyKey, entry);
    return custodyKey;
  } finally {
    constructing.delete(custodyKey);
  }
}
function core(owner: object): CoreEntry {
  const entry = owners.get(owner);
  if (!entry) throw new Error('Document owner is foreign.');
  return entry;
}
/** Reject keys absent from the genuine private owner registry. */
export function requireOwnedCustody(owner: object): void {
  core(owner);
}
/** Read fixed frozen lifecycle facts for the genuine owner key. */
export function readOwnedFacts(owner: object): OwnedFacts {
  return core(owner).facts();
}
/** Select the Transport captured by this genuine owner’s constructor. */
export function readOwnedTransport(owner: object): Transport {
  return core(owner).transport();
}
/** Capture the lifecycle’s current issued subject without returning a mutable record. */
export function captureOwnedSubject(owner: object): object | undefined {
  return core(owner).subject();
}
/** Select private subject facts through the genuine owner’s fixed operation. */
export function readOwnedSubject(owner: object, subject: object) {
  return core(owner).subjectFacts(subject);
}
/** Check this owner’s exact issued subject for read or submit purpose. */
export function ownedSubjectCurrent(owner: object, subject: object, submit = false): boolean {
  return core(owner).subjectCurrent(subject, submit);
}
/** Read native binding operations only for this owner’s issued subject. */
export function bindOwnedSubject(owner: object, subject: object) {
  return core(owner).binding(subject);
}
/** Capture only this owned HTTP record's actual MCP source; ordinary routing guards are unchanged. */
function readRecordMcpBinding(custodyKey: object, subject: object) {
  const record = recordFor(custodyKey, subject);
  const origin = record?.mcpOrigin;
  if (!record || !origin || !record.httpBaseline || !recordSubjectCurrent(custodyKey, subject))
    return undefined;
  if (record.mcpBinding?.current('read')) return record.mcpBinding;
  const sameOrigin = () => {
    const current = recordFor(custodyKey, subject)?.mcpOrigin;
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
/** Reserve this owner’s captured replay run before any observable page work. */
export function reserveOwnedRun(owner: object, run: object): void {
  core(owner).reserve(run);
}
/** Require the exact captured run to remain this owner’s current repair. */
export function ownedRunCurrent(owner: object, run: object): boolean {
  return core(owner).current(run);
}
/** Consume only the genuine owned HTTP page through fixed lifecycle admission. */
export function admitOwnedReplay(owner: object, run: object, page: object): OwnedAdmission {
  return core(owner).admit(run, page);
}
/** Deliver one captured run frame through the fixed owner lifecycle operation. */
export function deliverOwnedFrame(
  owner: object,
  run: object,
  ticket: object,
  pending: boolean
): boolean {
  return core(owner).frame(run, ticket, pending);
}
/** Qualify only the current run whose retained catch-up witness is complete. */
export function completeOwnedCatchup(owner: object, run: object): boolean {
  return core(owner).qualify(run);
}
/** Disable the captured current run’s subject without changing a newer winner. */
export function failOwnedReplay(owner: object, run: object): void {
  core(owner).failed(run);
}
/** Project unavailability only while the captured run remains current. */
export function unavailableOwnedReplay(owner: object, run: object): void {
  core(owner).unavailable(run);
}
/** Subscribe the genuine lifecycle before starting its owned HTTP recovery. */
export function startOwnedCustody(owner: object, recover: () => void): void {
  core(owner).start(recover);
}
/** Retire this owner’s subject and resources through its fixed lifecycle disposal. */
export function disposeOwnedCustody(owner: object): void {
  core(owner).dispose();
}
export interface OwnedProjection {
  readonly documentId: string;
  readonly transport: Transport;
  readonly dispatch: Dispatch<SetStateAction<View>>;
  readonly epoch: number;
  readonly run?: object;
  readonly subject?: object;
}
const projectionCaptures = new WeakMap<
  object,
  Readonly<{ custodyKey: object; capture: Readonly<OwnedProjection> }>
>();
/** Capture projection facts with private membership bound to their genuine custody key. */
export function readOwnedProjection(owner: object): Readonly<OwnedProjection> {
  const capture = Object.freeze(core(owner).projection());
  projectionCaptures.set(capture, Object.freeze({ custodyKey: owner, capture }));
  return capture;
}
/** Reject foreign projection captures before checking their owner, epoch and subject. */
export function ownedProjectionCurrent(
  owner: object,
  capture: Readonly<OwnedProjection>,
  run?: object
): boolean {
  const association = projectionCaptures.get(capture);
  return (
    association?.custodyKey === owner &&
    association.capture === capture &&
    core(owner).projectionCurrent(capture.epoch, capture.subject, run)
  );
}
/** Roll back only this owner’s exact provisional HTTP admission. */
export function abortOwnedAdmission(owner: object, run: object, page: object): void {
  core(owner).abortAdmission(run, page);
}

/** Read whether the genuine owner has finished its current birth qualification. */
export function ownedBirthQualified(owner: object): boolean {
  return core(owner).qualified();
}
