/**
 * One chat in the list, and the spin-offs folded under it.
 *
 * Built on `SidebarRow`, the app's one row, without its glyph column: the
 * trailing slot says where a chat came from and when you last used it, and the
 * second line carries a status dot with the live verb or what it needs (spec
 * `your-activity-first` D12).
 *
 * @module features/chat-list/ui/ChatListRow
 */
import type { Ref } from 'react';
import { GitFork, Link, Pencil } from 'lucide-react';
import { cn, dorkShareUrl, formatCompactAge } from '@/layers/shared/lib';
import { SidebarRow, STATUS_TONE_TEXT, type SidebarMenuNode } from '@/layers/shared/ui';
import { RuntimeMark } from '@/layers/entities/runtime';
import {
  SessionOriginMark,
  SessionVerbLine,
  sessionDisplayTitle,
  useInlineRename,
} from '@/layers/entities/session';
import type { ChatRow, ChatStatus, FoldedSpinOff } from '../model/build-chat-list';
import { ChatTreeFold } from './ChatTreeFold';
import { CHAT_LIST_ROW_SLOT, ROW_INSET } from './chat-row-parts';
import { StatusDot } from './StatusDot';

/** Props for {@link ChatListRow}. */
export interface ChatListRowProps {
  /** The row to draw. */
  row: ChatRow;
  /** The chat currently open on the chat page. */
  activeSessionId: string | null;
  /** Show which runtime the chat runs on (only when the list mixes them). */
  showRuntime: boolean;
  /** Open a chat: this one, or one of its spin-offs. */
  onOpen: (sessionId: string) => void;
  /** Fork a chat into a copy and open the copy. */
  onFork: (sessionId: string) => void;
  /** Give a chat a new title. */
  onRename: (sessionId: string, title: string) => void;
  /** Put a chat's full `/r/` link on the clipboard (DOR-5046). */
  onCopyLink: (link: string) => void;
  /** Hands the list each row button, so a modified `↵` knows which chat it is on. */
  registerRow: (sessionId: string) => Ref<HTMLButtonElement>;
  /** The current search text: a fold holding a match opens for it. */
  search: string;
  /** Every chat in the list, with what it is doing: the chat tree names chats by it. */
  byId: ReadonlyMap<string, FoldedSpinOff>;
  /**
   * Open a chat this list does not hold, such as another agent's, found in a
   * chat tree. Without it those chats are named but do not open.
   */
  onOpenOther?: (sessionId: string) => void;
}

/**
 * One chat, with its rename, fork and copy-link menu and its folded spin-offs.
 *
 * @param props - The row model and what its actions do.
 */
export function ChatListRow({
  row,
  activeSessionId,
  showRuntime,
  onOpen,
  onFork,
  onRename,
  onCopyLink,
  registerRow,
  search,
  byId,
  onOpenOther,
}: ChatListRowProps) {
  const { session } = row;
  const title = sessionDisplayTitle(session.title);
  const {
    isRenaming,
    renameValue,
    setRenameValue,
    inputRef,
    start: startRename,
    commit: commitRename,
    handleKeyDown: handleRenameKeyDown,
  } = useInlineRename({
    value: session.title,
    onCommit: (next) => onRename(session.id, next),
  });
  const isCurrent = session.id === activeSessionId;

  const menuNodes: SidebarMenuNode[] = [
    {
      kind: 'action',
      id: 'rename',
      label: 'Rename',
      icon: Pencil,
      opensInput: true,
      run: startRename,
    },
    { kind: 'action', id: 'fork', label: 'Fork', icon: GitFork, run: () => onFork(session.id) },
  ];
  const link = dorkShareUrl('chat', session.id);
  if (link !== null) {
    menuNodes.push({
      kind: 'action',
      id: 'copy-link',
      label: 'Copy link',
      icon: Link,
      run: () => onCopyLink(link),
    });
  }

  return (
    <SidebarRow
      dataSlot={CHAT_LIST_ROW_SLOT}
      buttonRef={registerRow(session.id)}
      title={title}
      className={ROW_INSET}
      isActive={isCurrent}
      onSelect={() => onOpen(session.id)}
      menuNodes={menuNodes}
      actionsLabel={`${title} actions`}
      menuWidth="w-44"
      {...(hasSecondLine(row)
        ? { reservesVerbLine: true, secondLine: <SecondLine row={row} /> }
        : {})}
      trailing={
        <RowMeta
          session={row.session}
          lastUsedAt={row.lastUsedAt}
          showRuntime={showRuntime}
          isCurrent={isCurrent}
        />
      }
      editor={
        isRenaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            aria-label={`Rename ${title}`}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={commitRename}
            // Right-clicking to paste must open the browser's edit menu, not
            // the row's own, which would blur the field and commit half a name.
            onContextMenu={(event) => event.stopPropagation()}
            className="bg-background text-foreground focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1"
          />
        ) : undefined
      }
      {...(row.spinOffs.length > 0
        ? {
            expansion: (
              <ChatTreeFold
                hostId={session.id}
                parentTitle={title}
                spinOffs={row.spinOffs}
                byId={byId}
                activeSessionId={activeSessionId}
                search={search}
                onOpen={onOpen}
                {...(onOpenOther === undefined ? {} : { onOpenOther })}
                registerRow={registerRow}
              />
            ),
          }
        : {})}
    />
  );
}

/** Whether a row earns its second line: a verb, a need, or where it started. */
function hasSecondLine(row: ChatRow): boolean {
  return row.status !== 'idle' || row.startedFrom !== null;
}

/** The words a status says on a row's second line, when it says any. */
const STATUS_WORDS: Partial<Record<ChatStatus, string>> = {
  'needs-you': 'Needs you',
  'out-of-usage': 'Out of usage',
  failed: 'Stopped with an error',
};

/** The tone those words wear. */
const STATUS_WORD_TONE: Partial<Record<ChatStatus, string>> = {
  'needs-you': STATUS_TONE_TEXT.warning,
  'out-of-usage': STATUS_TONE_TEXT.error,
  failed: STATUS_TONE_TEXT.error,
};

/**
 * The second line: what the chat needs or is doing, then where it started.
 *
 * Room is left after these two for a later sender stamp (DOR-2790): it is one
 * more span in the same line.
 */
function SecondLine({ row }: { row: ChatRow }) {
  const words = STATUS_WORDS[row.status];
  const parts: React.ReactNode[] = [];
  if (words !== undefined) {
    parts.push(
      <span key="status" className={cn('font-medium', STATUS_WORD_TONE[row.status])}>
        <StatusDot status={row.status} decorative />
        {words}
      </span>
    );
  } else if (row.status === 'running') {
    parts.push(
      <span key="status" data-slot="chat-list-verb">
        <StatusDot status={row.status} />
        <SessionVerbLine sessionId={row.session.id} lifecycle={row.lifecycle} />
      </span>
    );
  }
  if (row.startedFrom !== null) {
    parts.push(<span key="from">Started from {row.startedFrom}</span>);
  }
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <span aria-hidden> · </span>}
          {part}
        </span>
      ))}
    </>
  );
}

/** Under a minute ago, which the compact age would spell `0m`. */
const ONE_MINUTE_MS = 60_000;

/**
 * When you last used a chat, compact: `just now` inside the first minute (the
 * app's time rule; `0m` reads as a glitch), then `5m`, `2h`, `3d`.
 *
 * @param iso - When you last opened or wrote in the chat.
 */
function lastUsedLabel(iso: string): string {
  return Date.now() - new Date(iso).getTime() < ONE_MINUTE_MS ? 'just now' : formatCompactAge(iso);
}

/**
 * The trailing slot: where the chat came from, what it runs on (only when the
 * list mixes runtimes), when you last used it, and whether it is the chat
 * open right now. Read-only: it sits inside the row's own button.
 */
function RowMeta({
  session,
  lastUsedAt,
  showRuntime,
  isCurrent,
}: {
  session: ChatRow['session'];
  lastUsedAt: string | null;
  showRuntime: boolean;
  isCurrent: boolean;
}) {
  return (
    <>
      {/* Only a room or a schedule (D12). A spin-off says where it started in
          words, and any other origin is a fact about plumbing, not a choice. */}
      {(session.origin === 'room' || session.origin === 'task') && (
        <SessionOriginMark
          origin={session.origin}
          {...(session.originLabel === undefined ? {} : { label: session.originLabel })}
          className="text-sidebar-foreground/50"
        />
      )}
      {showRuntime && (
        <RuntimeMark
          type={session.runtime}
          {...(session.model === undefined ? {} : { model: session.model })}
          className="text-sidebar-foreground/50"
        />
      )}
      {lastUsedAt !== null && (
        <time
          dateTime={lastUsedAt}
          title={new Date(lastUsedAt).toLocaleString()}
          data-slot="chat-list-last-used"
          className="text-sidebar-foreground/50 text-2xs tabular-nums"
        >
          You · {lastUsedLabel(lastUsedAt)}
        </time>
      )}
      {isCurrent && (
        <span
          data-slot="chat-list-current"
          className="border-sidebar-border text-sidebar-foreground/70 text-3xs rounded border px-1 py-px leading-none"
        >
          current
        </span>
      )}
    </>
  );
}
