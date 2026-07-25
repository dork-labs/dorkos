/**
 * The approval primitive: ask, decide, spend (spec `agent-trust` §3.3).
 *
 * When an agent wants to do something a person should sign off on, it asks here.
 * The service records the request, hands back a one-time token, and announces the
 * pending approval on the global event stream so the cockpit can render a card.
 * The operator grants or denies; the agent retries with its token; the service
 * spends it once and never again.
 *
 * This is the one approval mechanism in DorkOS. The marketplace's confirmation
 * providers are thin wrappers over it (`services/marketplace-mcp/
 * confirmation-provider.ts`), and tier enforcement at the capability choke points
 * (spec §3.2) consumes the same tokens.
 *
 * ## Four properties make a token safe to hand an agent
 *
 * 1. **Hashed at rest.** Only the SHA-256 digest is stored, so a database read
 *    yields nothing presentable. The plaintext is returned exactly once, to the
 *    caller that asked, and is never logged or echoed in a later result.
 * 2. **Single use.** {@link ApprovalService.consume} stamps `consumedAt` on the
 *    row it honors; a replay of the same token reports `consumed`.
 * 3. **Bound to the action.** A token is scoped to `(capabilityId, inputHash)`.
 *    Consent to uninstall one package cannot be redirected at another, because
 *    the retry presents a different hash and the token stops matching.
 * 4. **Expiring, checked when spent.** Expiry is evaluated inside `consume`, not
 *    only by the periodic sweep, so a stale row can never be honored even if no
 *    cleanup has run.
 *
 * A pending token is inert: it only becomes spendable once a person grants it, so
 * handing it to the requester up front costs nothing and lets the agent resume
 * its own flow without the operator shuttling a secret around.
 *
 * ## Synchronous by design
 *
 * Every method is synchronous. The store is better-sqlite3, which is
 * synchronous anyway, and callers like the marketplace UI route decide a token
 * and immediately expect the next read to see it — an unawaited promise there
 * would be a race. Callers may still `await` these results harmlessly.
 *
 * @module services/core/approvals/approval-service
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulidx';
import { and, asc, eq, isNull, lt, approvals, type Db } from '@dorkos/db';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { broadcastApprovalPending, broadcastApprovalResolved } from './approval-events.js';

/** How long an operator has to decide before a token stops being honored. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Bytes of CSPRNG randomness behind an approval token (128 bits). */
const TOKEN_BYTES = 16;

/** What {@link ApprovalService.request} needs to describe a pending action. */
export interface ApprovalRequestInput {
  /** Capability the request would invoke, e.g. `marketplace.uninstall`. */
  capabilityId: string;
  /** Canonical hash of the invocation input (see `hashApprovalInput`). */
  inputHash: string;
  /** One plain sentence describing what the operator is about to allow. */
  summary: string;
  /**
   * Opaque label for who asked — an agent path, a display name, whatever the
   * caller has. Never interpreted here, only shown on the card.
   */
  requestedBy?: string;
  /** Human-facing capability title. Defaults to the capability id. */
  capabilityTitle?: string;
  /** Permission tier being requested. Defaults to `destructive`. */
  tier?: CapabilityTier;
}

/** What a requester gets back: an id to watch, and a token to retry with. */
export interface ApprovalTicket {
  /** ULID of the new approval. Safe to show a person or log. */
  approvalId: string;
  /**
   * The one-time token. This is the ONLY time it is available — it is not stored
   * in recoverable form and must never be logged or returned again.
   */
  token: string;
  /** When the token stops being honored. ISO 8601 UTC. */
  expiresAt: string;
}

/** The action a token must match to be spent. */
export interface ApprovalBinding {
  /** Capability the caller is about to invoke. */
  capabilityId: string;
  /** Canonical hash of the input the caller is about to invoke it with. */
  inputHash: string;
}

/**
 * The outcome of presenting a token, discriminated by `outcome`.
 *
 * - `granted` — the operator said yes and this call spent the token.
 * - `pending` — nobody has decided yet; present the token again later.
 * - `denied` — the operator said no; the token is spent either way.
 * - `expired` — the decision window closed; the token is written off.
 * - `consumed` — already spent (or written off) by an earlier call.
 * - `unknown` — no such token.
 * - `mismatched` — a real, live token for a DIFFERENT action. Deliberately not
 *   spent: the approval stays available for the action it was granted for.
 */
export type ApprovalConsumeResult =
  | { outcome: 'granted'; approvalId: string; capabilityId: string; requestedBy?: string }
  | { outcome: 'pending'; approvalId: string }
  | { outcome: 'denied'; approvalId: string; reason?: string }
  | { outcome: 'expired'; approvalId: string }
  | { outcome: 'consumed' }
  | { outcome: 'unknown' }
  | { outcome: 'mismatched'; approvalId: string };

/** Hash a token exactly as it is stored: SHA-256, lowercase hex. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A stored approval row, as Drizzle infers it. */
type ApprovalRow = typeof approvals.$inferSelect;

/** Project a stored row into the cockpit-facing shape. Never includes the hash. */
function toPendingApproval(row: ApprovalRow): PendingApproval {
  return {
    approvalId: row.id,
    capabilityId: row.capabilityId,
    capabilityTitle: row.capabilityTitle,
    tier: row.tier,
    summary: row.summary,
    ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Ask for, decide, and spend approvals. See the module TSDoc for the token
 * contract.
 */
export class ApprovalService {
  /**
   * Build the service over a database handle.
   *
   * @param db - The DorkOS database handle.
   * @param ttlMs - How long an operator has to decide. Defaults to
   *   {@link APPROVAL_TTL_MS}; overridable so tests need not sleep.
   */
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number = APPROVAL_TTL_MS
  ) {}

  /**
   * Record a request for approval and announce it to the cockpit.
   *
   * @param input - What is being asked, and who is asking.
   * @returns The approval id and the one-time token for the retry.
   */
  request(input: ApprovalRequestInput): ApprovalTicket {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    const row = {
      id: ulid(),
      tokenHash: hashToken(token),
      capabilityId: input.capabilityId,
      capabilityTitle: input.capabilityTitle ?? input.capabilityId,
      tier: input.tier ?? ('destructive' as const),
      inputHash: input.inputHash,
      summary: input.summary,
      requestedBy: input.requestedBy ?? null,
      state: 'pending' as const,
      denyReason: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      decidedAt: null,
      consumedAt: null,
    };
    this.db.insert(approvals).values(row).run();

    broadcastApprovalPending(toPendingApproval(row));

    return { approvalId: row.id, token, expiresAt: row.expiresAt };
  }

  /**
   * Record the operator's yes.
   *
   * @param approvalId - ULID of the approval to grant.
   * @returns Why the call failed, or `undefined` when the approval is now granted.
   */
  grant(approvalId: string): ApprovalDecisionFailure | undefined {
    return this.decide(approvalId, 'granted');
  }

  /**
   * Record the operator's no.
   *
   * @param approvalId - ULID of the approval to deny.
   * @param reason - Optional note the requester sees instead of a bare refusal.
   * @returns Why the call failed, or `undefined` when the approval is now denied.
   */
  deny(approvalId: string, reason?: string): ApprovalDecisionFailure | undefined {
    return this.decide(approvalId, 'denied', reason);
  }

  /**
   * Record a decision against whichever approval a token belongs to.
   *
   * The marketplace UI knows the token rather than the approval id (the agent
   * showed the person the token it received), so this is the seam that flow
   * decides through. Unknown tokens are reported, never thrown.
   *
   * @param token - The token the requester was handed.
   * @param decision - Yes or no.
   * @param reason - Optional note, meaningful for a denial.
   * @returns Why the call failed, or `undefined` when the decision was recorded.
   */
  decideByToken(
    token: string,
    decision: 'granted' | 'denied',
    reason?: string
  ): ApprovalDecisionFailure | undefined {
    const row = this.findByToken(token);
    if (!row) return 'unknown';
    return this.decide(row.id, decision, reason);
  }

  /**
   * Present a token for the action it was granted for.
   *
   * Expiry is checked here, so a stale row is written off rather than honored
   * even when no sweep has run. A token that resolves to a real approval for a
   * DIFFERENT action reports `mismatched` and is deliberately left unspent.
   *
   * @param token - The token the requester was handed.
   * @param binding - The capability and input hash the caller is about to run.
   * @returns What presenting the token achieved.
   */
  consume(token: string, binding: ApprovalBinding): ApprovalConsumeResult {
    const row = this.findByToken(token);
    if (!row) return { outcome: 'unknown' };
    if (row.consumedAt) return { outcome: 'consumed' };

    if (row.capabilityId !== binding.capabilityId || row.inputHash !== binding.inputHash) {
      return { outcome: 'mismatched', approvalId: row.id };
    }

    if (this.isExpired(row)) {
      this.markConsumed(row.id);
      broadcastApprovalResolved(row.id, 'expired');
      return { outcome: 'expired', approvalId: row.id };
    }

    if (row.state === 'pending') return { outcome: 'pending', approvalId: row.id };

    this.markConsumed(row.id);
    broadcastApprovalResolved(row.id, 'consumed');

    if (row.state === 'denied') {
      return {
        outcome: 'denied',
        approvalId: row.id,
        ...(row.denyReason ? { reason: row.denyReason } : {}),
      };
    }

    return {
      outcome: 'granted',
      approvalId: row.id,
      capabilityId: row.capabilityId,
      ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
    };
  }

  /**
   * Every approval still waiting on a person, oldest first. Expired rows are
   * excluded — a card nobody can act on any more is noise, not information.
   *
   * @returns The pending approvals, without token material.
   */
  listPending(): PendingApproval[] {
    const rows = this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.state, 'pending'), isNull(approvals.consumedAt)))
      .orderBy(asc(approvals.createdAt))
      .all();
    return rows.filter((row) => !this.isExpired(row)).map(toPendingApproval);
  }

  /**
   * Delete approval rows whose window closed before `olderThan`.
   *
   * Retention is deliberately longer than the decision window so a spent or
   * expired approval stays auditable for a while after it stops working; expiry
   * itself is enforced in {@link consume}, never by this sweep.
   *
   * @param olderThan - Cutoff; rows that expired before this are deleted.
   *   Defaults to one day ago.
   * @returns How many rows were deleted.
   */
  purgeExpired(olderThan: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): number {
    const result = this.db
      .delete(approvals)
      .where(lt(approvals.expiresAt, olderThan.toISOString()))
      .run();
    return result.changes;
  }

  /**
   * Look a token up by its digest, in constant time on the final compare.
   *
   * @param token - The presented token.
   * @returns The stored row, or `undefined`.
   */
  private findByToken(token: string): ApprovalRow | undefined {
    if (!token) return undefined;

    const digest = hashToken(token);
    const row = this.db.select().from(approvals).where(eq(approvals.tokenHash, digest)).get();
    if (!row) return undefined;

    // The index lookup already matched on equality; this constant-time compare is
    // the belt-and-braces guard so no timing signal rides on the comparison.
    const presented = Buffer.from(digest, 'hex');
    const stored = Buffer.from(row.tokenHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return undefined;
    }
    return row;
  }

  /** Whether a row's decision window has closed. Strict, so the boundary is live. */
  private isExpired(row: ApprovalRow): boolean {
    return Date.now() > new Date(row.expiresAt).getTime();
  }

  /** Stamp a row as spent, which is what makes a token single-use. */
  private markConsumed(approvalId: string): void {
    this.db
      .update(approvals)
      .set({ consumedAt: new Date().toISOString() })
      .where(eq(approvals.id, approvalId))
      .run();
  }

  /**
   * Record a decision on a pending, unexpired approval.
   *
   * @param approvalId - ULID of the approval.
   * @param decision - Yes or no.
   * @param reason - Optional note for a denial.
   * @returns Why the call failed, or `undefined` on success.
   */
  private decide(
    approvalId: string,
    decision: 'granted' | 'denied',
    reason?: string
  ): ApprovalDecisionFailure | undefined {
    const row = this.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!row) return 'unknown';
    if (row.consumedAt || row.state !== 'pending') return 'not_pending';
    if (this.isExpired(row)) {
      this.markConsumed(row.id);
      broadcastApprovalResolved(row.id, 'expired');
      return 'expired';
    }

    this.db
      .update(approvals)
      .set({
        state: decision,
        decidedAt: new Date().toISOString(),
        denyReason: decision === 'denied' ? (reason ?? null) : null,
      })
      .where(eq(approvals.id, approvalId))
      .run();

    broadcastApprovalResolved(approvalId, decision);
    return undefined;
  }
}

/**
 * Why a grant or deny could not be recorded.
 *
 * - `unknown` — no such approval.
 * - `not_pending` — already decided or already spent.
 * - `expired` — the decision window closed; the approval is written off.
 */
export type ApprovalDecisionFailure = 'unknown' | 'not_pending' | 'expired';

/**
 * The process-wide service, initialized at boot. Mirrors the agent-identity
 * module's singleton so seams with no database handle in scope — the marketplace
 * confirmation providers, the approvals router — can reach it lazily.
 */
let service: ApprovalService | undefined;

/**
 * Initialize the process-wide approval service.
 *
 * @param db - The DorkOS database handle.
 * @returns The initialized service.
 */
export function initApprovalService(db: Db): ApprovalService {
  service = new ApprovalService(db);
  return service;
}

/**
 * The process-wide approval service, or `undefined` when it was never
 * initialized (unit tests that build the app without a database). Callers must
 * treat `undefined` as "approvals are unavailable" and refuse the gated action
 * rather than letting it through.
 *
 * @returns The service, or `undefined`.
 */
export function getApprovalService(): ApprovalService | undefined {
  return service;
}

/** Reset the singleton. Test-only seam, mirroring the agent-identity module. */
export function resetApprovalService(): void {
  service = undefined;
}
