/**
 * A list of pull requests: what each is, how the chats came to it, and when.
 *
 * Shows the relation, the reference and the day only. Whether a pull request
 * is open, merged or closed is not read yet: that is DOR-5458.
 *
 * @module entities/work-graph/ui/WorkItemList
 */
import { ArrowUpRight, GitPullRequest } from 'lucide-react';
import type { WorkItem } from '@dorkos/shared/work-graph-reads';
import { cn } from '@/layers/shared/lib';
import { Button, Skeleton } from '@/layers/shared/ui';
import { dayWords, fromSpinOffsOnly, itemRelations, pullRequestUrl } from '../lib/work-item-words';
import type { PullRequestsQuery } from '../model/use-pull-requests';

/** The `data-slot` on each pull request's row. */
export const WORK_ITEM_ROW_SLOT = 'work-item-row';

/** Props for {@link WorkItemList}. */
export interface WorkItemListProps {
  /** The pull requests, as a work graph hook reads them. */
  query: PullRequestsQuery;
  /** What the list says when there are none. */
  emptyText: string;
  /**
   * The chat the list is about, when it is one: an item only the chats below
   * it are linked to says "In a spin-off".
   */
  chatId?: string;
  /** Extra classes on the root. */
  className?: string;
}

/**
 * Pull requests, newest first, each a link to GitHub when its reference names
 * a repository, with "Show more" while another page waits.
 *
 * Shows the relation, the reference and the day; the pull request's own state
 * (open, merged, closed) is a follow-up, DOR-5458.
 *
 * @param props - The query, the empty words, and the chat the list is about.
 */
export function WorkItemList({ query, emptyText, chatId, className }: WorkItemListProps) {
  if (query.isLoading) {
    return (
      <div className={cn('flex flex-col gap-1.5', className)} aria-label="Loading pull requests">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-3/4" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <p className={cn('text-muted-foreground text-sm', className)}>
        Couldn’t read the pull requests.
      </p>
    );
  }
  if (query.items.length === 0) {
    return <p className={cn('text-muted-foreground text-sm', className)}>{emptyText}</p>;
  }
  return (
    <div className={cn('flex flex-col', className)}>
      <ul className="flex flex-col" aria-label="Pull requests">
        {query.items.map((item) => (
          <WorkItemRow key={`${item.ref.kind}:${item.ref.id}`} item={item} chatId={chatId} />
        ))}
      </ul>
      {query.hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 self-start"
          disabled={query.isLoadingMore}
          onClick={query.loadMore}
        >
          {query.isLoadingMore ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  );
}

/** One pull request: its reference, then how and when the chats came to it. */
function WorkItemRow({ item, chatId }: { item: WorkItem; chatId: string | undefined }) {
  const url = pullRequestUrl(item.ref.id);
  const detail = [
    ...itemRelations(item.links),
    dayWords(item.firstRecordedOn),
    ...(chatId !== undefined && fromSpinOffsOnly(item, chatId) ? ['In a spin-off'] : []),
  ];
  const body = (
    <>
      <GitPullRequest
        aria-hidden
        className="text-muted-foreground size-(--size-icon-sm) shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm" data-slot="work-item-text">
          {item.text}
        </span>
        {/* Wraps between its parts rather than truncating: "In a spin-off" at
            its end is the part a narrow panel would cut. */}
        <span className="text-muted-foreground text-xs" data-slot="work-item-detail">
          {detail.map((part, index) => (
            <span key={part} className="whitespace-nowrap">
              {index > 0 && ' · '}
              {part}
            </span>
          ))}
        </span>
      </span>
    </>
  );
  const rowClass = 'flex min-h-11 items-center gap-2 rounded-md px-2 py-1 md:min-h-10';
  return (
    <li data-slot={WORK_ITEM_ROW_SLOT}>
      {url === null ? (
        <div className={rowClass}>{body}</div>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(rowClass, 'focus-ring hover:bg-muted/50 transition-colors')}
        >
          {body}
          <ArrowUpRight
            aria-hidden
            className="text-muted-foreground/70 size-(--size-icon-xs) shrink-0"
          />
          <span className="sr-only">(opens GitHub)</span>
        </a>
      )}
    </li>
  );
}
