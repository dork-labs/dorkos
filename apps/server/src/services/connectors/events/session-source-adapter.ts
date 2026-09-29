/** Fixed event source for the shared durable private-session acceptance path. */
import { createHash, randomUUID } from 'node:crypto';
import {
  and,
  eq,
  connectorEventInbox,
  connectorEventReceipts,
  sessionMessageAcceptanceReceipts,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import { stableStringify } from '@dorkos/shared/capabilities';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import { readConnectorEventSessionOrigin } from './session-target.js';
import { keepChatSession, readChatSession } from './subscription-delivery.js';
import type { ConnectorEventProtectionPort } from './ingress-service.js';
import type { ManagedEventConsentAuthority } from './grant-port.js';
import type { ActiveEventSubscription, ConnectorSubscriptionStore } from './subscription-store.js';
import {
  PrivateSessionMessageRefusalError,
  type PrivateSessionMessageSourceAdapter,
  type PrivateSessionMessageSourceRef,
  type PreparedPrivateSessionMessage,
  type PrivateSessionMessageAcceptanceService,
} from '../../session/private-messages/acceptance.js';

type EventRef = Extract<PrivateSessionMessageSourceRef, { kind: 'connector_event' }>;
type InboxRow = typeof connectorEventInbox.$inferSelect;

/** Server-resolved origin; no public request may supply these routing fields. */
export interface ConnectorEventSessionOrigin {
  agentId: string;
  runtime: string;
  agentPath: string;
  authorityDigest: string;
}

/** Composition-root port for current agent identity and local-only session metadata. */
export interface ConnectorEventSessionTargetPort {
  resolve(
    owner: ConnectorOwnerAuthority,
    agentId: string
  ): Promise<ConnectorEventSessionOrigin | undefined>;
  /** Persist only the fresh local UUID/runtime binding, never invoke a runtime or send content. */
  bind(sessionId: string, origin: ConnectorEventSessionOrigin): Promise<void>;
  /** Synchronous current identity and exact persisted session binding check. */
  current(
    owner: ConnectorOwnerAuthority,
    sessionId: string,
    origin: ConnectorEventSessionOrigin
  ): boolean;
  /**
   * Whether a notification's kept chat still holds the mode a connector event
   * is seeded with (none stored). False once the owner set a mode on it.
   */
  holdsSeedMode(sessionId: string): boolean;
}

type PreparedTarget = {
  ref: EventRef;
  bootEpoch: string;
  expiresAt: string;
  sessionId: string;
  origin: ConnectorEventSessionOrigin;
  scopeDigest: string;
};

/** Event adapter never owns a queue: it consumes the leased inbox in the caller's transaction. */
export class ConnectorEventSessionSourceAdapter implements PrivateSessionMessageSourceAdapter<EventRef> {
  readonly kind = 'connector_event' as const;
  private readonly targets = new Map<string, PreparedTarget>();
  private readonly preparing = new Map<string, Promise<EventRef>>();
  private readonly prepared = new WeakMap<
    PreparedPrivateSessionMessage,
    { receiptId: string; payloadDigest: string; contentDigest: string }
  >();

  constructor(
    private readonly subscriptions: ConnectorSubscriptionStore,
    private readonly protection: ConnectorEventProtectionPort,
    private readonly managed: ManagedEventConsentAuthority,
    private readonly target: ConnectorEventSessionTargetPort,
    private readonly bootEpoch: string,
    private readonly now = () => new Date().toISOString()
  ) {}

  /** Prepare local-only routing once per current worker claim, without revealing event content. */
  prepareTarget(ref: EventRef): Promise<EventRef> {
    this.sweepPreparations(this.now());
    const key = this.key(ref);
    const inFlight = this.preparing.get(key);
    if (inFlight) return inFlight;
    const operation = this.prepareTargetOnce(ref).finally(() => this.preparing.delete(key));
    this.preparing.set(key, operation);
    return operation;
  }

  /** Accept through the one shared coordinator and release preparation only after commit. */
  acceptPrepared(service: PrivateSessionMessageAcceptanceService, ref: EventRef) {
    const accepted = service.accept(ref);
    this.targets.delete(this.key(ref));
    return accepted;
  }

  /** Drop expired preparation data during existing maintenance; it never authorizes recovery. */
  sweepPreparations(now: string): void {
    for (const [key, prepared] of this.targets)
      if (prepared.expiresAt <= now) this.targets.delete(key);
  }

  /** Consume the current boot/lease claim atomically with the receipt and safe queue placeholder. */
  consume(tx: DbTransaction, ref: EventRef, now: string) {
    const row = this.row(ref.inboxId);
    const scope = this.claimScope(row, ref, now);
    const target = this.targets.get(this.key(ref));
    if (
      !target ||
      target.bootEpoch !== this.bootEpoch ||
      target.expiresAt <= now ||
      target.scopeDigest !== this.scopeDigest(scope, target.origin) ||
      !this.target.current(this.subscriptions.owner(scope), target.sessionId, target.origin) ||
      // Re-checked at the claim: a mode the owner set since preparation sends
      // this event back to be retried, and the retry opens a fresh chat.
      !this.target.holdsSeedMode(target.sessionId)
    )
      this.refuse('event_target_changed');
    const changed = tx
      .update(connectorEventInbox)
      .set({ state: 'dispatched', dispatchedAt: now })
      .where(eq(connectorEventInbox.id, row.id))
      .run().changes;
    if (changed !== 1) this.refuse('event_claim_changed');
    tx.insert(connectorEventReceipts)
      .values({
        id: randomUUID(),
        inboxId: row.id,
        subscriptionId: row.subscriptionId,
        providerEventId: row.providerEventId,
        state: 'accepted',
        recordedAt: now,
        destinationReceiptId: target.sessionId,
      })
      .run();
    // Do not delete the transient target here: a queue/receipt insert failure rolls
    // this transaction back and the same claim must remain safely retryable.
    return {
      sourceKind: this.kind,
      sourceId: row.id,
      sourceGeneration: ref.sourceGeneration,
      sessionId: target.sessionId,
      agentId: target.origin.agentId,
      originRuntime: target.origin.runtime,
      originAgentPath: target.origin.agentPath,
      originAuthorityDigest: target.scopeDigest,
      queuePlaceholder: '[Private service notification]',
    };
  }

  /** Reveal protected content in memory from the exact receipt source, never from a queue row. */
  async prepare(receipt: SessionMessageAcceptanceReceipt): Promise<PreparedPrivateSessionMessage> {
    const row = this.row(receipt.sourceId);
    const scope = this.receiptScope(row, receipt, this.now());
    const protector = await this.protection.resolve(row.providerInstanceId);
    if (!protector || row.payloadProtection !== 'encrypted')
      this.refuse('event_content_unavailable');
    const content = protector.reveal(row.normalizedPayload, row, Date.parse(this.now()));
    const prepared = {
      sourceKind: this.kind,
      sourceId: row.id,
      sourceGeneration: receipt.sourceGeneration,
      // Every event lands in the same chat, so each one says which notification
      // it came from rather than a generic label.
      content: `${scope.definition.displayName}: ${content.title}\n\n${content.text}`,
    };
    this.prepared.set(prepared, {
      receiptId: receipt.id,
      payloadDigest: this.digest(row.normalizedPayload),
      contentDigest: this.digest(prepared.content),
    });
    return prepared;
  }

  /** Recheck current subscription, managed ACK, origin and protected bytes in the final dispatch CAS. */
  revalidate(
    _tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    prepared: PreparedPrivateSessionMessage,
    now: string
  ): void {
    const row = this.row(receipt.sourceId);
    this.receiptScope(row, receipt, now);
    const proof = this.prepared.get(prepared);
    if (
      !proof ||
      proof.receiptId !== receipt.id ||
      proof.payloadDigest !== this.digest(row.normalizedPayload) ||
      proof.contentDigest !== this.digest(prepared.content)
    )
      this.refuse('event_content_changed');
  }

  /** A real turn-start receipt allows early source payload deletion. */
  onTurnStarted(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    seq: number,
    now: string
  ): void {
    this.finish(tx, receipt, now, 'completed', `turn:${receipt.sessionId}:${seq}`);
  }

  /** Cancellation occurred before runtime effects, so it can terminally purge source content. */
  onCancelled(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    _reason: string,
    now: string
  ): void {
    this.finish(tx, receipt, now, 'failed', undefined, 'dispatch_cancelled');
  }

  /** Unknown effects remain quarantined, preserving protected content only to its original expiry. */
  onOutcomeUnknown(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    _reason: string,
    now: string
  ): void {
    const row = this.row(receipt.sourceId);
    // A turn that was already observed remains a truthful delivered receipt.
    if (row.state === 'completed') return;
    tx.update(connectorEventInbox)
      .set({
        state: 'failed',
        failureCode: 'dispatch_outcome_unknown',
        leaseOwner: null,
        leasedUntil: null,
      })
      .where(eq(connectorEventInbox.id, row.id))
      .run();
    tx.insert(connectorEventReceipts)
      .values({
        id: randomUUID(),
        inboxId: row.id,
        subscriptionId: row.subscriptionId,
        providerEventId: row.providerEventId,
        state: 'outcome_unknown',
        failureCode: 'dispatch_outcome_unknown',
        recordedAt: now,
      })
      .run();
  }

  private async prepareTargetOnce(ref: EventRef): Promise<EventRef> {
    // The whole source key, so the lookup is the unique index's; by source_id alone it read
    // every receipt ever written, once per connector event.
    const existing = this.subscriptions.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(
        and(
          eq(sessionMessageAcceptanceReceipts.sourceKind, this.kind),
          eq(sessionMessageAcceptanceReceipts.sourceId, ref.inboxId),
          eq(sessionMessageAcceptanceReceipts.sourceGeneration, ref.sourceGeneration)
        )
      )
      .get();
    if (existing) return ref; // Recovery must use this receipt's origin; never mint a replacement target.
    const row = this.row(ref.inboxId);
    const scope = this.claimScope(row, ref, this.now());
    const prior = this.targets.get(this.key(ref));
    if (
      prior &&
      prior.expiresAt > this.now() &&
      prior.scopeDigest === this.scopeDigest(scope, prior.origin) &&
      this.target.current(this.subscriptions.owner(scope), prior.sessionId, prior.origin) &&
      this.target.holdsSeedMode(prior.sessionId)
    )
      return ref;
    const owner = this.subscriptions.owner(scope);
    const origin = await this.target.resolve(owner, scope.agentId);
    if (!origin || origin.agentId !== scope.agentId) this.refuse('event_target_unavailable');
    // One chat per notification: every event joins the chat the last one went
    // to. A new chat is opened for the first event, when the agent's runtime or
    // folder has moved since (a chat's runtime binding never changes), and when
    // the owner has set a mode on the kept chat. That last one is authority, not
    // tidiness: an event runs under the notification the owner approved, which
    // seeds no mode, and a turn in a chat runs at that chat's stored mode. So
    // an event may only join a chat that still holds the seed, never one whose
    // mode the owner raised for their own turns.
    const kept = readChatSession(this.subscriptions.db, scope.subscriptionId);
    const reuse =
      kept !== undefined &&
      this.target.current(owner, kept, origin) &&
      this.target.holdsSeedMode(kept);
    const sessionId = reuse ? kept : randomUUID();
    if (!reuse) await this.target.bind(sessionId, origin);
    const current = this.claimScope(this.row(ref.inboxId), ref, this.now());
    if (
      stableStringify(current) !== stableStringify(scope) ||
      !this.target.current(owner, sessionId, origin)
    )
      this.refuse('event_target_changed');
    if (!reuse) keepChatSession(this.subscriptions.db, scope.subscriptionId, sessionId);
    this.targets.set(this.key(ref), {
      ref,
      sessionId,
      origin,
      bootEpoch: this.bootEpoch,
      expiresAt: new Date(
        Math.min(Date.parse(row.leasedUntil!), Date.parse(this.now()) + 30_000)
      ).toISOString(),
      scopeDigest: this.scopeDigest(scope, origin),
    });
    return ref;
  }

  private claimScope(row: InboxRow, ref: EventRef, now: string): ActiveEventSubscription {
    if (
      row.state !== 'leased' ||
      row.leaseOwner !== ref.leaseOwner ||
      row.leaseBootEpoch !== this.bootEpoch ||
      !row.leasedUntil ||
      row.leasedUntil <= now ||
      row.expiresAt <= now ||
      String(row.subscriptionVersion) !== ref.sourceGeneration
    )
      this.refuse('event_claim_changed');
    return this.currentScope(row);
  }

  private receiptScope(
    row: InboxRow,
    receipt: SessionMessageAcceptanceReceipt,
    now: string
  ): ActiveEventSubscription {
    if (
      receipt.sourceKind !== this.kind ||
      row.state !== 'dispatched' ||
      row.expiresAt <= now ||
      !row.normalizedPayload ||
      String(row.subscriptionVersion) !== receipt.sourceGeneration
    )
      this.refuse('event_source_unavailable');
    const scope = this.currentScope(row);
    const origin = this.targetOrigin(scope, receipt);
    if (
      this.scopeDigest(scope, origin) !== receipt.originAuthorityDigest ||
      !this.target.current(this.subscriptions.owner(scope), receipt.sessionId, origin) ||
      // Last check before the runtime runs: a mode set after acceptance
      // cancels this event rather than run it at the owner's raised mode.
      !this.target.holdsSeedMode(receipt.sessionId)
    )
      this.refuse('event_target_changed');
    return scope;
  }

  private targetOrigin(
    scope: ActiveEventSubscription,
    receipt: SessionMessageAcceptanceReceipt
  ): ConnectorEventSessionOrigin {
    // The agent snapshot digest is derived from the persisted current agent row;
    // it never comes from the in-memory preparation map after acceptance.
    const origin = readConnectorEventSessionOrigin(this.subscriptions.db, scope.agentId);
    if (
      !origin ||
      origin.agentId !== receipt.agentId ||
      origin.runtime !== receipt.originRuntime ||
      origin.agentPath !== receipt.originAgentPath
    )
      this.refuse('event_target_changed');
    return origin;
  }

  private currentScope(row: InboxRow): ActiveEventSubscription {
    const scope = this.subscriptions.active(row.subscriptionId, row.subscriptionVersion);
    if (
      !scope ||
      scope.providerInstanceId !== row.providerInstanceId ||
      scope.destinationKind !== 'agent' ||
      scope.destinationId !== scope.agentId ||
      (scope.mode === 'managed' &&
        !this.managed.ready(scope.subscriptionId, scope.subscriptionVersion))
    )
      this.refuse('event_authority_changed');
    return scope;
  }

  private row(id: string): InboxRow {
    const row = this.subscriptions.db
      .select()
      .from(connectorEventInbox)
      .where(eq(connectorEventInbox.id, id))
      .get();
    if (!row) this.refuse('event_source_unavailable');
    return row;
  }

  private finish(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    now: string,
    state: 'completed' | 'failed',
    destinationReceiptId?: string,
    failureCode?: string
  ): void {
    const row = this.row(receipt.sourceId);
    tx.update(connectorEventInbox)
      .set({
        state,
        normalizedPayload: '',
        completedAt: now,
        leaseOwner: null,
        leasedUntil: null,
        failureCode: failureCode ?? null,
      })
      .where(eq(connectorEventInbox.id, row.id))
      .run();
    tx.insert(connectorEventReceipts)
      .values({
        id: randomUUID(),
        inboxId: row.id,
        subscriptionId: row.subscriptionId,
        providerEventId: row.providerEventId,
        state,
        destinationReceiptId,
        failureCode,
        recordedAt: now,
      })
      .run();
  }

  private key(ref: EventRef): string {
    return JSON.stringify([ref.inboxId, ref.sourceGeneration, ref.leaseOwner, this.bootEpoch]);
  }
  private scopeDigest(scope: ActiveEventSubscription, origin: ConnectorEventSessionOrigin): string {
    return this.digest(stableStringify({ scope, origin }));
  }
  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
  private refuse(code: string): never {
    throw new PrivateSessionMessageRefusalError(
      code,
      'The service notification is no longer available.'
    );
  }
}
