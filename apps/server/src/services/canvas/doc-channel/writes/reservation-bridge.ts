/** Fixed owning-row admission and conversion; no transferable credit or append permit. */
import { sql, canvasDocEvents, canvasDocWriteIntents, type DbTransaction } from '@dorkos/db';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import {
  auditCheckboxTerminalProjection,
  requireCheckboxSubjectRow,
  readCheckboxOriginalIntent,
} from './reservation-audit.js';
import {
  appendConvertedCheckboxEvent,
  type DocChannelStore,
  type DocEventRow,
  type DocBatchRow,
  type DocWriteIntentRow,
} from '../store.js';
import { backfillEnvelopeAccounting, type DocIngestLimits } from '../current/accounting.js';
import {
  checkCheckboxTerminal,
  sameCheckboxRow as same,
  stagedCheckboxRow,
  replacedCheckboxRow,
  requireCheckboxRow,
  requireCheckboxTerminalAbsentOutbox,
} from './reservation-terminal.js';
import type { CheckboxPhysicalIdentity, CheckboxReceipt } from './checkbox-evidence.js';
import { requireCheckboxCapacity, checkboxReservationLimits } from './reservation-capacity.js';
import { auditOriginalCheckboxOutbox } from './reservation-outbox.js';
import type { DocIngestAccess } from '../ingest-types.js';
import {
  createCheckboxReservationBinding,
  runCheckboxReservationTransaction,
  requireCheckboxReservationExit,
  requireCheckboxReservationScope,
  requireCheckboxReservationSubject,
  type DocCheckboxAuthority,
  type CheckboxReservationBinding,
  type CheckboxReservationSubject,
} from './authority.js';
import { checkboxAuthoritySync, type CheckboxAuthoritySnapshot } from './authority-snapshot.js';
import {
  freezeCheckboxData,
  validateCheckboxEvidence,
  VerifiedCheckboxAuthoritySchema,
  CheckboxPhysicalIdentitySchema,
} from './checkbox-evidence.js';
import { projectVerifiedCheckbox, type VerifiedCheckboxProjection } from './completion.js';
import {
  scanCheckboxReservationPolicies,
  readCheckboxReservationPolicy,
  type CheckboxReservationPolicy,
} from './reservation-policy-census.js';

interface Scope {
  binding: CheckboxReservationBinding;
  store?: DocChannelStore;
  failed: boolean;
  cause?: unknown;
  conversionAttempted: boolean;
  obligation?: {
    projection: VerifiedCheckboxProjection;
    event: DocEventRow;
    policy: CheckboxReservationPolicy;
    documentLabel: string;
    priorBatch: DocBatchRow | null;
  };
  outboxStarted?: boolean;
  rowObligation?: {
    row: DocWriteIntentRow;
    terminal: boolean;
    effect?: boolean;
    prepared?: boolean;
  };
  staged?: { store: DocChannelStore; projection: VerifiedCheckboxProjection; receivedAt: string };
}
const scopes = new WeakMap<DbTransaction, Scope>();
function fail(scope: Scope, cause: unknown): never {
  if (!scope.failed) {
    scope.failed = true;
    scope.cause = cause;
  }
  throw cause;
}
function ownScope(binding: CheckboxReservationBinding, tx: DbTransaction): Scope {
  requireCheckboxReservationScope(binding, tx);
  const current = scopes.get(tx);
  if (current && current.binding !== binding)
    return fail(current, new Error('Reservation binding cannot change within a scope.'));
  if (current?.failed) throw current.cause;
  const scope = current ?? { binding, failed: false, conversionAttempted: false };
  scopes.set(tx, scope);
  return scope;
}
function guarded<T>(
  binding: CheckboxReservationBinding,
  tx: DbTransaction,
  work: (scope: Scope) => T
): T {
  const scope = ownScope(binding, tx);
  try {
    return checkboxAuthoritySync(work(scope));
  } catch (cause) {
    return fail(scope, cause);
  }
}
function captureSubject(subject: CheckboxReservationSubject): CheckboxReservationSubject {
  checkboxAuthoritySync(subject);
  const approved = freezeCheckboxData(VerifiedCheckboxAuthoritySchema.parse(subject.approved));
  if (subject.kind === 'live')
    return freezeCheckboxData({
      kind: 'live',
      request: CanvasChannelCheckboxRequestSchema.parse(subject.request),
      actor: { principal: subject.actor.principal, surface: subject.actor.surface },
      approved,
    });
  if (subject.kind !== 'recovery') throw new Error('Unknown checkbox reservation subject.');
  const original = structuredClone(subject.intent);
  validateCheckboxEvidence(original);
  return freezeCheckboxData({ kind: 'recovery', intent: original, approved });
}
export interface CheckboxFixedRowInput {
  expected: DocWriteIntentRow;
  subject: CheckboxReservationSubject;
  freshSnapshot: CheckboxAuthoritySnapshot;
}
export interface CheckboxFixedTerminalInput {
  candidate: DocWriteIntentRow;
  liveSubject: Extract<CheckboxReservationSubject, { kind: 'live' }>;
  freshSnapshot: CheckboxAuthoritySnapshot;
}

/** Factory binds actual A/store identities before SQL; policy is data, not executable authority. */
export function createCheckboxReservationBridge(
  authority: DocCheckboxAuthority,
  store: DocChannelStore,
  policyLimits: DocIngestLimits
) {
  const binding = createCheckboxReservationBinding(authority, store);
  const caps = checkboxReservationLimits(policyLimits);
  const terminal = (
    kind: 'no_op' | 'conflict',
    input: CheckboxFixedTerminalInput,
    tx: DbTransaction
  ): CheckboxReceipt =>
    guarded(binding, tx, (scope) => {
      if (scope.rowObligation || scope.conversionAttempted)
        throw new Error('Only one checkbox operation may occur per scope.');
      const subject = captureSubject(input.liveSubject);
      const candidate = freezeCheckboxData(structuredClone(input.candidate));
      if (subject.kind !== 'live')
        throw new Error('Only a genuine live request can record new terminal evidence.');
      requireCheckboxSubjectRow(subject, candidate);
      const receipt = checkCheckboxTerminal(candidate, kind);
      const census = scanCheckboxReservationPolicies(tx, {
        documentId: candidate.documentId,
        eventId: candidate.eventId,
        routeId: subject.approved.routeId!,
      });
      const current = requireCheckboxReservationSubject(binding, subject, input.freshSnapshot, tx);
      if (census.raw.matchingIntent)
        throw new Error('Document event UUID is permanently reserved.');
      requireCheckboxTerminalAbsentOutbox(tx, candidate);
      const row = freezeCheckboxData({
        ...candidate,
        createdAt: current.currentTime,
        updatedAt: current.currentTime,
      });
      scope.store = store;
      scope.rowObligation = { row, terminal: true };
      tx.insert(canvasDocWriteIntents).values(row).run();
      requireCheckboxRow(tx, row);
      return receipt;
    });
  const transition = (
    mode: 'staged' | 'replaced',
    input: CheckboxFixedRowInput,
    tx: DbTransaction,
    replacement?: CheckboxPhysicalIdentity
  ): DocWriteIntentRow =>
    guarded(binding, tx, (scope) => {
      if (scope.rowObligation || scope.conversionAttempted)
        throw new Error('Only one checkbox operation may occur per scope.');
      const subject = captureSubject(input.subject);
      const original = freezeCheckboxData(structuredClone(input.expected));
      requireCheckboxSubjectRow(subject, original);
      requireCheckboxRow(tx, original);
      const identity =
        mode === 'staged'
          ? freezeCheckboxData(CheckboxPhysicalIdentitySchema.parse(replacement))
          : undefined;
      readCheckboxReservationPolicy(tx, original);
      const current = requireCheckboxReservationSubject(binding, subject, input.freshSnapshot, tx);
      const row =
        mode === 'replaced'
          ? replacedCheckboxRow(original, current.currentTime)
          : stagedCheckboxRow(original, identity!, current.currentTime);
      requireCheckboxRow(tx, original);
      readCheckboxReservationPolicy(tx, original);
      scope.store = store;
      scope.rowObligation = { row, terminal: false };
      if (
        !store.transitionWriteIntent(
          original.intentId,
          'prepared',
          {
            status: row.status,
            evidence: row.evidence,
            errorCode: row.errorCode,
            updatedAt: row.updatedAt,
          },
          tx
        )
      )
        throw new Error('Checkbox original transition raced.');
      requireCheckboxRow(tx, row);
      return row;
    });
  const requireEffect = (input: CheckboxFixedRowInput, tx: DbTransaction): undefined => {
    return guarded(binding, tx, (scope) => {
      if (scope.rowObligation || scope.conversionAttempted)
        throw new Error('Only one checkbox operation may occur per scope.');
      const subject = captureSubject(input.subject);
      const original = freezeCheckboxData(structuredClone(input.expected));
      const evidence = validateCheckboxEvidence(original);
      if (
        subject.kind !== 'live' ||
        original.status !== 'prepared' ||
        original.errorCode !== null ||
        evidence.v !== 2 ||
        evidence.receipt ||
        evidence.preEffectRefusal ||
        !evidence.tempPath ||
        !evidence.tempIdentity
      )
        throw new Error('Checkbox effect requires its original live staged evidence.');
      requireCheckboxSubjectRow(subject, original);
      requireCheckboxRow(tx, original);
      scanCheckboxReservationPolicies(tx, {
        documentId: original.documentId,
        eventId: original.eventId,
        routeId: subject.approved.routeId!,
      });
      readCheckboxReservationPolicy(tx, original);
      requireCheckboxTerminalAbsentOutbox(tx, original);
      requireCheckboxReservationSubject(binding, subject, input.freshSnapshot, tx);
      requireCheckboxRow(tx, original);
      readCheckboxReservationPolicy(tx, original);
      requireCheckboxTerminalAbsentOutbox(tx, original);
      scope.store = store;
      scope.rowObligation = { row: original, terminal: false, effect: true };
      return undefined;
    });
  };
  return Object.freeze({
    insertNoOpInTransaction: (input: CheckboxFixedTerminalInput, tx: DbTransaction) =>
      terminal('no_op', input, tx),
    insertConflictInTransaction: (input: CheckboxFixedTerminalInput, tx: DbTransaction) =>
      terminal('conflict', input, tx),
    stageInTransaction: (
      input: CheckboxFixedRowInput & { replacement: CheckboxPhysicalIdentity },
      tx: DbTransaction
    ) => transition('staged', input, tx, input.replacement),
    replaceInTransaction: (input: CheckboxFixedRowInput, tx: DbTransaction) =>
      transition('replaced', input, tx),
    /** Consume genuine current authority for the unchanged staged row immediately before effect. */
    requireEffectInTransaction: requireEffect,
    /** Fixed closed-runner gate; no callback, transaction handle or reusable permission is returned. */
    requireEffect: (input: CheckboxFixedRowInput): undefined =>
      runCheckboxReservationTransaction(binding, (tx) => requireEffect(input, tx)),
    insertPreparedInTransaction(
      input: {
        candidate: DocWriteIntentRow;
        liveSubject: Extract<CheckboxReservationSubject, { kind: 'live' }>;
        freshSnapshot: CheckboxAuthoritySnapshot;
      },
      tx: DbTransaction
    ): undefined {
      return guarded(binding, tx, (scope) => {
        if (scope.rowObligation || scope.conversionAttempted)
          throw new Error('Only one checkbox operation may occur per scope.');
        checkboxAuthoritySync(input);
        const subject = captureSubject(input.liveSubject);
        const candidate = freezeCheckboxData(structuredClone(input.candidate));
        if (candidate.status !== 'prepared' || subject.kind !== 'live')
          throw new Error('Only live new prepared work can reserve admission.');
        requireCheckboxSubjectRow(subject, candidate);
        const projection = projectVerifiedCheckbox(candidate);
        const summary = scanCheckboxReservationPolicies(tx, {
          documentId: candidate.documentId,
          eventId: candidate.eventId,
          routeId: subject.approved.routeId!,
        });
        const originalPolicy = readCheckboxReservationPolicy(tx, candidate);
        backfillEnvelopeAccounting(store, tx);
        const current = requireCheckboxReservationSubject(
          binding,
          subject,
          input.freshSnapshot,
          tx
        );
        if (
          summary.raw.matchingIntent ||
          tx.get(
            sql`SELECT 1 FROM canvas_doc_events WHERE document_id=${candidate.documentId} AND event_id=${candidate.eventId}`
          )
        )
          throw new Error('Document event UUID is permanently reserved.');
        requireCheckboxCapacity(
          tx,
          summary,
          candidate,
          originalPolicy,
          projection,
          caps,
          false,
          current.currentTime,
          current.documentLabel
        );
        readCheckboxReservationPolicy(tx, candidate);
        scope.store = store;
        scope.rowObligation = { row: candidate, terminal: false, prepared: true };
        requireCheckboxTerminalAbsentOutbox(tx, candidate);
        tx.insert(canvasDocWriteIntents).values(candidate).run();
        requireCheckboxRow(tx, candidate);
        requireCheckboxTerminalAbsentOutbox(tx, candidate);
        return undefined;
      });
    },
    convertOwnReservationInTransaction(
      input: {
        intentId: string;
        subject: CheckboxReservationSubject;
        freshSnapshot: CheckboxAuthoritySnapshot;
      },
      tx: DbTransaction
    ): DocEventRow {
      return guarded(binding, tx, (scope) => {
        if (scope.rowObligation || scope.conversionAttempted)
          throw new Error('Only one checkbox conversion may occur per scope.');
        scope.conversionAttempted = true;
        checkboxAuthoritySync(input);
        const subject = captureSubject(input.subject);
        const row = readCheckboxOriginalIntent(tx, input.intentId);
        if (row.status !== 'replaced')
          throw new Error('Checkbox conversion requires its original replaced row.');
        requireCheckboxSubjectRow(subject, row);
        const projection = projectVerifiedCheckbox(row);
        const summary = scanCheckboxReservationPolicies(tx, {
          documentId: row.documentId,
          eventId: row.eventId,
          routeId: subject.approved.routeId!,
        });
        if (!summary.matching || !same(summary.matching.intent, row))
          throw new Error('Original conversion reservation changed.');
        if (
          tx.get(
            sql`SELECT 1 FROM canvas_doc_events WHERE document_id=${row.documentId} AND event_id=${row.eventId}`
          )
        )
          throw new Error('Original conversion event already exists.');
        backfillEnvelopeAccounting(store, tx);
        const current = requireCheckboxReservationSubject(
          binding,
          subject,
          input.freshSnapshot,
          tx
        );
        const priorBatch = requireCheckboxCapacity(
          tx,
          summary,
          row,
          summary.matching.policy,
          projection,
          caps,
          true,
          current.currentTime,
          current.documentLabel
        );
        const finalPolicy = readCheckboxReservationPolicy(tx, row);
        if (!same(readCheckboxOriginalIntent(tx, row.intentId), row))
          throw new Error('Original conversion row changed at the final gate.');
        scope.store = store;
        scope.staged = { store, projection, receivedAt: current.currentTime };
        const event = appendConvertedCheckboxEvent(store, tx);
        scope.obligation = {
          projection,
          event: freezeCheckboxData(structuredClone(event)),
          policy: finalPolicy,
          documentLabel: current.documentLabel,
          priorBatch,
        };
        return event;
      });
    },
  });
}

/** Store-only fixed consumption; no event argument or reusable append authority. */
export function consumeCheckboxReservationAppend(
  store: DocChannelStore,
  tx: DbTransaction
): Omit<typeof canvasDocEvents.$inferInsert, 'docSeq'> {
  const scope = scopes.get(tx);
  if (!scope || scope.failed || scope.staged?.store !== store)
    throw new Error('No owning checkbox append is staged.');
  requireCheckboxReservationScope(scope.binding, tx);
  const staged = scope.staged;
  delete scope.staged;
  const { projection } = staged;
  return {
    documentId: projection.intent.documentId,
    eventId: projection.event.id,
    direction: 'upstream',
    type: projection.event.type,
    payload: projection.event.payload,
    envelopeHash: projection.identity.hash,
    envelopeBytes: projection.identity.bytes,
    provenance: projection.provenance,
    receivedAt: staged.receivedAt,
    coalesceKey: null,
    clientTs: null,
    payloadPrunedAt: null,
  };
}
/** Fixed completion data from the already-converted original; this is not reusable authority. */
export function readCheckboxConvertedIntent(
  store: DocChannelStore,
  tx: DbTransaction
): DocWriteIntentRow {
  const scope = scopes.get(tx);
  if (!scope || scope.failed || scope.store !== store || !scope.obligation)
    throw new Error('No original checkbox conversion is active.');
  requireCheckboxReservationScope(scope.binding, tx);
  return scope.obligation.projection.intent;
}
/** Fixed genuine ingest reads this once; the returned data grants no independent append authority. */
export function readCheckboxConversionInput(
  store: DocChannelStore,
  tx: DbTransaction
): { event: DocEventRow; access: DocIngestAccess } {
  const scope = scopes.get(tx);
  if (!scope || scope.failed || !scope.obligation || scope.outboxStarted)
    throw new Error('No original checkbox outbox is available.');
  requireCheckboxReservationScope(scope.binding, tx);
  if (scope.store !== store) throw new Error('Checkbox outbox store changed.');
  scope.outboxStarted = true;
  const { event, policy, documentLabel, projection } = scope.obligation;
  return freezeCheckboxData({
    event,
    access: {
      documentId: event.documentId,
      scope: policy.scope,
      documentLabel,
      provenance: projection.provenance,
      routes: [
        {
          route: policy.route,
          grantId: projection.intent.grantId,
          grantRevision: validateCheckboxEvidence(projection.intent).authority.grantRevision,
        },
      ],
    },
  });
}
/** Fixed predicate for the coalescer's private capture; it grants no caller identity or append authority. */
export function isOriginalCheckboxQueueScope(
  store: DocChannelStore,
  tx: DbTransaction,
  event: DocEventRow
): boolean {
  const scope = scopes.get(tx);
  if (!scope || scope.store !== store || !scope.obligation || !scope.outboxStarted) return false;
  requireCheckboxReservationScope(scope.binding, tx);
  if (scope.failed) throw scope.cause;
  return same(scope.obligation.event, event);
}
/** Reduction-only failure latch; caught route/terminal errors cannot commit partial work. */
export function failCheckboxCompletion(
  store: DocChannelStore,
  tx: DbTransaction,
  cause: unknown
): never {
  const scope = scopes.get(tx);
  if (!scope || scope.store !== store) throw cause;
  requireCheckboxReservationScope(scope.binding, tx);
  return fail(scope, cause);
}
/** Fixed A exit obligation; a caller catching refusal cannot commit partial evidence. */
export function auditCheckboxReservationScope(tx: DbTransaction, owner: unknown): void {
  const scope = scopes.get(tx);
  if (!scope) return;
  requireCheckboxReservationExit(scope.binding, owner, tx);
  if (scope.failed) throw scope.cause;
  requireCheckboxReservationScope(scope.binding, tx);
  if (scope.staged || (scope.conversionAttempted && !scope.obligation))
    throw new Error('Checkbox conversion is unfinished.');
  if (scope.rowObligation) {
    requireCheckboxRow(tx, scope.rowObligation.row);
    if (scope.rowObligation.terminal || scope.rowObligation.effect || scope.rowObligation.prepared)
      requireCheckboxTerminalAbsentOutbox(tx, scope.rowObligation.row);
  }
  if (!scope.obligation) return;
  auditCheckboxTerminalProjection(tx, scope.obligation);
  if (!scope.outboxStarted)
    throw new Error('Checkbox original durable completion outbox is absent.');
  auditOriginalCheckboxOutbox(tx, scope.obligation, scope.store!);
}
/** Only the authoritative scoped callback retires this private state after its final audit. */
export function retireCheckboxReservationScope(tx: DbTransaction, owner: unknown): void {
  const scope = scopes.get(tx);
  if (scope) {
    requireCheckboxReservationExit(scope.binding, owner, tx);
    scopes.delete(tx);
  }
}
