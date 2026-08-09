import { MessagesSquare } from 'lucide-react';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { SidebarRow } from '@/layers/shared/ui';
import { roomDisplayTitle } from '@/layers/entities/room';

interface ThreadRowProps {
  /** The thread this row opens. */
  thread: ThreadSummary;
  /** Whether this thread is the one on screen. */
  isActive: boolean;
  /** Open the room with this thread's panel showing. */
  onSelect: () => void;
}

/**
 * One thread in the sidebar — what it was about, where it lives, and how far
 * behind the reader is.
 *
 * **Two lines, in the order the question is asked.** "Where is this thread?" is
 * answered by the excerpt first — that is what a person remembers a thread by —
 * and the room underneath it, because the room is how you confirm you found the
 * right one rather than how you recognise it. A one-line row could hold one or
 * the other and not both. The second line is earned rather than reserved, which
 * is the shared row's own rule (BC-24): a thread always has a room to name.
 *
 * A root that carried no text reads as "Untitled thread" rather than as an
 * empty row. It is reachable — an entry's body is JSON and a corrupted one
 * degrades to whatever was in the column — and a row with nothing on it is a
 * row nobody can click on purpose.
 */
export function ThreadRow({ thread, isActive, onSelect }: ThreadRowProps) {
  const roomLabel = roomDisplayTitle({
    kind: thread.roomKind,
    slug: thread.roomSlug,
    title: thread.roomTitle,
  });
  const unread = thread.unreadCount > 0;
  const preview = thread.rootPreview.trim();
  const title = preview === '' ? 'Untitled thread' : preview;
  const replies = `${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`;

  return (
    <SidebarRow
      glyph={
        <MessagesSquare
          className={cn('size-3.5', unread && !isActive && 'text-brand')}
          aria-hidden
        />
      }
      title={title}
      isActive={isActive}
      emphasized={unread}
      onSelect={onSelect}
      preview={`${roomLabel} · ${replies}`}
      trailing={
        unread ? (
          <span
            className="bg-brand/15 text-brand rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
            // The thread is NOT named again: this label joins the row's own text
            // to make its accessible name, and repeating the excerpt would read
            // it twice — the same defect the room rows were fixed for.
            aria-label={`${thread.unreadCount} unread`}
          >
            {thread.unreadCount}
          </span>
        ) : undefined
      }
    />
  );
}
