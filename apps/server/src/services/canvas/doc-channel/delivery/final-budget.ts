/** Fresh private-document turn limits at the final synchronous runtime boundary. */
import {
  and,
  desc,
  eq,
  gt,
  canvasDocBatches,
  sessionMessageAcceptanceReceipts,
  type DbTransaction,
} from '@dorkos/db';

export const DOCUMENT_BUDGET_WAIT = 'document_dispatch_budget_wait';
/** All identity is server-derived after fresh exact grant/receipt validation. */
export interface DocBeforeClaimContext {
  readonly documentId: string;
  readonly batchId: string;
  readonly generation: string;
  readonly routeId: string;
  readonly grantId: string;
  readonly grantRevision: number;
  readonly scope: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly runtime: string;
  readonly agentPath: string;
  readonly turnsPerHour: number;
}
export type DocClaimBudgetDecision =
  | { decision: 'admit' }
  | { decision: 'defer'; reason: string; nextEligibleAt: string }
  | { decision: 'refuse'; code: string };
export type DocBeforeClaim = (
  context: Readonly<DocBeforeClaimContext>,
  tx: DbTransaction,
  now: string
) => DocClaimBudgetDecision;
const HOUR = 3600_000;
/** Direct private routes spend the approved route ceiling, bounded by the platform ceiling. */
export const privateDocTurnBudget: DocBeforeClaim = (context, tx, now) => {
  const ceiling = context.turnsPerHour;
  if (
    !Number.isInteger(ceiling) ||
    ceiling < 1 ||
    ceiling > 10 ||
    !context.scope.startsWith('session:') ||
    context.scope.slice(8) !== context.sessionId ||
    !Number.isFinite(Date.parse(now))
  )
    return { decision: 'refuse', code: 'document_budget_invalid' };
  const started = tx
    .select({ at: sessionMessageAcceptanceReceipts.turnStartedAt })
    .from(canvasDocBatches)
    .innerJoin(
      sessionMessageAcceptanceReceipts,
      eq(canvasDocBatches.admissionReceiptId, sessionMessageAcceptanceReceipts.id)
    )
    .where(
      and(
        eq(canvasDocBatches.documentId, context.documentId),
        eq(canvasDocBatches.routeId, context.routeId),
        gt(
          sessionMessageAcceptanceReceipts.turnStartedAt,
          new Date(Date.parse(now) - HOUR).toISOString()
        )
      )
    )
    .orderBy(desc(sessionMessageAcceptanceReceipts.turnStartedAt))
    .limit(10)
    .all();
  if (started.length < ceiling) return { decision: 'admit' };
  const boundary = Date.parse(started[ceiling - 1]!.at!) + HOUR;
  return {
    decision: 'defer',
    reason: 'route_turn_ceiling',
    nextEligibleAt: new Date(boundary).toISOString(),
  };
};
