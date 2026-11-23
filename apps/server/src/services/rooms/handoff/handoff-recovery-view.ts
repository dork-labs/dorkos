/** Reconstruct queued work and present durable results without granting new authority. */
import { decodeHandoffEnvelope, joinHandoffCurrentCarry } from './handoff-envelope.js';
import {
  handoffOrigin,
  type HandoffOutboxRow,
  type HandoffOutboxStore,
} from './outbox/handoff-outbox-store.js';
import type { HandoffAdmission } from './handoff-admission.js';
import type { RoomHandoff } from './handoff-presentation.js';
import type { HandoffOutcomes, HandoffStatus } from './handoff-outcomes.js';

/** The stored deadline and marks are retained exactly, never renewed. */
export function restoreHandoff(row: HandoffOutboxRow): RoomHandoff {
  const envelope = decodeHandoffEnvelope(row.envelopeJson);
  const carried = joinHandoffCurrentCarry(envelope, { externalAuthor: false });
  const admission: HandoffAdmission = Object.freeze({
    id: row.id,
    recipient: envelope.recipient,
    callerSessionId: envelope.source.callerSessionId,
    authorId: row.authorId,
    agentPath: envelope.source.agentPath,
    admittedSerial: envelope.evidence.turnSerial,
    policyEvidence:
      envelope.evidence.state === 'recorded-transfer'
        ? 'admission-current'
        : 'conservative-fallback',
    wordEvidence: envelope.evidence.wordEvidence,
    carried,
  });
  return {
    id: row.id,
    waitDeadlineAt: row.waitDeadlineAt,
    waitAbort: new AbortController(),
    roomId: row.roomId,
    authorId: row.authorId,
    draft: row.draft,
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    verbatim: row.verbatim,
    origin: handoffOrigin.parse(JSON.parse(row.originJson)),
    carried,
    admission,
    envelopeJson: row.envelopeJson,
    ownedSeatSessionId: envelope.seat.canonicalSessionId,
  };
}

/** Settled truth survives eviction of process-local waiting hints. */
export function durableHandoffStatus(
  store: HandoffOutboxStore,
  outcomes: HandoffOutcomes,
  id: string,
  authorId: string,
  now: number,
  waitExpired: string
): HandoffStatus {
  const row = store.readOwned(id, authorId);
  if (!row)
    return {
      status: 'unknown',
      reason: 'No handoff of yours has that id. Check the original request before sharing again.',
    };
  if (row.state === 'posted')
    return row.postedEntryId !== null
      ? { status: 'posted', entryId: row.postedEntryId }
      : { status: 'declined', reason: 'The stored handoff result could not be verified.' };
  if (['declined', 'interrupted', 'expired', 'quarantined'].includes(row.state))
    return {
      status: 'declined',
      reason: row.terminalReason ?? 'This handoff ended without a post.',
    };
  if (row.state === 'queued' && now >= row.waitDeadlineAt)
    return { status: 'declined', reason: waitExpired };
  const transient = outcomes.read(id, authorId);
  if (transient.status === 'pending') return transient;
  return {
    status: 'pending',
    waiting: row.state === 'queued' ? 'queued' : 'running',
    reason:
      row.state === 'queued'
        ? 'This handoff is queued.'
        : 'The room chat is preparing or taking its turn.',
    waitEndsAt: new Date(row.waitDeadlineAt).toISOString(),
  };
}
