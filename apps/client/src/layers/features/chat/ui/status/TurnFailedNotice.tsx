import { motion } from 'motion/react';
import { ErrorMessageBlock } from '../message/ErrorMessageBlock';

interface TurnFailedNoticeProps {
  /**
   * Re-send the last user message. Omit when there is nothing to resend —
   * the notice then renders without a Retry button rather than a dead one.
   */
  onRetry?: () => void;
}

/**
 * Panel-level notice shown when a turn ends in a typed error and no other
 * error affordance is visible (see `shouldShowTurnFailedNotice`). This is the
 * retry surface for runtimes whose failures only reach the client as
 * `turn_end{terminalReason:'error'}` — a sidecar crash, a CLI exit.
 *
 * The entrance is delayed a beat: on Claude Code the post-turn history reload
 * usually lands within ~300ms and renders the inline error block instead, so
 * the delay avoids a notice that flashes in and immediately hands off.
 */
export function TurnFailedNotice({ onRetry }: TurnFailedNoticeProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3, duration: 0.2, ease: 'easeOut' }}
      className="mx-4 mb-2"
      data-testid="turn-failed-notice"
    >
      <ErrorMessageBlock
        category="execution_error"
        message="The turn ended before completing."
        onRetry={onRetry}
      />
    </motion.div>
  );
}
