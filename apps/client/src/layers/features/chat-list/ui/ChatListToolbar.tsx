/**
 * The controls above the chat list: an optional title search, the sort, and
 * New chat.
 *
 * @module features/chat-list/ui/ChatListToolbar
 */
import { Plus, Search } from 'lucide-react';
import { Button, Input, SegmentedControl, SegmentedControlItem } from '@/layers/shared/ui';
import { CHAT_LIST_SORTS, type ChatListSort } from '../model/build-chat-list';

/** What each sort is called on its control. */
const SORT_LABEL: Record<ChatListSort, string> = {
  'for-you': 'For you',
  activity: 'Recent activity',
  started: 'Started',
};

/** Props for {@link ChatListToolbar}. */
export interface ChatListToolbarProps {
  /** Show the search field and the sort: false while there are no chats. */
  hasChats: boolean;
  /** Draw the search field at all. */
  searchable: boolean;
  /** The search text. */
  search: string;
  /** Change the search text. */
  onSearchChange: (next: string) => void;
  /** The chosen sort. */
  sort: ChatListSort;
  /** Pick a sort. */
  onSortChange: (next: ChatListSort) => void;
  /** Start a new chat. */
  onNewChat: () => void;
}

/**
 * Search, sort and New chat. On a phone the sort and New chat stack, New chat
 * first and full width: three sort labels and a button do not share 343px.
 *
 * @param props - The values and what changing them does.
 */
export function ChatListToolbar({
  hasChats,
  searchable,
  search,
  onSearchChange,
  sort,
  onSortChange,
  onNewChat,
}: ChatListToolbarProps) {
  return (
    <>
      {searchable && hasChats && (
        <div className="relative shrink-0">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
          />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-8 pl-7 text-sm"
          />
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {hasChats && (
          <SegmentedControl
            aria-label="Sort chats"
            value={sort}
            onValueChange={(next) => onSortChange(next as ChatListSort)}
            className="w-full sm:w-auto sm:flex-none"
          >
            {CHAT_LIST_SORTS.map((option) => (
              <SegmentedControlItem key={option} value={option} className="whitespace-nowrap">
                {SORT_LABEL[option]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        )}
        <Button
          variant="outline"
          size="sm"
          className="w-full shrink-0 max-sm:order-first sm:ml-auto sm:w-auto"
          onClick={onNewChat}
          data-slot="chat-list-new"
        >
          <Plus className="size-3.5" aria-hidden />
          New chat
        </Button>
      </div>
    </>
  );
}
