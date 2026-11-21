/** Fixed public terminal outbox consumer; existing private coordinator owns all dispatch/recovery. */
import { roomHandoffOutbox, rooms, roomMembers, eq, and, type DbTransaction } from '@dorkos/db';
import type { RoomEntry, RoomEntryBody } from '@dorkos/shared/room-schemas';
import type { RoomCore } from '../service/room-core.js';
import { captureAdmissionRecipient } from './outbox/admission-recipient.js';
import { buildHandoffNotice } from '../notices/notice-copy.js';
import { nameForAgents } from '../room-context.js';
import { roomLabel } from './handoff-presentation.js';
import { decodeSavedHandoffScope } from './outbox/handoff-outbox-store.js';
import {
  PrivateSessionMessageRefusalError,
  type PrivateSessionMessageAcceptanceService,
} from '../../session/private-messages/acceptance.js';
import type { HandoffTerminalSource } from './handoff-terminal-source.js';
import type { HandoffOutboxStore } from './outbox/handoff-outbox-store.js';
import { logger } from '../../../lib/logger.js';
/** Consume fixed durable public terminal sources through the existing private coordinator. */
export class HandoffTerminalNotices {
  constructor(
    private readonly store: HandoffOutboxStore,
    private readonly source: HandoffTerminalSource,
    private readonly acceptance: PrivateSessionMessageAcceptanceService,
    private readonly nudge: (sessionId: string) => void
  ) {}
  /** Synchronous ready-source acceptance; never writes into a room or calls a model itself. */
  flush(): void {
    for (const id of this.store.readyNoticeIds()) {
      const row = this.store.readReady(id);
      if (!row) continue;
      let origin: ReturnType<typeof decodeSavedHandoffScope>['origin'];
      try {
        ({ origin } = decodeSavedHandoffScope(row));
      } catch {
        this.store.skipNotice(id, 'The saved handoff notice scope is invalid.');
        continue;
      }
      if (origin.roomId !== null) continue;
      try {
        const accepted = this.acceptance.accept(this.source.reference(id));
        if (accepted.receipt.state === 'accepted') {
          try {
            this.nudge(accepted.receipt.sessionId);
          } catch {
            logger.debug('[handoffs] accepted notice waits for shared dispatcher', {
              handoffId: id,
            });
          }
        }
      } catch (error) {
        if (
          error instanceof PrivateSessionMessageRefusalError &&
          error.code === 'handoff_notice_unavailable'
        ) {
          this.store.skipNotice(id, 'The original requester cannot receive this update.');
          // Heartbeat, schedule and bridged chats skip by design; its status still answers.
          logger.debug('[rooms] hand-off answer skipped for a chat that cannot receive messages', {
            handoffId: id,
            sessionId: origin.sessionId,
          });
        } else throw error; // Unknown DB/source failures remain ready, never catch-to-clean/skip.
      }
    }
  }
}

/** Same-transaction writer for the original room's fixed SYSTEM notice. */
export type HandoffRoomNoticeWriter = (
  roomId: string,
  entryId: string,
  body: RoomEntryBody,
  within: (tx: DbTransaction) => void,
  bind: (tx: DbTransaction, seq: number) => void
) => RoomEntry;

/** Commit a notice only into its original current room and membership generation. */
export function flushOriginalRoomNotices(
  core: RoomCore,
  postOriginalNotice: HandoffRoomNoticeWriter
): void {
  for (const id of core.store.handoffOutbox.readyNoticeIds()) {
    const row = core.store.handoffOutbox.readReady(id);
    if (!row) continue;
    let origin: ReturnType<typeof decodeSavedHandoffScope>['origin'];
    let envelope: ReturnType<typeof decodeSavedHandoffScope>['envelope'];
    // Only pure decoding is classified here. Storage failures must retain the ready cursor.
    try {
      ({ origin, envelope } = decodeSavedHandoffScope(row));
    } catch {
      core.store.handoffOutbox.skipNotice(id, 'The saved handoff notice scope is invalid.');
      continue;
    }
    if (origin.roomId === null) continue;
    const noticeId = `handoff-notice-${row.id}`;
    const name = nameForAgents(core, row.authorId, { sentenceStart: true }) ?? 'An agent';
    const body = buildHandoffNotice(
      name,
      row.authorId,
      roomLabel(core.store.getRoom(row.roomId), core.bridges),
      row.state === 'posted' ? null : (row.terminalReason ?? 'it ended without a post.')
    );
    const allowed = (tx: DbTransaction): boolean => {
      const actual = tx
        .select()
        .from(roomHandoffOutbox)
        .where(eq(roomHandoffOutbox.id, row.id))
        .get();
      const room = tx.select().from(rooms).where(eq(rooms.id, origin.roomId!)).get();
      const member = tx
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, origin.roomId!), eq(roomMembers.authorId, row.authorId)))
        .get();
      const recipient = captureAdmissionRecipient(
        tx,
        envelope.source.callerSessionId,
        row.authorId,
        envelope.source.agentPath
      );
      const binding = core.store.sessionLedger.bindingForSession(origin.sessionId);
      return (
        !!actual &&
        actual.noticeState === 'ready' &&
        actual.envelopeJson === row.envelopeJson &&
        actual.originJson === row.originJson &&
        !!room &&
        !room.archived &&
        member?.joinedAt === origin.memberJoinedAt &&
        !!recipient &&
        recipient.digest === envelope.recipient.digest &&
        binding?.roomId === origin.roomId &&
        binding.authorId === row.authorId &&
        binding.sessionId === core.store.getRoomSession(origin.roomId!, row.authorId)
      );
    };
    // Refusal is positive current routing loss; unknown SQL errors propagate for existing maintenance retry.
    if (!core.store.handoffOutbox.withRead(allowed)) {
      core.store.handoffOutbox.skipNotice(
        id,
        'The original room cannot receive this handoff notice.'
      );
      logger.warn('[rooms] hand-off notice skipped: its original room seat changed', {
        handoffId: id,
        roomId: origin.roomId,
      });
      continue;
    }
    postOriginalNotice(
      origin.roomId,
      noticeId,
      body,
      (tx) => {
        if (!allowed(tx)) throw new Error('Original handoff notice scope changed before append.');
      },
      (tx, seq) => core.store.handoffOutbox.acceptRoomNotice(tx, id, row.authorId, noticeId, seq)
    );
  }
}
