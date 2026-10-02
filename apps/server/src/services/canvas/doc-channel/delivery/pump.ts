/** Durable document scheduling uses the existing protected queue and no runtime slot. */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  canvasDocBatches,
  canvasDocDeliveries,
  sessionMessageAcceptanceReceipts,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  CanvasChannelRouteSchema,
  type CanvasChannelRoute,
} from '@dorkos/shared/canvas-channel-schemas';
import { requireSynchronous } from '../../../session/private-messages/synchronous-source.js';
import { DocChannelStore, type DocBatchRow } from '../store.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocGrantActor } from '../grant-policy.js';
import { appendDocStatus } from '../status.js';
import { DocBatchAdmission } from './batch-admission.js';
import { replayExpiredDocBatch } from './replay.js';
import { consumeAcceptedDocWakes, type DocRecoveryCursor, type DocRecoveryPage } from './resume.js';

import {
  DOC_WAIT_WARNING,
  inspectAcceptedDocWaitWarnings,
  type DocWarningCursor,
  type DocWarningPage,
} from './warnings.js';

/** A gate observes current capacity without acquiring a runtime slot. */
export type DocPumpGate =
  | { available: true }
  | {
      available: false;
      reason: string;
      nextEligibleAt: string;
    };
/** Composition supplies real platform budgets and target capacity; there are no permissive defaults. */
export interface DocBatchPumpOptions {
  db: Db;
  store: DocChannelStore;
  grants: DocChannelGrants;
  admission: DocBatchAdmission;
  now: () => Date;
  /** Atomic durable once-only marker sharing this exact SQLite transaction. */
  markWaitingWarning(batchId: string, generation: string, now: string, tx: DbTransaction): boolean;
  capacity(batch: Readonly<DocBatchRow>, tx: DbTransaction): DocPumpGate;
  budget(batch: Readonly<DocBatchRow>, tx: DbTransaction): DocPumpGate;
  /** Notify the existing dispatcher only after committed acceptance; never dispatch inside SQLite. */
  nudge(sessionId: string, receiptIds: readonly string[]): undefined;
  observe?(event: DocPumpObservation): undefined;
}
/** Observations contain durable correlation and outcomes, never page payloads. */
export interface DocPumpObservation {
  batchId: string;
  documentId: string;
  routeId: string;
  outcome: 'routed' | 'waiting' | 'expired' | 'cancelled' | 'warning' | 'rejected' | 'replayed';
  reason?: string;
  nextEligibleAt?: string;
}
export interface DocPumpResult {
  admitted: number;
  waiting: number;
  expired: number;
  cancelled: number;
  nextEligibleAt: string | null;
}
const HOUR = 3600_000;
const WARNING = 15 * 60_000;
const EXPIRY = 24 * HOUR;
const LEASE = 30_000;
const RETRY = 60_000;
const ACTIVE = ['accepted', 'dispatching', 'turn_started', 'in_doubt'] as const;

/** Pump bounded oldest eligible work, persisting every wait instead of spinning. */
export class DocBatchDeliveryPump {
  constructor(private readonly options: DocBatchPumpOptions) {}
  /** One bounded pass; the host schedules the returned durable next wake time. */
  run(limit = 100): DocPumpResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid document pump limit.');
    const now = this.options.now().toISOString();
    const result: DocPumpResult = {
      admitted: 0,
      waiting: 0,
      expired: 0,
      cancelled: 0,
      nextEligibleAt: null,
    };
    const candidates = this.options.db
      .select()
      .from(canvasDocBatches)
      .where(
        and(
          inArray(canvasDocBatches.status, ['pending', 'waiting']),
          lte(canvasDocBatches.dueAt, now),
          or(isNull(canvasDocBatches.leaseUntil), lte(canvasDocBatches.leaseUntil, now))
        )
      )
      .orderBy(asc(canvasDocBatches.dueAt), asc(canvasDocBatches.batchId))
      .limit(limit)
      .all();
    for (const candidate of candidates) {
      const leased = this.options.store.acquireLease({
        batchId: candidate.batchId,
        generation: candidate.generation,
        status: candidate.status,
        now,
        leaseUntil: new Date(Date.parse(now) + LEASE).toISOString(),
      });
      if (!leased) continue;
      let notification: { sessionId: string; receiptId: string } | undefined;
      const observations: DocPumpObservation[] = [];
      const before = { ...result };
      try {
        // Expiry reduces authority even when the grant has independently expired or been revoked.
        const expired = this.options.store.transaction((tx) => {
          const batch = this.options.store.getBatch(leased.batchId, tx);
          if (
            !batch ||
            batch.generation !== leased.generation ||
            batch.attempt !== leased.attempt ||
            batch.leaseUntil !== leased.leaseUntil ||
            !['pending', 'waiting'].includes(batch.status)
          )
            return false;
          const parsed = CanvasChannelRouteSchema.safeParse(
            this.options.store.getGrant(batch.grantId, tx)?.normalizedRoute
          );
          const route = parsed.success ? parsed.data : undefined;
          const firstAt =
            Date.parse(batch.dueAt) - (route?.turn.mode === 'coalesce' ? route.turn.windowMs : 0);
          if (Date.parse(now) - firstAt < EXPIRY) return false;
          this.finish(tx, batch, 'expired', 'manual_replay_required', now);
          return true;
        });
        if (expired) {
          result.expired++;
          observations.push(this.event(leased, 'expired', 'manual_replay_required'));
          for (const observation of observations)
            this.notify(() => this.options.observe?.(observation));
          continue;
        }
        // A newly observed manifest change permanently suspends authority before admission.
        this.options.admission.source.refresh({
          kind: 'document_event_batch',
          batchId: leased.batchId,
          sourceGeneration: leased.generation,
        });
        this.options.store.transaction((tx) => {
          const batch = this.options.store.getBatch(leased.batchId, tx);
          if (
            !batch ||
            batch.generation !== leased.generation ||
            batch.attempt !== leased.attempt ||
            batch.leaseUntil !== leased.leaseUntil ||
            !['pending', 'waiting'].includes(batch.status)
          )
            return;
          const { grant } = this.options.grants.revalidateBatchGrant(batch, tx);
          const route = grant.normalizedRoute as CanvasChannelRoute;
          const firstAt =
            Date.parse(batch.dueAt) - (route.turn.mode === 'coalesce' ? route.turn.windowMs : 0);
          const active = tx
            .select()
            .from(canvasDocBatches)
            .where(
              and(
                eq(canvasDocBatches.documentId, batch.documentId),
                eq(canvasDocBatches.routeId, batch.routeId),
                inArray(canvasDocBatches.status, [...ACTIVE])
              )
            )
            .get();
          const gate = active
            ? this.waitGate(now, 'active_batch')
            : (this.routeCeiling(
                tx,
                batch,
                now,
                Math.min(10, (grant.limits as { turnsPerHour: number }).turnsPerHour)
              ) ?? this.gates(tx, batch));
          if (!gate.available) {
            const requested = validateGate(gate, now).nextEligibleAt;
            const warningAt = firstAt + WARNING;
            const boundary = warningAt > Date.parse(now) ? warningAt : firstAt + EXPIRY;
            const next = new Date(Math.min(Date.parse(requested), boundary)).toISOString();
            this.finish(tx, batch, 'waiting', gate.reason, now, next);
            result.waiting++;
            observations.push(this.event(batch, 'waiting', gate.reason, next));
            if (
              Date.parse(now) - firstAt >= WARNING &&
              checkedMarker(
                requireSynchronous(
                  this.options.markWaitingWarning(batch.batchId, batch.generation, now, tx)
                )
              )
            ) {
              appendDocStatus(
                this.options.store,
                tx,
                batch.documentId,
                {
                  batchId: batch.batchId,
                  routeId: batch.routeId,
                  status: 'waiting',
                  reason: gate.reason,
                  nextEligibleAt: next,
                  warning: DOC_WAIT_WARNING,
                },
                now
              );
              observations.push(this.event(batch, 'warning', gate.reason, next));
            }
            return;
          }
          // Final source authority, immutable slice and shared receipt are in this same transaction.
          const accepted = this.options.admission.admitPrepared(batch.batchId, batch.generation);
          tx.update(canvasDocBatches)
            .set({ leaseUntil: null, errorCode: null })
            .where(eq(canvasDocBatches.batchId, batch.batchId))
            .run();
          notification = { sessionId: accepted.receipt.sessionId, receiptId: accepted.receipt.id };
          result.admitted++;
          observations.push(this.event(batch, 'routed'));
        });
      } catch (error) {
        Object.assign(result, before);
        observations.length = 0;
        notification = undefined;
        // Refresh raced manifest authority outside the rolled-back movement/admission transaction.
        try {
          this.options.admission.source.refresh({
            kind: 'document_event_batch',
            batchId: leased.batchId,
            sourceGeneration: leased.generation,
          });
        } catch {
          /* Refusal is classified below. */
        }
        const refusal = this.options.admission.source.isPreclaimRefusal(error);
        this.options.store.transaction((tx) => {
          const batch = this.options.store.getBatch(leased.batchId, tx);
          if (
            !batch ||
            batch.generation !== leased.generation ||
            batch.attempt !== leased.attempt ||
            !['pending', 'waiting'].includes(batch.status)
          )
            return;
          if (refusal) {
            this.finish(tx, batch, 'cancelled', 'authority_refused', now);
            result.cancelled++;
            observations.push(this.event(batch, 'cancelled', 'authority_refused'));
          } else {
            const next = this.waitGate(now, 'pump_refused').nextEligibleAt;
            this.finish(tx, batch, 'waiting', 'pump_refused', now, next);
            result.waiting++;
            observations.push(this.event(batch, 'rejected', 'pump_refused', next));
          }
        });
      }
      // Observers cannot roll back acceptance or cause duplicate admission.
      if (notification)
        this.notify(() => this.options.nudge(notification!.sessionId, [notification!.receiptId]));
      for (const observation of observations)
        this.notify(() => this.options.observe?.(observation));
    }
    const pending = this.options.db
      .select({
        next: sql<
          string | null
        >`min(CASE WHEN ${canvasDocBatches.leaseUntil} > ${canvasDocBatches.dueAt}
          THEN ${canvasDocBatches.leaseUntil} ELSE ${canvasDocBatches.dueAt} END)`,
      })
      .from(canvasDocBatches)
      .where(
        or(
          inArray(canvasDocBatches.status, ['pending', 'waiting']),
          eq(canvasDocBatches.status, 'accepted')
        )
      )
      .get();
    result.nextEligibleAt = pending?.next ?? null;
    return result;
  }
  /** Explicit replay requires authenticated ownership; it never resumes claimed or started work. */
  replayExpired(batchId: string, grantId: string, actor: DocGrantActor): string {
    const nextId = replayExpiredDocBatch(
      this.options.store,
      this.options.grants,
      batchId,
      grantId,
      actor,
      this.options.now().toISOString()
    );
    const batch = this.options.store.getBatch(nextId)!;
    this.notify(() => this.options.observe?.(this.event(batch, 'replayed')));
    return nextId;
  }
  /** Boot recovery must finish first; only unclaimed receipts may resume through the existing pump. */
  async resumeAccepted(): Promise<number> {
    return (await this.resumeAcceptedPage()).notifications.size;
  }
  /** Recover one bounded page; the runner retains keysets and can stop notifications after shutdown. */
  async resumeAcceptedPage(
    cursor?: DocRecoveryCursor,
    integrityCursor?: DocRecoveryCursor,
    shouldNotify: () => boolean = () => true,
    warningCursor?: DocWarningCursor
  ): Promise<DocRecoveryPage> {
    const warnings: DocWarningPage = await this.inspectAcceptedWaitWarnings(
      warningCursor,
      100,
      shouldNotify
    ).catch(() => ({
      warned: 0,
      selected: 0,
      hasMore: false,
      retryableFailures: 1,
      nextEligibleAt: new Date(this.options.now().getTime() + RETRY).toISOString(),
    }));
    const page = await consumeAcceptedDocWakes(this.options, cursor, 100, integrityCursor);
    page.warningCursor = warnings.cursor;
    page.hasWarningMore = warnings.hasMore;
    page.retryableFailures += warnings.retryableFailures;
    if (
      warnings.nextEligibleAt &&
      (!page.nextEligibleAt || warnings.nextEligibleAt < page.nextEligibleAt)
    )
      page.nextEligibleAt = warnings.nextEligibleAt;
    for (const [session, receiptIds] of page.notifications) {
      if (!shouldNotify()) break;
      this.notify(() => this.options.nudge(session, receiptIds));
    }
    return page;
  }
  /** Inspect one warning-only page; this operation never nudges or admits a runtime turn. */
  inspectAcceptedWaitWarnings(
    cursor?: DocWarningCursor,
    limit = 100,
    shouldContinue: () => boolean = () => true
  ): Promise<DocWarningPage> {
    return inspectAcceptedDocWaitWarnings(this.options, cursor, limit, shouldContinue);
  }
  private gates(tx: DbTransaction, batch: DocBatchRow): DocPumpGate {
    const snapshot = Object.freeze({
      ...batch,
      inputEventIds: Object.freeze([...batch.inputEventIds]),
    });
    const budget = requireSynchronous(this.options.budget(snapshot as unknown as DocBatchRow, tx));
    validateGate(budget, this.options.now().toISOString());
    if (!budget.available) return budget;
    const capacity = requireSynchronous(
      this.options.capacity(snapshot as unknown as DocBatchRow, tx)
    );
    validateGate(capacity, this.options.now().toISOString());
    return capacity;
  }
  private routeCeiling(
    tx: DbTransaction,
    batch: DocBatchRow,
    now: string,
    ceiling: number
  ): DocPumpGate | undefined {
    if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 10)
      throw new Error('Invalid route ceiling.');
    const receipts = tx
      .select({ started: sessionMessageAcceptanceReceipts.turnStartedAt })
      .from(canvasDocBatches)
      .innerJoin(
        sessionMessageAcceptanceReceipts,
        eq(canvasDocBatches.admissionReceiptId, sessionMessageAcceptanceReceipts.id)
      )
      .where(
        and(
          eq(canvasDocBatches.documentId, batch.documentId),
          eq(canvasDocBatches.routeId, batch.routeId),
          gt(
            sessionMessageAcceptanceReceipts.turnStartedAt,
            new Date(Date.parse(now) - HOUR).toISOString()
          )
        )
      )
      .orderBy(desc(sessionMessageAcceptanceReceipts.turnStartedAt))
      .limit(10)
      .all();
    if (receipts.length < ceiling) return undefined;
    return {
      available: false,
      reason: 'route_turn_ceiling',
      nextEligibleAt: new Date(Date.parse(receipts[ceiling - 1]!.started!) + HOUR).toISOString(),
    };
  }
  private waitGate(now: string, reason: string): Extract<DocPumpGate, { available: false }> {
    return {
      available: false,
      reason,
      nextEligibleAt: new Date(Date.parse(now) + RETRY).toISOString(),
    };
  }
  private finish(
    tx: DbTransaction,
    batch: DocBatchRow,
    status: 'waiting' | 'expired' | 'cancelled',
    reason: string,
    now: string,
    nextEligibleAt?: string
  ): void {
    tx.update(canvasDocBatches)
      .set({ status, errorCode: reason, leaseUntil: nextEligibleAt ?? null, updatedAt: now })
      .where(
        and(
          eq(canvasDocBatches.batchId, batch.batchId),
          eq(canvasDocBatches.generation, batch.generation),
          eq(canvasDocBatches.attempt, batch.attempt)
        )
      )
      .run();
    tx.update(canvasDocDeliveries)
      .set({ status, reason, updatedAt: now })
      .where(
        and(
          eq(canvasDocDeliveries.batchId, batch.batchId),
          inArray(canvasDocDeliveries.eventId, batch.inputEventIds)
        )
      )
      .run();
    if (this.options.store.getChannel(batch.documentId, tx)?.closedAt === null)
      appendDocStatus(
        this.options.store,
        tx,
        batch.documentId,
        {
          batchId: batch.batchId,
          routeId: batch.routeId,
          status,
          reason,
          ...(nextEligibleAt ? { nextEligibleAt } : {}),
          ...(status === 'expired' ? { replayAvailable: true } : {}),
        },
        now
      );
  }
  private event(
    batch: DocBatchRow,
    outcome: DocPumpObservation['outcome'],
    reason?: string,
    nextEligibleAt?: string
  ): DocPumpObservation {
    return {
      batchId: batch.batchId,
      documentId: batch.documentId,
      routeId: batch.routeId,
      outcome,
      ...(reason ? { reason } : {}),
      ...(nextEligibleAt ? { nextEligibleAt } : {}),
    };
  }
  private notify(work: () => undefined): void {
    try {
      requireSynchronous(work());
    } catch {
      /* Committed work remains eligible for the existing dispatcher. */
    }
  }
}
function validateGate(gate: DocPumpGate, now: string): Extract<DocPumpGate, { available: false }> {
  if (!gate || typeof gate !== 'object' || typeof gate.available !== 'boolean')
    throw new Error('Invalid document scheduling gate.');
  if (gate.available) return { available: false, reason: '', nextEligibleAt: now };
  if (
    typeof gate.reason !== 'string' ||
    !/^[a-z][a-z0-9_]{0,99}$/.test(gate.reason) ||
    typeof gate.nextEligibleAt !== 'string' ||
    !Number.isFinite(Date.parse(gate.nextEligibleAt)) ||
    new Date(gate.nextEligibleAt).toISOString() !== gate.nextEligibleAt ||
    gate.nextEligibleAt <= now
  )
    throw new Error('Invalid document scheduling wait.');
  return gate;
}

function checkedMarker(result: boolean): boolean {
  if (typeof result !== 'boolean') throw new Error('Invalid document warning marker.');
  return result;
}
