/**
 * Ending approvals nobody answered, without deciding them: the expiry sweep,
 * and an open approval a newer one for the same thing replaces (DOR-3433).
 *
 * Both end a row the same way: a conditional write stamps `consumedAt` on a row
 * still unspent, so a `consume` or a second retirement landing in the same
 * millisecond cannot end one approval twice, and `state` stays `pending`,
 * because nobody decided it. The caller's `settle` then retires the card and
 * stops the escalation clock, exactly as for every other ending.
 *
 * ## Families
 *
 * A passive hook row (DOR-3427) is one row per package per project for good,
 * but its binding names the exact files it would run, so a package edited
 * twice would leave a row for each version. A requester that wants one open
 * approval per thing puts the thing's key in front of the input hash
 * ({@link familyInputHash}), and raising a new one retires every other open
 * row of that family ({@link retireSupersededApprovals}). The input hash is
 * otherwise opaque and compared only for equality, so nothing else changes:
 * the token is still bound to exactly what the row was raised for. A retired
 * row reads as expired, so the requester waiting on it hears `consumed` and
 * records no refusal.
 *
 * @module services/core/approvals/approval-retirement
 */
import { and, eq, isNull, lt, approvals, type Db } from '@dorkos/db';
import type { ApprovalBinding } from './approval-service.js';

/** Retire one approval's card and escalation, after its row was ended. */
type Settle = (approvalId: string) => void;

/**
 * An input hash that carries the family it belongs to.
 *
 * @param family - A short, stable key for the thing the approval is about.
 * @param inputHash - The canonical hash of the exact action.
 * @returns `<family>.<inputHash>`.
 */
export function familyInputHash(family: string, inputHash: string): string {
  return `${family}.${inputHash}`;
}

/** End one unspent row, stamping `extra` with it; true when this call ended it. */
function endRow(db: Db, approvalId: string, extra: { expiresAt?: string } = {}): boolean {
  const result = db
    .update(approvals)
    .set({ consumedAt: new Date().toISOString(), ...extra })
    .where(and(eq(approvals.id, approvalId), isNull(approvals.consumedAt)))
    .run();
  return result.changes === 1;
}

/**
 * Settle every approval whose window has closed with nobody having answered.
 * The body of `ApprovalService.sweepExpired`; see its docs.
 *
 * @param db - The DorkOS database handle.
 * @param settle - Retires the card and escalation of each row this ends.
 * @returns How many approvals this call settled.
 */
export function sweepExpiredApprovals(db: Db, settle: Settle): number {
  const rows = db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.state, 'pending'),
        isNull(approvals.consumedAt),
        // Strictly past the deadline, matching `isExpired` exactly so the sweep
        // and every other expiry check agree about the boundary instant.
        lt(approvals.expiresAt, new Date().toISOString())
      )
    )
    .all();
  let settled = 0;
  for (const row of rows) {
    if (!endRow(db, row.id)) continue;
    settle(row.id);
    settled += 1;
  }
  return settled;
}

/**
 * Retire every other open approval of one family, so only the newest stays.
 *
 * Only rows still waiting are retired: one a person already answered is left
 * for its requester to spend, so a no is never lost to a newer row. Each is
 * stamped expired now, which is also what lets the retention purge delete a
 * passive row that would otherwise never run out.
 *
 * @param db - The DorkOS database handle.
 * @param binding - The approval being raised; rows with its exact input hash stay.
 * @param family - The family key in front of the input hash ({@link familyInputHash}).
 * @param settle - Retires the card and escalation of each row this ends.
 * @returns How many approvals this call retired.
 */
export function retireSupersededApprovals(
  db: Db,
  binding: ApprovalBinding,
  family: string,
  settle: Settle
): number {
  const prefix = familyInputHash(family, '');
  const rows = db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.capabilityId, binding.capabilityId),
        eq(approvals.state, 'pending'),
        isNull(approvals.consumedAt)
      )
    )
    .all()
    .filter((row) => row.inputHash.startsWith(prefix) && row.inputHash !== binding.inputHash);
  let retired = 0;
  for (const row of rows) {
    if (!endRow(db, row.id, { expiresAt: new Date().toISOString() })) continue;
    settle(row.id);
    retired += 1;
  }
  return retired;
}
