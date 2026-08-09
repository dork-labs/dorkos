import { MessagesSquare } from 'lucide-react';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { SectionHeader, SidebarGroup, SidebarMenu, SidebarMenuItem } from '@/layers/shared/ui';
import { useRovingFocus } from '@/layers/shared/model';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  isSectionCollapsed,
  setSectionCollapsed,
} from '@/layers/entities/config';
import { buildThreadsHeaderMenuNodes } from '../SectionHeaderMenuItems';
import { ThreadRow } from './ThreadRow';

interface ThreadsSectionProps {
  /** The reader's threads, most recent activity first, as the server ordered them. */
  threads: ThreadSummary[];
  /** Set when the thread list could not be read. `null` when it read fine. */
  error: Error | null;
  /** The thread on screen, so the matching row reads as current. */
  activeThreadId: string | null;
  /** Open a thread — its room, with its panel showing. */
  onSelectThread: (thread: ThreadSummary) => void;
}

/**
 * The sidebar's "Threads" section: every thread this person started or replied
 * in, wherever it lives, newest first.
 *
 * **It sits above Channels because it is the answer to a question the channel
 * list cannot answer.** A thread is a relation between entries inside one room
 * (ADR 260728-022013), so before this section the only way back to one was to
 * remember which room it was in and scroll for it. Threads stopped being rooms
 * and fell out of the sidebar structurally; this is where they come back.
 *
 * **Membership is participation, and there is no follow list.** You are in a
 * thread because you started it or answered in it. Follow/unfollow was weighed
 * and deferred — it is a persisted preference and a new table — and the note it
 * left behind is that it is the escape valve for when threads get noisy enough
 * to need one (spec `room-messaging-design` §3).
 *
 * Collapsible and persisted via `ui.sidebar.sections.threads`, matching Channels
 * and Direct messages. Unlike those two the section is HIDDEN when it is empty:
 * they are places you can make and so are worth advertising, while a thread is
 * something that happens to you — an empty Threads header is an instruction
 * nobody can follow, and it would greet every new install with a section that
 * cannot be filled on purpose.
 */
export function ThreadsSection({
  threads,
  error,
  activeThreadId,
  onSelectThread,
}: ThreadsSectionProps) {
  const threadsCollapsed = isSectionCollapsed(useSidebarPrefs(), 'threads');
  const { update } = useUpdateSidebarPrefs();
  const roving = useRovingFocus({
    onCollapse: () =>
      !threadsCollapsed && update((prev) => setSectionCollapsed(prev, 'threads', true)),
    onExpand: () => threadsCollapsed && update((prev) => setSectionCollapsed(prev, 'threads', false)),
  });

  // Nothing to say, so nothing is drawn — and that includes the first load,
  // which is why there are no skeletons here. Channels and Direct messages can
  // afford them because those sections are always present; this one is not, so
  // a placeholder would push the whole sidebar down and then take it back on
  // every install that has no threads, which is most of them at first.
  if (!error && threads.length === 0) return null;

  const toggleCollapsed = () =>
    update((prev) => setSectionCollapsed(prev, 'threads', !isSectionCollapsed(prev, 'threads')));

  return (
    <SidebarGroup className="px-0" {...roving}>
      <SectionHeader
        label="Threads"
        icon={MessagesSquare}
        collapsed={threadsCollapsed}
        onToggle={toggleCollapsed}
        controlsId="sidebar-section-threads"
        nodes={buildThreadsHeaderMenuNodes({
          collapsed: threadsCollapsed,
          onToggleCollapsed: toggleCollapsed,
        })}
      />

      {!threadsCollapsed && (
        <SidebarMenu id="sidebar-section-threads">
          {error ? (
            <SidebarMenuItem>
              <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs">
                Couldn&apos;t load your threads. They&apos;re still there — reload to try again.
              </p>
            </SidebarMenuItem>
          ) : (
            threads.map((thread) => (
              <ThreadRow
                key={`${thread.roomId}:${thread.rootEntryId}`}
                thread={thread}
                isActive={thread.rootEntryId === activeThreadId}
                onSelect={() => onSelectThread(thread)}
              />
            ))
          )}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
