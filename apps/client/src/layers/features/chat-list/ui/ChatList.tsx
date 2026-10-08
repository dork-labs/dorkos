/**
 * One agent's chats: the one list Profile → Sessions and Switch session both
 * draw (spec `your-activity-first` D11).
 *
 * What needs you comes first, then what is running, then the rest by when you
 * last used them. Spin-offs fold under the chat that started them, automated
 * chats fold into one group at the bottom, and nothing urgent is ever folded
 * (D14). The arrangement is `buildChatList`, a pure function; this component
 * draws it and owns the keys.
 *
 * @module features/chat-list/ui/ChatList
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Plus, Search } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import {
  SIDEBAR_ROW_ATTRIBUTE,
  SIDEBAR_SECTION_ACTION_ATTRIBUTE,
  useRovingFocus,
} from '@/layers/shared/model';
import {
  Button,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  SidebarMenu,
} from '@/layers/shared/ui';
import { useAgentSessions, useRenameSession } from '@/layers/entities/session';
import {
  buildChatList,
  CHAT_LIST_SORTS,
  type ChatListSort,
  type ChatRow,
} from '../model/build-chat-list';
import { useChatSignals } from '../model/use-chat-signals';
import { useForkChat } from '../model/use-fork-chat';
import { ChatListRow } from './ChatListRow';

/** The `data-slot` on the list's root, so a test can prove which list a surface drew. */
export const CHAT_LIST_SLOT = 'chat-list';

/** What each sort is called on its control. */
const SORT_LABEL: Record<ChatListSort, string> = {
  'for-you': 'For you',
  activity: 'Recent activity',
  started: 'Started',
};

/** Props for {@link ChatList}. */
export interface ChatListProps {
  /** The agent's directory: whose chats these are. */
  agentPath: string | null;
  /** What the agent is called, for the empty and error states. */
  agentName: string;
  /** Open a chat. */
  onOpenChat: (sessionId: string) => void;
  /** Start a new chat with this agent: the New chat button and `⌘↵`. */
  onNewChat: () => void;
  /**
   * Show a title search above the list. Profile → Sessions turns it on: it is
   * where you arrive knowing what you are looking for. Switch session leaves it
   * off: it is a quick pick by keyboard, and ⌘K already searches chats.
   */
  searchable?: boolean;
  /**
   * Put focus on the open chat's row, else the first row, once the list has
   * rows. Switch session asks for this so `↵` continues straight away.
   */
  autoFocusRow?: boolean;
  /**
   * Chats to draw instead of the agent's own: for the Dev Playground and
   * tests. The live signals still come from the app's stores.
   */
  sessions?: readonly Session[];
  /** Extra classes on the root. */
  className?: string;
}

/**
 * An agent's chats, sorted for choosing one, with a sort control and a New chat
 * button on top.
 *
 * Keys: `↑`/`↓` walk the rows and toggles, `↵` opens a chat, `⌘↵` starts a new
 * one, `⇧↵` forks the chat you are on.
 *
 * @param props - Whose chats, and what opening and starting one do.
 */
export function ChatList({
  agentPath,
  agentName,
  onOpenChat,
  onNewChat,
  searchable = false,
  autoFocusRow = false,
  sessions: sessionsOverride,
  className,
}: ChatListProps) {
  const query = useAgentSessions(sessionsOverride ? null : agentPath);
  const sessions = sessionsOverride ?? query.sessions;
  const signals = useChatSignals(sessions);
  const [sort, setSort] = useState<ChatListSort>('for-you');
  const [search, setSearch] = useState('');
  const [automatedOpen, setAutomatedOpen] = useState(false);
  const renameSession = useRenameSession(agentPath);
  const fork = useForkChat(agentPath, onOpenChat);

  const model = useMemo(
    () => buildChatList(sessions, { sort, query: search, ...signals }),
    [sessions, sort, search, signals]
  );

  const rename = useCallback(
    (sessionId: string, title: string) => renameSession.mutate({ sessionId, title }),
    [renameSession]
  );

  // Which chat a row button belongs to, so a modified `↵` knows which row it is
  // on. Keyed by ELEMENT in a WeakMap: a row moving between sections mounts its
  // new node before the old one detaches, and an id-keyed map cleaned up on
  // detach would lose the entry the fresh node just wrote.
  const rowSessions = useRef(new WeakMap<HTMLButtonElement, string>());
  const registerRow = useCallback(
    (sessionId: string) => (element: HTMLButtonElement | null) => {
      if (element !== null) rowSessions.current.set(element, sessionId);
    },
    []
  );

  /**
   * `⌘↵` and `⇧↵`, caught before the browser turns them into a click. A
   * focused button activates on Enter whatever modifiers are held, so both
   * would open the focused chat unless taken here. Plain `↵` is the row's own.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter') return;
      if (event.target instanceof HTMLInputElement) return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        onNewChat();
        return;
      }
      if (!event.shiftKey) return;
      const sessionId =
        event.target instanceof HTMLButtonElement
          ? rowSessions.current.get(event.target)
          : undefined;
      if (sessionId === undefined) return;
      event.preventDefault();
      void fork(sessionId);
    },
    [fork, onNewChat]
  );

  const { ref: rovingRef, onKeyDown: onRovingKeyDown } = useRovingFocus();
  const listRef = useRef<HTMLDivElement | null>(null);
  const setListRef = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
      rovingRef(element);
    },
    [rovingRef]
  );

  const hasRows = model.sections.length > 0 || model.automated.length > 0;
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!autoFocusRow || focusedOnce.current || !hasRows) return;
    focusedOnce.current = true;
    // The open chat's row when it is in the list, else the first row: exactly
    // where `↵` should land, and the same row the roving stop rests on.
    const list = listRef.current;
    const target =
      list?.querySelector<HTMLElement>(`[${SIDEBAR_ROW_ATTRIBUTE}][aria-current="page"]`) ??
      list?.querySelector<HTMLElement>(`[${SIDEBAR_ROW_ATTRIBUTE}]`);
    target?.focus();
  }, [autoFocusRow, hasRows]);

  const isLoading = !sessionsOverride && query.isLoading && sessions.length === 0;
  const isError = !sessionsOverride && query.isError && sessions.length === 0;

  const rowProps = {
    activeSessionId: query.activeSessionId ?? null,
    showRuntime: model.showRuntime,
    onOpen: onOpenChat,
    onFork: (sessionId: string) => void fork(sessionId),
    onRename: rename,
    registerRow,
  };
  const renderRows = (rows: ChatRow[]) =>
    rows.map((row) => <ChatListRow key={row.session.id} row={row} {...rowProps} />);

  return (
    <div
      data-slot={CHAT_LIST_SLOT}
      className={cn('flex min-h-0 flex-col gap-2', className)}
      onKeyDown={handleKeyDown}
    >
      {searchable && model.total > 0 && (
        <div className="relative shrink-0">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-8 pl-7 text-sm"
          />
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2">
        {model.total > 0 && (
          <SegmentedControl
            aria-label="Sort chats"
            value={sort}
            onValueChange={(next) => setSort(next as ChatListSort)}
            className="w-auto min-w-0 flex-1 sm:flex-none"
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
          className="ml-auto shrink-0"
          onClick={onNewChat}
          data-slot="chat-list-new"
        >
          <Plus className="size-3.5" aria-hidden />
          New chat
        </Button>
      </div>

      {isLoading && (
        <div className="flex flex-col gap-1.5" aria-label="Loading chats">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-3/4" />
        </div>
      )}

      {isError && (
        <p className="text-muted-foreground px-2 py-6 text-center text-xs">
          Couldn’t read {agentName}’s chats.
        </p>
      )}

      {!isLoading && !isError && model.total === 0 && (
        <p className="text-muted-foreground px-2 py-6 text-center text-xs">
          No chats with {agentName} yet.
        </p>
      )}

      {model.total > 0 && model.matched === 0 && (
        <p className="text-muted-foreground px-2 py-6 text-center text-xs">
          No chat matches “{search.trim()}”.
        </p>
      )}

      {hasRows && (
        <div
          ref={setListRef}
          onKeyDown={onRovingKeyDown}
          className="min-h-0 flex-1 overflow-y-auto"
          data-slot="chat-list-rows"
        >
          {model.sections.map((section, index) => (
            <section
              key={section.id}
              aria-label={section.label ?? 'Chats'}
              data-section={section.id}
            >
              {section.label !== null && (
                <SectionHeading first={index === 0}>{section.label}</SectionHeading>
              )}
              <SidebarMenu className="gap-0.5">{renderRows(section.rows)}</SidebarMenu>
            </section>
          ))}

          {model.automated.length > 0 && (
            <section aria-label="Automated" data-section="automated">
              <button
                type="button"
                data-slot="chat-list-automated-toggle"
                {...{ [SIDEBAR_SECTION_ACTION_ATTRIBUTE]: '' }}
                aria-expanded={automatedOpen}
                onClick={() => setAutomatedOpen((previous) => !previous)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-sidebar-ring text-3xs mt-1 flex min-h-7 w-full items-center gap-1 rounded-md px-2 pt-2 pb-1 font-semibold tracking-[0.05em] uppercase outline-hidden focus-visible:ring-2 max-md:min-h-11"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'size-3 transition-transform duration-150',
                    automatedOpen && 'rotate-90'
                  )}
                />
                Automated
                <span className="font-normal tabular-nums">{model.automated.length}</span>
              </button>
              {automatedOpen && (
                <SidebarMenu className="gap-0.5">{renderRows(model.automated)}</SidebarMenu>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** A section's heading, in the small caps every list heading here wears. */
function SectionHeading({ children, first }: { children: React.ReactNode; first: boolean }) {
  return (
    <h3
      className={cn(
        'text-muted-foreground text-3xs px-2 pb-1 font-semibold tracking-[0.05em] uppercase',
        first ? 'pt-1' : 'pt-3'
      )}
    >
      {children}
    </h3>
  );
}
