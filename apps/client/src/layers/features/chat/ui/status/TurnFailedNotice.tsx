import { motion } from 'motion/react';
import { useSessionRuntime, useSessionStreamStatus } from '@/layers/entities/session';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { ErrorMessageBlock } from '../message/ErrorMessageBlock';

/** Fallback copy when the failed turn carried no typed error details. */
const GENERIC_FAILURE_COPY = 'The turn ended before completing.';

interface TurnFailedNoticeProps {
  /** Session whose turn failed — names the owning runtime in the copy. */
  sessionId: string;
  /**
   * Re-send the last user message. Omit when there is nothing to resend —
   * the notice then renders without a Retry button rather than a dead one.
   */
  onRetry?: () => void;
}

/**
 * Panel-level notice shown when a turn ends in a typed error and no other
 * error affordance is visible (see `shouldShowTurnFailedNotice`). This is the
 * retry surface for runtimes whose failures never render an inline error part
 * — e.g. a sidecar crash that only closes the turn.
 *
 * The failure details come from the snapshot-backed `status.lastError` (set by
 * the typed `error` event, mirrored by the server projector), so the notice
 * shows the runtime's real message, category, and collapsible code/details —
 * live and after reconnect. When the turn failed without a typed error
 * (`turn_end{terminalReason:'error'}` alone), it falls back to the generic
 * execution_error copy.
 *
 * The heading names the session's runtime ("Codex stopped unexpectedly")
 * when the session row has resolved it, so a failed turn on a non-default
 * runtime never reads as a generic agent error (spec §UX capability
 * honesty). With no row (a first turn that failed before the session was
 * listed) it falls back to the runtime-neutral execution_error copy.
 *
 * The entrance is delayed a beat: on Claude Code the post-turn history reload
 * usually lands within ~300ms and renders the inline error block instead, so
 * the delay avoids a notice that flashes in and immediately hands off.
 */
export function TurnFailedNotice({ sessionId, onRetry }: TurnFailedNoticeProps) {
  const runtime = useSessionRuntime(sessionId);
  const lastError = useSessionStreamStatus(sessionId)?.lastError ?? null;
  const heading = runtime
    ? `${getRuntimeDescriptor(runtime).label} stopped unexpectedly`
    : undefined;
  const message = lastError?.message ?? GENERIC_FAILURE_COPY;
  const details = lastError
    ? [lastError.code, lastError.details].filter(Boolean).join('\n')
    : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3, duration: 0.2, ease: 'easeOut' }}
      className="mx-4 mb-2"
      data-testid="turn-failed-notice"
    >
      <ErrorMessageBlock
        category={lastError?.category ?? 'execution_error'}
        heading={heading}
        message={message}
        subtext={message}
        details={details || undefined}
        onRetry={onRetry}
      />
    </motion.div>
  );
}
