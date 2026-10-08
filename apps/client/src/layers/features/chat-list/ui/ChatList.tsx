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
import type { Session } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { SIDEBAR_ROW_ATTRIBUTE, useRovingFocus } from '@/layers/shared/model';
import { Skeleton } from '@/layers/shared/ui';
import { useAgentSessions, useRenameSession } from '@/layers/entities/session';
import { buildChatList, type ChatListSort } from '../model/build-chat-list';
import { useChatListKeys } from '../model/use-chat-list-keys';
import { useChatSignals } from '../model/use-chat-signals';
import { useForkChat } from '../model/use-fork-chat';
import { ChatListSections, type SharedRowProps } from './ChatListSections';
import { ChatListToolbar } from './ChatListToolbar';

/** The `data-slot` on the list's root, so a test can prove which list a surface drew. */
export const CHAT_LIST_SLOT = 'chat-list';

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

  const forkChat = useCallback((sessionId: string) => void fork(sessionId), [fork]);
  const keys = useChatListKeys(onNewChat, forkChat);

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

  const rowProps: SharedRowProps = {
    activeSessionId: query.activeSessionId ?? null,
    showRuntime: model.showRuntime,
    onOpen: onOpenChat,
    onFork: forkChat,
    onRename: rename,
    registerRow: keys.registerRow,
    search,
  };
  // The roving container's own props, spread the way every sidebar section
  // spreads them: arrow keys walk rows and toggles.
  const rovingProps = { ref: setListRef, onKeyDown: onRovingKeyDown };

  return (
    // The keys are handled here, on the list's root, rather than on each row:
    // `⌘↵` works from the sort and New chat too. The root is not a control; the
    // rows inside it are real buttons, so this only catches what they bubble.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      data-slot={CHAT_LIST_SLOT}
      className={cn('flex min-h-0 flex-col gap-2', className)}
      onKeyDown={keys.onKeyDown}
    >
      <ChatListToolbar
        hasChats={model.total > 0}
        searchable={searchable}
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
        onNewChat={onNewChat}
      />

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
        <div {...rovingProps} className="min-h-0 flex-1 overflow-y-auto" data-slot="chat-list-rows">
          <ChatListSections model={model} rowProps={rowProps} />
        </div>
      )}
    </div>
  );
}
