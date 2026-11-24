/** Producer-only exact cause/terminal/account correlation; never a client retry flag. */
import type { AgentSession } from '../agent-types.js';
import { currentDispatch } from '../../../../lib/dispatch-context.js';
import { isCreditsClaudeRoot } from '../credits-root.js';
import { recordFailedSeatTurn } from '../../../rooms/reseat/failed-seat-record.js';

/**
 * Fold only a structured server-error wrapper and positively observed previous-turn billing.
 * The same facts are kept durably, so one recovery can still run after a restart (DOR-4626).
 */
export function serverFailureWitness(
  session: AgentSession,
  sessionId: string,
  input: {
    subtype?: string;
    terminalReason?: string;
    stopped: boolean;
    auth: boolean;
    errors: unknown;
  }
): { reason: string; sourceDispatchId?: string } | undefined {
  const evidence = session.serverErrorEvidence;
  if (
    input.subtype !== 'error_during_execution' ||
    input.stopped ||
    input.auth ||
    (input.terminalReason !== undefined && input.terminalReason !== 'error') ||
    !evidence ||
    evidence.vetoed ||
    session.rejectedLimitThisTurn ||
    (input.errors !== undefined &&
      (!Array.isArray(input.errors) ||
        !input.errors.every(
          (error) => typeof error === 'string' && evidence.notices.includes(error)
        )))
  )
    return;
  const dispatch = currentDispatch();
  const billing = session.sdkReportedBilling;
  const route = session.validatedRecoveryRoute;
  if (
    dispatch?.origin === 'room' &&
    dispatch.entryId &&
    billing &&
    route?.root === billing.root &&
    route.inference === (isCreditsClaudeRoot(billing.root) ? 'credits' : 'own-account') &&
    session.launchedAccountRoot === billing.root
  ) {
    session.priorServerFailure = {
      dispatchId: dispatch.dispatchId,
      entryId: dispatch.entryId,
      root: billing.root,
      billing: billing.perToken ? 'per-token' : 'subscription',
      inference: isCreditsClaudeRoot(billing.root) ? 'credits' : 'own-account',
    };
    recordFailedSeatTurn(sessionId, session.cwd, session.priorServerFailure);
  }
  return {
    reason: 'claude-server-error-terminal',
    ...(dispatch ? { sourceDispatchId: dispatch.dispatchId } : {}),
  };
}
