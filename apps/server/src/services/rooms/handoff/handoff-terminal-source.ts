/** Closed public handoff terminal notices registered with the existing private coordinator. */
import { createHash } from 'node:crypto';
import {
  and,
  eq,
  agents,
  authors,
  sessionMetadata,
  roomSessions,
  roomEntries,
  roomHandoffOutbox,
  type Db,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import { stableStringify } from '@dorkos/shared/capabilities';
import { defuseUntrustedPrompt } from '@dorkos/shared/untrusted-text';
import { isChatSendable } from '../../session/chat-messages/chat-target.js';
import {
  PrivateSessionMessageRefusalError,
  type PrivateSessionMessageSourceAdapter,
  type PrivateSessionMessageSourceRef,
  type PreparedPrivateSessionMessage,
} from '../../session/private-messages/acceptance.js';
import { decodeHandoffEnvelope, joinHandoffCurrentCarry } from './handoff-envelope.js';
import { captureAdmissionRecipient } from './outbox/admission-recipient.js';
import { HandoffOutboxStore, decodeSavedHandoffScope } from './outbox/handoff-outbox-store.js';
type Ref = Extract<PrivateSessionMessageSourceRef, { kind: 'room_handoff_terminal' }>;
type Read = Db | DbTransaction;
const digest = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex');
const refuse = (): never => {
  throw new PrivateSessionMessageRefusalError(
    'handoff_notice_unavailable',
    'This handoff update is no longer available.'
  );
};
const terminal = new Set(['posted', 'declined', 'interrupted', 'expired', 'quarantined']);
/** Only current authority for the ORIGINAL exact caller session is accepted; no DM/room fallback. */
export class HandoffTerminalSource implements PrivateSessionMessageSourceAdapter<Ref> {
  readonly kind = 'room_handoff_terminal' as const;
  constructor(
    private readonly db: Db,
    private readonly outbox: HandoffOutboxStore
  ) {}
  /** Server worker obtains this opaque reference; public endpoints never accept it. */
  reference(id: string): Ref {
    const scope = this.scope(this.db, id);
    return { kind: this.kind, handoffId: id, sourceGeneration: scope.generation };
  }
  private scope(exec: Read, id: string) {
    const row = exec.select().from(roomHandoffOutbox).where(eq(roomHandoffOutbox.id, id)).get();
    if (!row || !terminal.has(row.state)) return refuse();
    let envelope: ReturnType<typeof decodeHandoffEnvelope>;
    try {
      envelope = decodeSavedHandoffScope(row).envelope;
    } catch {
      return refuse();
    }
    if (
      envelope.source.id !== row.id ||
      envelope.seat.authorId !== row.authorId ||
      envelope.seat.roomId !== row.roomId ||
      envelope.enqueuedAt !== row.enqueuedAt ||
      envelope.waitDeadlineAt !== row.waitDeadlineAt
    )
      return refuse();
    if (row.state === 'posted') {
      if (!row.postedEntryId || row.postedSeq === null || !row.dispatchId) return refuse();
      const posted = exec
        .select()
        .from(roomEntries)
        .where(
          and(
            eq(roomEntries.roomId, row.roomId),
            eq(roomEntries.id, row.postedEntryId),
            eq(roomEntries.seq, row.postedSeq)
          )
        )
        .get();
      if (
        !posted ||
        posted.kind !== 'post' ||
        posted.authorId !== row.authorId ||
        posted.dispatchId !== row.dispatchId
      )
        return refuse();
    }
    const metadata = exec
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, envelope.source.callerSessionId))
      .get();
    const author = exec.select().from(authors).where(eq(authors.id, row.authorId)).get();
    const agent = exec
      .select()
      .from(agents)
      .where(eq(agents.projectPath, envelope.source.agentPath))
      .get();
    const seat = exec
      .select()
      .from(roomSessions)
      .where(eq(roomSessions.sessionId, envelope.source.callerSessionId))
      .get();
    if (
      !metadata?.runtime ||
      metadata.agentPath !== envelope.source.agentPath ||
      !author ||
      author.kind !== 'agent' ||
      author.naturalKey !== envelope.source.agentPath ||
      !agent ||
      agent.status !== 'active' ||
      agent.runtime !== metadata.runtime ||
      author.mintedForManifestId !== agent.id ||
      !isChatSendable({
        bound: true,
        roomBound: seat !== undefined,
        launchOrigin: metadata.launchOrigin,
      })
    )
      return refuse();
    const recipient = captureAdmissionRecipient(
      exec,
      envelope.source.callerSessionId,
      row.authorId,
      envelope.source.agentPath
    );
    if (!recipient || stableStringify(recipient) !== stableStringify(envelope.recipient))
      return refuse();
    const generation = digest({ envelopeJson: row.envelopeJson });
    // The immutable admission-time epoch/identity is the authority, not first notice acceptance.
    const authority = digest({ generation, recipient: envelope.recipient });
    return { row, envelope, metadata, agent, generation, authority };
  }
  consume(tx: DbTransaction, ref: Ref) {
    const scope = this.scope(tx, ref.handoffId);
    if (scope.row.noticeState !== 'ready' || ref.sourceGeneration !== scope.generation)
      return refuse();
    return {
      sourceKind: this.kind,
      sourceId: scope.row.id,
      sourceGeneration: scope.generation,
      sessionId: scope.envelope.source.callerSessionId,
      agentId: scope.agent.id,
      originRuntime: scope.metadata.runtime!,
      originAgentPath: scope.envelope.source.agentPath,
      originAuthorityDigest: scope.authority,
      queuePlaceholder: '[Room handoff update]',
    };
  }
  onAccepted(tx: DbTransaction, receipt: SessionMessageAcceptanceReceipt): undefined {
    const scope = this.receiptScope(tx, receipt, false);
    this.outbox.acceptTerminalNotice(tx, scope.row.id, scope.row.authorId, receipt.id);
    return undefined;
  }
  private receiptScope(exec: Read, receipt: SessionMessageAcceptanceReceipt, accepted = true) {
    const scope = this.scope(exec, receipt.sourceId);
    if (
      receipt.sourceKind !== this.kind ||
      receipt.sourceGeneration !== scope.generation ||
      receipt.sessionId !== scope.envelope.source.callerSessionId ||
      receipt.agentId !== scope.agent.id ||
      receipt.originRuntime !== scope.metadata.runtime ||
      receipt.originAgentPath !== scope.envelope.source.agentPath ||
      receipt.originAuthorityDigest !== scope.authority ||
      (accepted &&
        (scope.row.noticeState !== 'accepted' || scope.row.noticeReceiptId !== receipt.id))
    )
      return refuse();
    return scope;
  }
  private content(row: { state: string; noticeText: string | null }): string {
    if (row.noticeText !== null) return row.noticeText;
    const state = row.state;
    return state === 'posted'
      ? 'The room hand-off posted. Its hand-off status has details.'
      : 'The room hand-off ended without a post. Its hand-off status says why.';
  }
  async prepare(receipt: SessionMessageAcceptanceReceipt): Promise<PreparedPrivateSessionMessage> {
    const scope = this.receiptScope(this.db, receipt);
    return {
      sourceKind: this.kind,
      sourceId: scope.row.id,
      sourceGeneration: scope.generation,
      content: this.content(scope.row),
    };
  }
  revalidate(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    prepared: PreparedPrivateSessionMessage
  ) {
    const scope = this.receiptScope(tx, receipt);
    if (prepared.content !== this.content(scope.row)) return refuse();
    // Final private presentation only: preserve rich stored/prepared truth, but never
    // dispatch a name or decline excerpt as a native slash command or @file reference.
    const content = defuseUntrustedPrompt(`[Room handoff update]\n${prepared.content}`);
    return {
      content,
      roomHandoffCarry: joinHandoffCurrentCarry(scope.envelope, { externalAuthor: false }),
    };
  }
  isPreclaimRefusal(error: unknown): boolean {
    return (
      error instanceof PrivateSessionMessageRefusalError &&
      error.code === 'handoff_notice_unavailable'
    );
  }
  sender(): string {
    return 'room-handoff';
  }
}
