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
import { useState, type Ref } from 'react';
import { ChevronRight, GitFork, Pencil } from 'lucide-react';
import { cn, formatCompactAge } from '@/layers/shared/lib';
import { SIDEBAR_SECTION_ACTION_ATTRIBUTE } from '@/layers/shared/model';
import {
  SidebarMenu,
  SidebarRow,
  STATUS_DOT_LABEL,
  STATUS_TONE_TEXT,
  statusDotClass,
  type SidebarMenuNode,
} from '@/layers/shared/ui';
import { RuntimeMark } from '@/layers/entities/runtime';
import {
  SessionOriginMark,
  SessionVerbLine,
  sessionDisplayTitle,
  useInlineRename,
} from '@/layers/entities/session';
import type { ChatRow, ChatStatus, FoldedSpinOff } from '../model/build-chat-list';

/**
 * The `data-slot` every chat row answers to, folded spin-offs included.
 *
 * One name for every row, so a test or page object finds them without knowing
 * which section they landed in, which is exactly what the list decides.
 */
export const CHAT_LIST_ROW_SLOT = 'chat-list-row';

/**
 * A row's left inset: the same 8px the section headings and toggles use, so
 * row titles line up with them instead of the sidebar's glyph column.
 */
const ROW_INSET = 'pl-2';

/** The `data-slot` on the "N spin-offs" toggle under a chat. */
export const CHAT_LIST_SPIN_OFF_TOGGLE_SLOT = 'chat-list-spin-off-toggle';

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
  /** Hands the list each row button, so a modified `↵` knows which chat it is on. */
  registerRow: (sessionId: string) => Ref<HTMLButtonElement>;
}

/**
 * One chat, with its rename and fork menu and its folded spin-offs.
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
  registerRow,
}: ChatListRowProps) {
  const { session } = row;
  const title = sessionDisplayTitle(session.title);
  const rename = useInlineRename({
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
      run: rename.start,
    },
    { kind: 'action', id: 'fork', label: 'Fork', icon: GitFork, run: () => onFork(session.id) },
  ];

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
        rename.isRenaming ? (
          <input
            ref={rename.inputRef}
            value={rename.renameValue}
            aria-label={`Rename ${title}`}
            onChange={(event) => rename.setRenameValue(event.target.value)}
            onKeyDown={rename.handleKeyDown}
            onBlur={rename.commit}
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
              <SpinOffFold
                parentTitle={title}
                spinOffs={row.spinOffs}
                activeSessionId={activeSessionId}
                onOpen={onOpen}
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
        <StatusDot status={row.status} />
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
    parts.push(<span key="from">Started from {row.startedFrom.title}</span>);
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

/** The status word a folded spin-off shows. */
const SPIN_OFF_STATUS: Record<ChatStatus, string> = {
  running: 'Running',
  idle: 'Done',
  'needs-you': 'Needs you',
  'out-of-usage': 'Out of usage',
  failed: 'Error',
};

/**
 * The "N spin-offs" toggle under a chat, closed until asked, and the
 * spin-offs it holds, indented (D14 rule 1).
 */
function SpinOffFold({
  parentTitle,
  spinOffs,
  activeSessionId,
  onOpen,
  registerRow,
}: {
  parentTitle: string;
  spinOffs: FoldedSpinOff[];
  activeSessionId: string | null;
  onOpen: (sessionId: string) => void;
  registerRow: (sessionId: string) => Ref<HTMLButtonElement>;
}) {
  // A spin-off that is open on the chat page opens its fold, so the current
  // chat is never hidden behind a toggle.
  const [open, setOpen] = useState(() =>
    spinOffs.some((spinOff) => spinOff.session.id === activeSessionId)
  );
  const count = spinOffs.length;
  const label = count === 1 ? '1 spin-off' : `${count} spin-offs`;
  return (
    <div>
      <button
        type="button"
        data-slot={CHAT_LIST_SPIN_OFF_TOGGLE_SLOT}
        {...{ [SIDEBAR_SECTION_ACTION_ATTRIBUTE]: '' }}
        aria-expanded={open}
        aria-label={`${label} from ${parentTitle}`}
        onClick={() => setOpen((previous) => !previous)}
        // The chevron starts where the parent's title starts.
        className="text-sidebar-foreground/60 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring text-2xs ml-2 flex min-h-6 items-center gap-1 rounded-md pr-2 outline-hidden focus-visible:ring-2 max-md:min-h-11"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3 transition-transform duration-150', open && 'rotate-90')}
        />
        {label}
      </button>
      {open && (
        <SidebarMenu aria-label={`Spin-offs from ${parentTitle}`} className="gap-0.5 pb-1 pl-3">
          {spinOffs.map((spinOff) => (
            <SidebarRow
              key={spinOff.session.id}
              dataSlot={CHAT_LIST_ROW_SLOT}
              buttonRef={registerRow(spinOff.session.id)}
              title={sessionDisplayTitle(spinOff.session.title)}
              className={ROW_INSET}
              isActive={spinOff.session.id === activeSessionId}
              onSelect={() => onOpen(spinOff.session.id)}
              trailing={
                <span
                  data-slot="chat-list-spin-off-status"
                  className="text-sidebar-foreground/50 text-2xs"
                >
                  <StatusDot status={spinOff.status} />
                  {SPIN_OFF_STATUS[spinOff.status]}
                </span>
              }
            />
          ))}
        </SidebarMenu>
      )}
    </div>
  );
}

/** Which dot each status draws, if any. Idle draws none. */
const STATUS_DOT: Partial<Record<ChatStatus, 'working' | 'needs-you' | 'error'>> = {
  running: 'working',
  'needs-you': 'needs-you',
  'out-of-usage': 'error',
  failed: 'error',
};

/**
 * A dot beside the words that say what a chat is doing: running, needs you,
 * out of usage or stopped with an error. Idle draws none.
 *
 * Inline with the words rather than in a column of its own, so a settled row
 * spends no width on an empty slot and every title starts at the same edge
 * as the controls above the list.
 */
function StatusDot({ status }: { status: ChatStatus }) {
  const signal = STATUS_DOT[status];
  if (signal === undefined) return null;
  return (
    <span
      role="img"
      aria-label={STATUS_DOT_LABEL[signal]}
      data-status={status}
      className={cn(
        'mr-1.5 inline-block size-1.5 rounded-full align-middle',
        statusDotClass(signal)
      )}
    />
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
