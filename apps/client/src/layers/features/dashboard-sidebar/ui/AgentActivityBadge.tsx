import type { SessionBorderKind } from '@/layers/entities/session';
import { RowStatusMark, type RowMark } from './RowStatusMark';

interface AgentActivityBadgeProps {
  status: SessionBorderKind;
  label: string;
}

/**
 * How a session's border kind reads as a row mark. `idle` is absent on purpose —
 * a row with nothing to report shows nothing, which is what makes the rows
 * that do report mean something.
 *
 * The shapes and colours live in {@link RowStatusMark}, the sidebar's one mark,
 * so an agent row and a room row cannot say the same thing two ways.
 */
const ROW_MARK: Partial<Record<SessionBorderKind, RowMark>> = {
  streaming: 'working',
  pendingApproval: 'needs-you',
  error: 'error',
  unseen: 'unseen',
};

/**
 * The agent row's status mark, or nothing when the agent is idle.
 *
 * Visible even when the agent is collapsed. Needs you is a diamond, the rest
 * are dots, and only working moves: an agent mid-turn is an event, an agent
 * waiting on you is a state, and a state that pulsed would claim to still be
 * going.
 */
export function AgentActivityBadge({ status, label }: AgentActivityBadgeProps) {
  const mark = ROW_MARK[status];
  if (!mark) return null;
  return <RowStatusMark mark={mark} label={label} />;
}
