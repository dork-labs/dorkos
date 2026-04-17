import { motion, AnimatePresence } from 'motion/react';
import type { TerminalReason } from '@dorkos/shared/types';
import { Badge } from '@/layers/shared/ui';
import { formatTerminalReason, isVisibleReason } from './terminal-reason-labels';

interface TerminalReasonChipProps {
  /**
   * The session's current terminal reason, as merged from the latest
   * `session_status` StreamEvent. Passing `undefined` or `'completed'`
   * causes the component to render nothing.
   */
  terminalReason?: TerminalReason;
}

/**
 * Informational chip surfaced below the message list when a session ends
 * with a non-`completed` terminal reason. Renders nothing for undefined or
 * `'completed'` values.
 *
 * Data source: `sessionStatus.terminalReason` on the latest `session_status`
 * StreamEvent. Plumbing landed in spec 245; this component surfaces it.
 *
 * @param props - Component props.
 * @param props.terminalReason - The session's current terminal reason from the latest `session_status` event.
 */
export function TerminalReasonChip({ terminalReason }: TerminalReasonChipProps) {
  const visible = isVisibleReason(terminalReason);
  const label = visible ? formatTerminalReason(terminalReason) : '';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={terminalReason}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="flex justify-center px-4 py-1 md:justify-start"
          data-testid="terminal-reason-chip"
        >
          <Badge variant="secondary" aria-label={`Session ended: ${label}`}>
            {label}
          </Badge>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
