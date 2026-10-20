/**
 * The Threads page: every thread you are in, across every room, newest reply
 * first.
 *
 * @module widgets/room-view/ui/threads/ThreadsPage
 */
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MessageSquareReply } from 'lucide-react';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { appRoutes } from '@/layers/shared/lib';
import { Button, EmptyState, PageContainer, PageHeading, Skeleton } from '@/layers/shared/ui';
import { useRoomOpenThreadStore, useTeamRoom, useThreads } from '@/layers/entities/room';
import { useRoomAgentDirectory } from '../../model/agent-info-context';
import { useFreshThreadRooms } from '../../model/use-fresh-thread-rooms';
import { useShownThreads } from '../../model/use-shown-threads';
import { ThreadCard } from './ThreadCard';

/**
 * Open one thread in the room it lives in.
 *
 * The STORE is written as well as the address: the room view treats its own
 * store as the source of truth and seeds it from `?thread=` only on the way
 * into a room, so writing it is what makes the panel open whichever way the
 * room was reached. `focusComposer` stays false — opening a thread is a request
 * to read, and on a phone the difference is whether a keyboard opens over what
 * you came to look at.
 *
 * #team opens on Home, because Home IS #team (spec `one-bar-header` §3.5).
 */
function useOpenThreadInRoom(): (thread: ThreadSummary) => void {
  const navigate = useNavigate();
  const teamRoomId = useTeamRoom().room?.id ?? null;
  return useCallback(
    (thread: ThreadSummary) => {
      useRoomOpenThreadStore.getState().openThread(thread.roomId, thread.rootEntryId, false);
      if (thread.roomId === teamRoomId) {
        void navigate({ ...appRoutes.home(), search: { thread: thread.rootEntryId } });
        return;
      }
      void navigate({
        ...appRoutes.channels(),
        search: { id: thread.roomId, thread: thread.rootEntryId },
      });
    },
    [navigate, teamRoomId]
  );
}

/** No threads yet — one shared array, so an empty read never rebuilds the list. */
const NO_THREADS: readonly ThreadSummary[] = [];

/**
 * Every thread you are in, as cards.
 *
 * The sidebar lists places, never threads, so this page is where a thread is
 * found: the server's order (newest reply first) is the order, and each card is
 * answerable where it stands.
 */
export function ThreadsPage() {
  const threads = useThreads();
  const agents = useRoomAgentDirectory();
  const openThread = useOpenThreadInRoom();
  const shown = useShownThreads(threads.data ?? NO_THREADS);
  const list = useRef<HTMLUListElement>(null);
  useFreshThreadRooms(threads.data);

  // The press that showed the last page took its own button away: hand focus
  // to the first card it added, at the control a keyboard reader would want.
  const { focusId, focused } = shown;
  useEffect(() => {
    if (focusId === null) return;
    const card = list.current?.querySelector<HTMLElement>(
      `[data-thread-root="${CSS.escape(focusId)}"]`
    );
    card?.querySelector<HTMLElement>('button')?.focus();
    focused();
  }, [focusId, focused]);

  return (
    <PageContainer width="reading">
      <header className="mb-4">
        {/* Not drawn: the bar overhead already says "Threads". Kept for the
            outline — the bar's title is a `nav` landmark, not a heading. */}
        <PageHeading>Threads</PageHeading>
      </header>
      {threads.isPending ? (
        <div className="flex flex-col gap-3" aria-busy data-testid="threads-loading">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-32 w-full rounded-lg" />
          ))}
        </div>
      ) : threads.isError ? (
        <div className="text-muted-foreground flex flex-col items-start gap-2 text-sm">
          <p>Couldn’t load your threads.</p>
          <Button variant="outline" size="sm" onClick={() => void threads.refetch()}>
            Try again
          </Button>
        </div>
      ) : threads.data.length === 0 ? (
        <EmptyState
          icon={MessageSquareReply}
          headline="No threads yet"
          description="Reply to a message in any channel or DM, and the thread shows up here."
        />
      ) : (
        <>
          <ul ref={list} className="flex flex-col gap-3" aria-label="Your threads">
            {shown.visible.map((thread) => (
              <li key={thread.rootEntryId}>
                <ThreadCard thread={thread} agents={agents} onOpen={openThread} />
              </li>
            ))}
          </ul>
          {shown.hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 self-start"
              onClick={shown.showMore}
            >
              Show more
            </Button>
          )}
        </>
      )}
    </PageContainer>
  );
}
