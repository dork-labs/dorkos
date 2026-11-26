/**
 * The chats a row started, as a tree (W5, DOR-4971): an "N spin-offs" toggle
 * under the row, closed until asked, then each chat under the one that started
 * it, every level with a toggle of its own.
 *
 * Opening the fold reads the chat's tree (`chat_tree`). Until it answers, or
 * if it can't, the fold draws the spin-offs the list already holds.
 *
 * @module features/chat-list/ui/ChatTreeFold
 */
import { useEffect, useMemo, useRef, type Ref } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { SIDEBAR_SECTION_ACTION_ATTRIBUTE } from '@/layers/shared/model';
import { SidebarMenu, SidebarRow } from '@/layers/shared/ui';
import { useChatTree, workGraphKeys } from '@/layers/entities/work-graph';
import type { FoldedSpinOff } from '../model/build-chat-list';
import { buildChatTree, chatIdsIn, type ChatTreeNode } from '../model/build-chat-tree';
import { revealKeyFor, useReveal } from '../model/use-reveal';
import { CHAT_LIST_ROW_SLOT, CHAT_LIST_SPIN_OFF_TOGGLE_SLOT, ROW_INSET } from './chat-row-parts';
import { StatusDot } from './StatusDot';

/**
 * The deepest level that still steps in. Below it the rows keep that inset,
 * so a deep chain still fits a phone's width.
 */
const MAX_INDENT_DEPTH = 4;

/** What opening a chat in the tree needs, handed down every level. */
interface TreeActions {
  activeSessionId: string | null;
  search: string;
  onOpen: (sessionId: string) => void;
  onOpenOther: ((sessionId: string) => void) | undefined;
  registerRow: (sessionId: string) => Ref<HTMLButtonElement>;
}

/** Props for {@link ChatTreeFold}. */
export interface ChatTreeFoldProps {
  /** The row's chat: the top of the tree. */
  hostId: string;
  /** The row's title, for the toggle's name. */
  parentTitle: string;
  /** The row's folded spin-offs, from the list, oldest first. */
  spinOffs: FoldedSpinOff[];
  /** Every chat in the list, with what it is doing. */
  byId: ReadonlyMap<string, FoldedSpinOff>;
  /** The chat open on the chat page. */
  activeSessionId: string | null;
  /** The current search text: a fold holding a match opens for it. */
  search: string;
  /** Open a chat this list holds. */
  onOpen: (sessionId: string) => void;
  /** Open a chat this list does not hold. Without it, such chats do not open. */
  onOpenOther?: (sessionId: string) => void;
  /** Hands the list each row button, so a modified `↵` knows which chat it is on. */
  registerRow: (sessionId: string) => Ref<HTMLButtonElement>;
}

/**
 * The toggle under a row and the tree of chats it started.
 *
 * @param props - The row, its spin-offs, and what opening a chat does.
 */
export function ChatTreeFold({
  hostId,
  parentTitle,
  spinOffs,
  byId,
  activeSessionId,
  search,
  onOpen,
  onOpenOther,
  registerRow,
}: ChatTreeFoldProps) {
  const spinOffIds = spinOffs.map((spinOff) => spinOff.session.id);
  // The open chat or a search match is never hidden behind a closed toggle.
  const [open, setOpen] = useReveal(revealKeyFor(spinOffIds, activeSessionId, search));
  const tree = useChatTree(hostId, open);
  useRefreshOnNewSpinOff(hostId, spinOffIds.join('\n'));

  const pages = tree.data?.pages ?? null;
  const model = useMemo(() => buildChatTree({ spinOffs, pages, byId }), [spinOffs, pages, byId]);
  const more = tree.hasNextPage ? '+' : '';
  const label = model.count === 1 && !more ? '1 spin-off' : `${model.count}${more} spin-offs`;
  const actions: TreeActions = { activeSessionId, search, onOpen, onOpenOther, registerRow };

  return (
    <div>
      <FoldToggle
        open={open}
        onToggle={() => setOpen((previous) => !previous)}
        label={label}
        name={`${label} from ${parentTitle}`}
      />
      {open && (
        <>
          <TreeLevel
            nodes={model.nodes}
            depth={1}
            listName={`Spin-offs from ${parentTitle}`}
            actions={actions}
          />
          {tree.hasNextPage && (
            <button
              type="button"
              data-slot="chat-tree-more"
              {...{ [SIDEBAR_SECTION_ACTION_ATTRIBUTE]: '' }}
              disabled={tree.isFetchingNextPage}
              onClick={() => void tree.fetchNextPage()}
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground focus-ring text-2xs ml-5 flex min-h-6 items-center rounded-md px-1 max-md:min-h-11"
            >
              {tree.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          )}
          {model.truncated && (
            <p
              data-slot="chat-tree-truncated"
              className="text-sidebar-foreground/50 text-2xs ml-5 pb-1"
            >
              Some chats aren’t shown.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Refresh the row's tree when the list gains or loses one of its spin-offs: a
 * chat just started another, and the tree read has not heard yet.
 *
 * @param hostId - The row's chat.
 * @param signature - The list's spin-off ids, joined.
 */
function useRefreshOnNewSpinOff(hostId: string, signature: string): void {
  const queryClient = useQueryClient();
  const seen = useRef(signature);
  useEffect(() => {
    if (seen.current === signature) return;
    seen.current = signature;
    void queryClient.invalidateQueries({ queryKey: workGraphKeys.tree(hostId) });
  }, [hostId, signature, queryClient]);
}

/** An "N spin-offs" toggle: its chevron starts where the title above it starts. */
function FoldToggle({
  open,
  onToggle,
  label,
  name,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  name: string;
}) {
  return (
    <button
      type="button"
      data-slot={CHAT_LIST_SPIN_OFF_TOGGLE_SLOT}
      {...{ [SIDEBAR_SECTION_ACTION_ATTRIBUTE]: '' }}
      aria-expanded={open}
      aria-label={name}
      onClick={onToggle}
      className="text-sidebar-foreground/60 hover:text-sidebar-foreground focus-ring text-2xs ml-2 flex min-h-6 items-center gap-1 rounded-md pr-2 max-md:min-h-11"
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-(--size-icon-xs) transition-transform duration-150',
          open && 'rotate-90'
        )}
      />
      {label}
    </button>
  );
}

/** One level of the tree, stepped in from the level above while there is room. */
function TreeLevel({
  nodes,
  depth,
  listName,
  actions,
}: {
  nodes: ChatTreeNode[];
  depth: number;
  listName: string;
  actions: TreeActions;
}) {
  return (
    <SidebarMenu
      aria-label={listName}
      data-depth={depth}
      // Space under the whole tree only: nested levels each adding theirs
      // stacked into a gap after a deep branch.
      className={cn('gap-0.5', depth === 1 && 'pb-1', depth <= MAX_INDENT_DEPTH && 'pl-3')}
    >
      {nodes.map((node) => (
        <TreeNodeRow key={node.key} node={node} depth={depth} actions={actions} />
      ))}
    </SidebarMenu>
  );
}

/** The chats one chat in the tree started, behind a toggle of their own. */
function NodeChildren({
  node,
  depth,
  actions,
}: {
  node: ChatTreeNode;
  depth: number;
  actions: TreeActions;
}) {
  const [open, setOpen] = useReveal(
    revealKeyFor(chatIdsIn(node.children), actions.activeSessionId, actions.search)
  );
  const count = node.children.length;
  const label = count === 1 ? '1 spin-off' : `${count} spin-offs`;
  return (
    <div>
      <FoldToggle
        open={open}
        onToggle={() => setOpen((previous) => !previous)}
        label={label}
        name={`${label} from ${node.title}`}
      />
      {open && (
        <TreeLevel
          nodes={node.children}
          depth={depth + 1}
          listName={`Spin-offs from ${node.title}`}
          actions={actions}
        />
      )}
    </div>
  );
}

/** One chat in the tree: a row that opens it, or its name and state when it can't open. */
function TreeNodeRow({
  node,
  depth,
  actions,
}: {
  node: ChatTreeNode;
  depth: number;
  actions: TreeActions;
}) {
  const children =
    node.children.length > 0 ? <NodeChildren node={node} depth={depth} actions={actions} /> : null;
  const detail = node.detail !== null && (
    <span data-slot="chat-list-spin-off-status" className="text-sidebar-foreground/50 text-2xs">
      {node.status !== null && <StatusDot status={node.status} decorative />}
      {node.detail}
    </span>
  );
  const open = opener(node, actions);
  if (open !== null && node.chatId !== null) {
    return (
      <SidebarRow
        dataSlot={CHAT_LIST_ROW_SLOT}
        // Only a chat this list holds answers `⇧↵`: forking another agent's
        // chat would copy it into this agent's folder.
        {...(node.kind === 'chat' ? { buttonRef: actions.registerRow(node.chatId) } : {})}
        title={node.title}
        className={ROW_INSET}
        isActive={node.chatId === actions.activeSessionId}
        onSelect={open}
        trailing={detail || undefined}
        {...(children ? { expansion: children } : {})}
      />
    );
  }
  return (
    <li data-slot="chat-tree-node" data-kind={node.kind} className="list-none">
      {/* The right gutter a row keeps for its menu, so this row's state lines
          up with the states of the rows that open (`SIDEBAR_MENU_GUTTER`). */}
      <div className="text-sidebar-foreground/60 flex min-h-7 min-w-0 items-center gap-2 rounded-md py-1 pr-7 pl-2 text-xs max-md:min-h-9 max-md:pr-11">
        {/* Both yield on a narrow screen, the state at half the rate: it is
            what this row is for. */}
        <span className="min-w-0 shrink truncate">{node.title}</span>
        {detail && <span className="ml-auto min-w-0 shrink-[0.5] truncate">{detail}</span>}
      </div>
      {children}
    </li>
  );
}

/**
 * What pressing a chat in the tree does, or null when it does not open: a
 * chat this list holds opens here, another one through `onOpenOther`, and a
 * chat that never ran, or that you may not read, does not open.
 */
function opener(node: ChatTreeNode, actions: TreeActions): (() => void) | null {
  const { chatId } = node;
  if (!node.opens || chatId === null) return null;
  if (node.kind === 'chat') return () => actions.onOpen(chatId);
  const other = actions.onOpenOther;
  return other === undefined ? null : () => other(chatId);
}
