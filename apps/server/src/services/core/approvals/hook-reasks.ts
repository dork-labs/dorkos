/** One-at-a-time, person-requested reviews; the previous denial stays in the audit log. */
import { and, approvals, desc, eq, isNotNull, isNull, type Db } from '@dorkos/db';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { ApprovalBinding, ApprovalTicket } from './approval-service.js';
import type { ApprovalRequestInput } from './approval-request-input.js';
import type { ApprovalRow } from './approval-card.js';
import { storedHookRequest } from './approval-completeness.js';

/** Why a declined row cannot start another review. */
export type HookReaskFailure = 'not_declined' | 'already_reasked' | 'unavailable';

/** Read the exact original request, without exposing it on the HTTP response. */
export function declinedHookRequest(db: Db, id: string) {
  const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
  return row?.capabilityId === 'harness.project_hooks' && row.state === 'denied'
    ? storedHookRequest(row.packageRequest)
    : undefined;
}

/** A bounded history of individual declined cards; never returns token or full-request fields. */
export function declinedHookCards(db: Db, toCard: (row: ApprovalRow) => PendingApproval) {
  const rows = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.capabilityId, 'harness.project_hooks'), eq(approvals.state, 'denied')))
    .orderBy(desc(approvals.decidedAt))
    .limit(100)
    .all();
  const active = db
    .select()
    .from(approvals)
    .where(and(eq(approvals.capabilityId, 'harness.project_hooks'), isNull(approvals.consumedAt)))
    .all()
    .filter((row) => row.state !== 'denied' && Date.parse(row.expiresAt) > Date.now())
    .flatMap((row) => {
      const request = storedHookRequest(row.packageRequest);
      return request ? [`${request.projectPath}\0${request.packageName}`] : [];
    });
  return rows.map((row) => {
    const request = storedHookRequest(row.packageRequest);
    const reviewPending =
      !!request && active.includes(`${request.projectPath}\0${request.packageName}`);
    const retried = db
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.retryOf, row.id))
      .get();
    return {
      approval: toCard(row),
      declineKind: row.declineKind ?? ('refused' as const),
      canAskAgain: !retried && !reviewPending && request !== undefined,
      reviewPending,
      askedAgain: retried !== undefined,
    };
  });
}

/** Create a fresh pending row exactly once for this denial; no consent is cleared or granted. */
export function reaskHook(
  db: Db,
  id: string,
  input: ApprovalRequestInput,
  makeRow: (input: ApprovalRequestInput) => { row: ApprovalRow; token: string },
  announce: (row: ApprovalRow) => void
): ApprovalTicket | HookReaskFailure {
  const original = declinedHookRequest(db, id);
  const next = input.packageRequest;
  if (!original) return 'not_declined';
  if (
    input.capabilityId !== 'harness.project_hooks' ||
    next?.kind !== 'hooks' ||
    next.request.projectPath !== original.projectPath ||
    next.request.packageName !== original.packageName
  )
    return 'unavailable';
  const made = makeRow({ ...input, passive: true });
  const row = { ...made.row, retryOf: id };
  const result = db.transaction(() => {
    const source = db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (source?.state !== 'denied') return 'not_declined' as const;
    if (db.select({ id: approvals.id }).from(approvals).where(eq(approvals.retryOf, id)).get())
      return 'already_reasked' as const;
    const active = db
      .select()
      .from(approvals)
      .where(and(eq(approvals.capabilityId, 'harness.project_hooks'), isNull(approvals.consumedAt)))
      .all()
      .some((candidate) => {
        const request = storedHookRequest(candidate.packageRequest);
        return (
          candidate.state !== 'denied' &&
          Date.parse(candidate.expiresAt) > Date.now() &&
          request?.projectPath === original.projectPath &&
          request.packageName === original.packageName
        );
      });
    if (active) return 'already_reasked' as const;
    db.insert(approvals).values(row).run();
    // End any old follower before it can turn its delayed receipt into a new refusal.
    if (source.consumedAt === null)
      db.update(approvals)
        .set({ consumedAt: new Date().toISOString() })
        .where(eq(approvals.id, id))
        .run();
    return undefined;
  });
  if (result) return result;
  announce(row);
  return { approvalId: row.id, token: made.token, expiresAt: row.expiresAt };
}

/** Only a row linked by the person-only re-ask path may review an existing refusal. */
export function isReaskedHook(db: Db, binding: ApprovalBinding): boolean {
  const rows = db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.capabilityId, binding.capabilityId),
        eq(approvals.inputHash, binding.inputHash)
      )
    )
    .all();
  return rows.some((row) => {
    if (
      !row.retryOf ||
      row.consumedAt ||
      row.state === 'denied' ||
      Date.parse(row.expiresAt) <= Date.now()
    )
      return false;
    const source = db.select().from(approvals).where(eq(approvals.id, row.retryOf)).get();
    return source?.capabilityId === 'harness.project_hooks' && source.state === 'denied';
  });
}

/** Full requests of live person-requested reviews, rebuilt from SQLite after restart. */
export function reaskedHookRequests(db: Db) {
  return db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.capabilityId, 'harness.project_hooks'),
        isNotNull(approvals.retryOf),
        isNull(approvals.consumedAt)
      )
    )
    .all()
    .filter((row) => row.state !== 'denied' && Date.parse(row.expiresAt) > Date.now())
    .flatMap((row) => {
      const request = storedHookRequest(row.packageRequest);
      return request ? [request] : [];
    });
}
