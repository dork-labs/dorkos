/**
 * The chat header's pull requests (W5, DOR-4971): how many this chat and the
 * chats below it opened or worked on, and the list behind a press.
 *
 * @module widgets/one-bar/ui/ChatWorkChip
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitPullRequest } from 'lucide-react';
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  useResponsivePopover,
} from '@/layers/shared/ui';
import { useChatPullRequests, WorkItemList, workGraphKeys } from '@/layers/entities/work-graph';

/** Props for {@link ChatWorkChip}. */
interface ChatWorkChipProps {
  /** The chat the bar is showing, or null before one is chosen. */
  sessionId: string | null;
}

/** The panel's heading: the sheet's title on a phone, a plain line on a desktop. */
function Heading() {
  const { isDesktop } = useResponsivePopover();
  if (!isDesktop) {
    return (
      <ResponsivePopoverTitle className="text-sm font-medium">Pull requests</ResponsivePopoverTitle>
    );
  }
  return <p className="text-sm font-medium">Pull requests</p>;
}

/**
 * "3 PRs" in the chat header, or nothing while this chat and its spin-offs
 * have none. Pressing it lists them; on a phone the chip keeps only its icon
 * and count, and the list opens as a bottom sheet.
 *
 * @param props - The chat the bar is showing.
 */
export function ChatWorkChip({ sessionId }: ChatWorkChipProps) {
  const query = useChatPullRequests(sessionId);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  if (sessionId === null || query.items.length === 0) return null;

  const count = `${query.items.length}${query.hasMore ? '+' : ''}`;
  const words = query.items.length === 1 && !query.hasMore ? '1 PR' : `${count} PRs`;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Opening is when a person wants it current: a spin-off may have opened one since.
    if (next)
      void queryClient.invalidateQueries({ queryKey: workGraphKeys.chatWork(sessionId, 'pr') });
  };

  return (
    // The sheet has no field at the top, so focus moves into it on a phone, as
    // the desktop popover's does (`ResponsivePopoverProps.autoFocus`).
    // eslint-disable-next-line jsx-a11y/no-autofocus
    <ResponsivePopover open={open} onOpenChange={onOpenChange} autoFocus>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-work-chip"
          aria-label={`${words} from this chat. Show them`}
          className="focus-ring text-muted-foreground hover:text-foreground border-border text-2xs inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 transition-colors @max-md/bar:min-h-7"
        >
          <GitPullRequest className="size-(--size-icon-xs)" aria-hidden />
          <span className="@max-md/bar:hidden">{words}</span>
          <span className="hidden tabular-nums @max-md/bar:inline">{count}</span>
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="bottom"
        align="end"
        aria-label="Pull requests"
        className="w-80 max-w-[calc(100vw-1.5rem)] space-y-2 p-3"
      >
        <div className="space-y-0.5">
          <Heading />
          <p className="text-muted-foreground text-xs">From this chat and its spin-offs.</p>
        </div>
        <WorkItemList
          query={query}
          chatId={sessionId}
          emptyText="No pull requests yet."
          className="max-h-[60vh] overflow-y-auto"
        />
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
