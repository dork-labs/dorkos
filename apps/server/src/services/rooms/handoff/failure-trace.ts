/** Bounded server-owned correlation; no message, draft, credential or raw diagnostic payload. */
import { logger } from '../../../lib/logger.js';
import type { AsideResult } from '../room-trigger/aside.js';
/** Created by the handoff service, passed internally through its held seat claim. */
export interface HandoffTrace {
  readonly handoffId: string;
  readonly roomId: string;
  readonly authorId: string;
  dispatchId?: string;
  attempt: 0 | 1;
  oldSessionId: string | null;
  freshSessionId?: string;
  sourceStartSeq?: number;
  sourceEndSeq?: number;
}
function fields(trace: HandoffTrace, typedCause: string) {
  return {
    handoffId: trace.handoffId,
    roomId: trace.roomId,
    authorId: trace.authorId,
    dispatchId: trace.dispatchId ?? null,
    attempt: trace.attempt,
    oldSessionId: trace.oldSessionId,
    freshSessionId: trace.freshSessionId ?? null,
    sourceStartSeq: trace.sourceStartSeq ?? null,
    sourceEndSeq: trace.sourceEndSeq ?? null,
    typedCause,
  };
}
/** Correlate one replacement with the receipt and actual source failure watermark. */
export function logRecoveredHandoff(trace: HandoffTrace): void {
  logger.info('[rooms] recovered a failed handoff seat', fields(trace, 'prior-server-error'));
}
/** Explain failure structurally, retaining protected refusal distinctions without raw strings. */
export function logHandoffFailure(trace: HandoffTrace, result: AsideResult | null): void {
  const refusal = result?.failure?.refusal;
  const protectedRefusals = [
    'warm-ceiling',
    'pending-interaction',
    'crash-loop',
    'paused',
    'runtime-gone',
    'account-not-allowed',
    'account-pin',
    'sign-in',
    'usage',
    'budget',
    'permission',
  ];
  const code = result?.failure?.code;
  const typedCause =
    refusal !== undefined
      ? protectedRefusals.includes(refusal)
        ? refusal
        : 'protected-refusal'
      : result?.why === 'deadline'
        ? 'deadline'
        : result?.why === 'budget'
          ? 'budget'
          : code === 'exception'
            ? 'exception'
            : code === 'server_error'
              ? 'server-error'
              : code === 'error_during_execution'
                ? 'execution-error'
                : result?.outcome === 'failed'
                  ? 'turn-failed'
                  : result?.outcome === 'halted'
                    ? 'halted'
                    : result?.outcome === 'busy'
                      ? 'busy'
                      : result?.outcome === 'refused'
                        ? 'refused'
                        : 'declined';
  const ordinaryDecline =
    (result?.outcome === 'quiet' || result?.outcome === 'answered') &&
    result.failure === undefined &&
    result.why === undefined;
  if (ordinaryDecline) {
    logger.debug('[rooms] handoff did not post', fields(trace, typedCause));
  } else {
    logger.warn('[rooms] handoff did not post', fields(trace, typedCause));
  }
}
