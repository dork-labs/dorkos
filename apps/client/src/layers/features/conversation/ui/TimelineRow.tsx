/**
 * One drawn row of `Conversation.Timeline`, memoised on what the host draws it from.
 *
 * **Why this exists (DOR-3312).** `useVirtualizer` re-renders the timeline on
 * every scroll frame, every measurement and every `isScrolling` flip, and the
 * timeline used to call `renderRow` inline for every row in the window each
 * time. A host row is a whole message — author, reactions, markdown, two
 * locale-formatted times — so one arrival, which the list follows to the bottom
 * over a few hundred milliseconds, re-drew every visible message on every frame
 * of that scroll. Measured on a 500-entry room: several full re-draws of the
 * window per arrival, and a busy room arrives all day.
 *
 * A row's output depends only on the row, its index, the context and the
 * renderer. Every shipped host builds `renderRow` with `useCallback` over what
 * it reads, so the renderer's identity changes exactly when a row could draw
 * differently — and a virtualizer-only re-render, which changes none of the
 * four, now skips the row. A host passing an inline renderer gets a new identity
 * every render and is drawn exactly as before.
 *
 * @module features/conversation/ui/TimelineRow
 */
import { memo, useMemo } from 'react';
import type {
  ConversationRow,
  ConversationRowContext,
  ConversationRowRenderer,
} from '../lib/row-kinds';

interface TimelineRowProps {
  row: ConversationRow;
  index: number;
  context: Omit<ConversationRowContext, 'index'>;
  renderRow: ConversationRowRenderer;
}

/** Draw one row through the host's renderer, skipping re-renders that change nothing it reads. */
export const TimelineRow = memo(function TimelineRow({
  row,
  index,
  context,
  renderRow,
}: TimelineRowProps) {
  const rowContext = useMemo(() => ({ ...context, index }), [context, index]);
  return <>{renderRow(row, rowContext)}</>;
});
