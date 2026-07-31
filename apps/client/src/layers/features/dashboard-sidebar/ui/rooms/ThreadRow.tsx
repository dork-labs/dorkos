import { MessagesSquare } from 'lucide-react';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { SidebarMenuItem } from '@/layers/shared/ui';
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
 * the other and not both.
 *
 * The excerpt is clamped to two lines rather than truncated in the string: the
 * server already cut it to a preview length, and a second `…` from a box that
 * also clamps would give the reader two of them.
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

  return (
    <SidebarMenuItem>
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'focus-visible:ring-sidebar-ring flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-xs outline-hidden transition-colors duration-100 focus-visible:ring-2 active:scale-[0.98]',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        <MessagesSquare
          className={cn('mt-0.5 size-3.5 shrink-0', unread && !isActive && 'text-brand')}
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn('line-clamp-2', unread && !isActive && 'text-foreground font-medium')}
          >
            {preview === '' ? 'Untitled thread' : preview}
          </span>
          <span className="text-muted-foreground/80 truncate text-[10px]">
            {roomLabel} · {thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}
          </span>
        </span>
        {unread && (
          <span
            className="bg-brand/15 text-brand mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
            // The thread is NOT named again: this label joins the row's own text
            // to make its accessible name, and repeating the excerpt would read
            // it twice — the same defect the room rows were fixed for.
            aria-label={`${thread.unreadCount} unread`}
          >
            {thread.unreadCount}
          </span>
        )}
      </button>
    </SidebarMenuItem>
  );
}
