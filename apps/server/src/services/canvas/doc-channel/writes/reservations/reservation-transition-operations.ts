import { canvasDocWriteIntents, type DbTransaction } from '@dorkos/db';
import { requireCheckboxSubjectRow } from './reservation-audit.js';
import {
  checkCheckboxTerminal,
  stagedCheckboxRow,
  replacedCheckboxRow,
  requireCheckboxRow,
  requireCheckboxTerminalAbsentOutbox,
} from './reservation-terminal.js';
import type { DocWriteIntentRow } from '../../store.js';
import type { CheckboxPhysicalIdentity, CheckboxReceipt } from '../checkbox-evidence.js';
import {
  freezeCheckboxData,
  validateCheckboxEvidence,
  CheckboxPhysicalIdentitySchema,
} from '../checkbox-evidence.js';
import { requireCheckboxReservationSubject } from '../authority.js';
import {
  scanCheckboxReservationPolicies,
  readCheckboxReservationPolicy,
} from './reservation-policy-census.js';
import {
  readOriginalReservationTransitionView,
  type CheckboxFixedRowInput,
  type CheckboxFixedTerminalInput,
} from './reservation-bridge.js';

/** Original terminal row handling selected only by the private bridge factory key. */
export function recordOriginalReservationTerminal(
  owner: object,
  kind: 'no_op' | 'conflict',
  input: CheckboxFixedTerminalInput,
  tx: DbTransaction
): CheckboxReceipt {
  const facet = readOriginalReservationTransitionView(owner);
  return facet.guarded(facet.binding, tx, (scope) => {
    if (scope.rowObligation || scope.conversionAttempted)
      throw new Error('Only one checkbox operation may occur per scope.');
    const subject = facet.captureSubject(input.liveSubject);
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
    const current = requireCheckboxReservationSubject(
      facet.binding,
      subject,
      input.freshSnapshot,
      tx
    );
    if (census.raw.matchingIntent) throw new Error('Document event UUID is permanently reserved.');
    requireCheckboxTerminalAbsentOutbox(tx, candidate);
    const row = freezeCheckboxData({
      ...candidate,
      createdAt: current.currentTime,
      updatedAt: current.currentTime,
    });
    scope.store = facet.store;
    scope.rowObligation = { row, terminal: true };
    tx.insert(canvasDocWriteIntents).values(row).run();
    requireCheckboxRow(tx, row);
    return receipt;
  });
}

/** Original staged/replaced row handling selected only by the private bridge factory key. */
export function transitionOriginalReservationRow(
  owner: object,
  mode: 'staged' | 'replaced',
  input: CheckboxFixedRowInput,
  tx: DbTransaction,
  replacement?: CheckboxPhysicalIdentity
): DocWriteIntentRow {
  const facet = readOriginalReservationTransitionView(owner);
  return facet.guarded(facet.binding, tx, (scope) => {
    if (scope.rowObligation || scope.conversionAttempted)
      throw new Error('Only one checkbox operation may occur per scope.');
    const subject = facet.captureSubject(input.subject);
    const original = freezeCheckboxData(structuredClone(input.expected));
    requireCheckboxSubjectRow(subject, original);
    requireCheckboxRow(tx, original);
    const identity =
      mode === 'staged'
        ? freezeCheckboxData(CheckboxPhysicalIdentitySchema.parse(replacement))
        : undefined;
    readCheckboxReservationPolicy(tx, original);
    const current = requireCheckboxReservationSubject(
      facet.binding,
      subject,
      input.freshSnapshot,
      tx
    );
    const row =
      mode === 'replaced'
        ? replacedCheckboxRow(original, current.currentTime)
        : stagedCheckboxRow(original, identity!, current.currentTime);
    requireCheckboxRow(tx, original);
    readCheckboxReservationPolicy(tx, original);
    scope.store = facet.store;
    scope.rowObligation = { row, terminal: false };
    if (
      !facet.store.transitionWriteIntent(
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
}

/** Original effect admission selected only by the private bridge factory key. */
export function requireOriginalReservationEffect(
  owner: object,
  input: CheckboxFixedRowInput,
  tx: DbTransaction
): undefined {
  const facet = readOriginalReservationTransitionView(owner);
  return facet.guarded(facet.binding, tx, (scope) => {
    if (scope.rowObligation || scope.conversionAttempted)
      throw new Error('Only one checkbox operation may occur per scope.');
    const subject = facet.captureSubject(input.subject);
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
    requireCheckboxReservationSubject(facet.binding, subject, input.freshSnapshot, tx);
    requireCheckboxRow(tx, original);
    readCheckboxReservationPolicy(tx, original);
    requireCheckboxTerminalAbsentOutbox(tx, original);
    scope.store = facet.store;
    scope.rowObligation = { row: original, terminal: false, effect: true };
    return undefined;
  });
}
