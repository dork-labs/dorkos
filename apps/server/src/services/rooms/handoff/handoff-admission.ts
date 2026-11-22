/** Public NEW-work admission policy, not native tool-use or completed-report attribution. */
import type { RoomCore } from '../service/room-core.js';
import type { RoomHandoff, HandoffOrigin } from './handoff-presentation.js';
import { decodeHandoffEnvelope, type HandoffEnvelope } from './handoff-envelope.js';
import { randomUUID } from 'node:crypto';
import { turnSerialOf, lastTurnLevelOf } from '../../core/turn-power/turn-levels.js';
import { captureCurrentTransfer } from '../../core/turn-power/current-transfer.js';
import type { AuthorRecord } from '../author-registry.js';
import type { RoomStore } from '../room-store.js';
import type { AsideCarry } from '../room-trigger/aside.js';

/** Call only with the author/session resolved by the server's capability context. */
export function captureHandoffAdmission(
  store: Pick<RoomStore, 'handoffOutbox'>,
  author: AuthorRecord,
  callerSessionId: string
) {
  if (author.kind !== 'agent' || !author.naturalKey || !callerSessionId) return undefined;
  // Both reads are synchronous: this witnesses CURRENT admission, not an older native turn.
  const recipient = store.handoffOutbox.captureRecipient(
    callerSessionId,
    author.id,
    author.naturalKey
  );
  if (!recipient) return undefined;
  const serial = turnSerialOf(callerSessionId);
  const transfer =
    serial === undefined ? undefined : captureCurrentTransfer(callerSessionId, serial);
  const recorded = transfer?.state === 'recorded-transfer' ? transfer : undefined;
  const known = lastTurnLevelOf(callerSessionId);
  if (!recorded && !known) return undefined;
  // A refused turn or moved seat lacks a positive transfer capture. Keep its OWN marks,
  // bound to read/ask, instead of borrowing another chat's running authority or refusing it.
  const carried: AsideCarry = Object.freeze(
    recorded
      ? {
          externalAuthor: recorded.carry.externalAuthor,
          ...(recorded.carry.permissionCeiling === null
            ? {}
            : { permissionCeiling: recorded.carry.permissionCeiling }),
          ...(recorded.carry.outsider ? { outsider: true } : {}),
          ...(recorded.carry.teammate ? { teammate: true } : {}),
          ...(recorded.carry.outsideWords ? { outsideWords: true } : {}),
        }
      : {
          externalAuthor: true,
          outsider: true,
          outsideWords: true,
          ...(known?.teammate?.length ? { teammate: true } : {}),
          permissionCeiling: Object.freeze({
            asks: 'always',
            reach: 'read',
            outsider: true,
            ...(known?.teammate
              ? {
                  teammate: Object.freeze(
                    known.teammate.map((origin) => Object.freeze({ ...origin }))
                  ),
                }
              : {}),
          }),
        }
  );
  return Object.freeze({
    id: randomUUID() as string,
    recipient,
    callerSessionId,
    authorId: author.id,
    agentPath: author.naturalKey,
    admittedSerial: recorded ? serial! : null,
    policyEvidence: recorded ? ('admission-current' as const) : ('conservative-fallback' as const),
    wordEvidence: recorded ? ('recorded' as const) : ('conservative' as const),
    carried,
  });
}
/** Frozen original public admission and transferable policy. */
export type HandoffAdmission = NonNullable<ReturnType<typeof captureHandoffAdmission>>;

/** Only server-owned ledger/clock values may complete this immutable durable packet. */
export function handoffEnvelopeForAdmission(
  admission: HandoffAdmission,
  seat: HandoffEnvelope['seat'],
  enqueuedAt: number,
  waitDeadlineAt: number
): HandoffEnvelope {
  return decodeHandoffEnvelope(
    JSON.stringify({
      version: 2,
      evidence: {
        state:
          admission.policyEvidence === 'admission-current'
            ? 'recorded-transfer'
            : 'conservative-fallback',
        wordEvidence: admission.wordEvidence,
        sessionId: admission.callerSessionId,
        turnSerial: admission.admittedSerial,
      },
      source: {
        id: admission.id,
        callerSessionId: admission.callerSessionId,
        agentPath: admission.agentPath,
      },
      recipient: admission.recipient,
      seat,
      enqueuedAt,
      waitDeadlineAt,
      carry: {
        externalAuthor: admission.carried.externalAuthor ?? false,
        permissionCeiling: admission.carried.permissionCeiling ?? null,
        outsider: admission.carried.outsider === true,
        teammate: admission.carried.teammate === true,
        outsideWords: admission.carried.outsideWords === true,
      },
    })
  );
}

/** Draft facts supplied by the already-authenticated capability handler. */
export interface HandoffDraftInput {
  roomId: string;
  author: AuthorRecord;
  text: string;
  replyTo?: string;
  verbatim: boolean;
  callerSessionId: string;
}

/** Persist an immutable admission inside the existing queue's synchronous reserved factory. */
export function admitPublicHandoff(
  core: RoomCore,
  input: HandoffDraftInput,
  clocks: { acceptedAt: number; waitDeadlineAt: number },
  readOrigin: () => HandoffOrigin
): RoomHandoff {
  const { roomId, author } = input;
  const { acceptedAt, waitDeadlineAt } = clocks;
  const admission = captureHandoffAdmission(core.store, author, input.callerSessionId);
  if (!admission) throw new Error('Current admission policy or recipient is unavailable.');
  const member = core.store.getMember(roomId, author.id);
  if (!member) throw new Error('Membership changed before admission.');
  const seat = core.store.bindRoomSession(
    roomId,
    author.id,
    core.store.getRoomSession(roomId, author.id) ?? randomUUID(),
    new Date(acceptedAt).toISOString()
  );
  const envelope = handoffEnvelopeForAdmission(
    admission,
    {
      roomId,
      authorId: author.id,
      sessionId: seat,
      canonicalSessionId: seat,
      joinedAt: member.joinedAt,
      agentPath: author.naturalKey,
    },
    acceptedAt,
    waitDeadlineAt
  );
  const origin = readOrigin();
  const envelopeJson = JSON.stringify(envelope);
  // Durability precedes accepted receipt publication; same synchronous reserved factory.
  core.store.handoffOutbox.admit({
    envelopeJson,
    draft: input.text,
    originJson: JSON.stringify(origin),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    verbatim: input.verbatim,
  });
  const handoff: RoomHandoff = {
    id: admission.id,
    waitDeadlineAt: envelope.waitDeadlineAt,
    waitAbort: new AbortController(),
    roomId,
    authorId: author.id,
    draft: input.text,
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    verbatim: input.verbatim,
    origin,
    carried: admission.carried,
    admission,
    envelopeJson,
    ownedSeatSessionId: seat,
  };
  return handoff;
}
