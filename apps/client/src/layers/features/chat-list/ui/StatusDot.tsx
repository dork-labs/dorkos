/**
 * The dot beside the words that say what a chat is doing, shared by the list's
 * rows and the chat tree under them.
 *
 * @module features/chat-list/ui/StatusDot
 */
import { cn } from '@/layers/shared/lib';
import { STATUS_DOT_LABEL, statusDotClass } from '@/layers/shared/ui';
import type { ChatStatus } from '../model/build-chat-list';

/** Which dot each status draws, if any. Idle draws none. */
const STATUS_DOT: Partial<Record<ChatStatus, 'working' | 'needs-you' | 'error'>> = {
  running: 'working',
  'needs-you': 'needs-you',
  'out-of-usage': 'error',
  failed: 'error',
};

/**
 * A dot beside the words that say what a chat is doing: running, needs you,
 * out of usage or stopped with an error. Idle draws none.
 *
 * Inline with the words rather than in a column of its own, so a settled row
 * spends no width on an empty slot and every title starts at the same edge
 * as the controls above the list.
 *
 * @param props - The chat's status, and whether words beside it say the same.
 */
export function StatusDot({
  status,
  decorative = false,
}: {
  status: ChatStatus;
  decorative?: boolean;
}) {
  const signal = STATUS_DOT[status];
  if (signal === undefined) return null;
  return (
    <span
      // Hidden from assistive tech where words beside it already say the same
      // thing; a running chat's verb can be empty, so its dot keeps a name.
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': STATUS_DOT_LABEL[signal] })}
      data-status={status}
      className={cn(
        'mr-1.5 inline-block size-1.5 rounded-full align-middle',
        statusDotClass(signal)
      )}
    />
  );
}
