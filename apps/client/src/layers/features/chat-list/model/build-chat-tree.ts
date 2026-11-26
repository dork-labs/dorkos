/**
 * The chats below one row, as a tree (W5, DOR-4971): each chat under the one
 * that started it, at any depth.
 *
 * Pure: the tree read's pages (`chat_tree`), or the list's own folded
 * spin-offs while those pages are not here, in; nested nodes out. The tree
 * read is the truth once it arrives. It also knows chats the list never
 * holds: one still starting, one that never started, one only a start record
 * proves, and a private chat kept only as a joint.
 *
 * @module features/chat-list/model/build-chat-tree
 */
import type { ChatTree, ChatTreeDescendant } from '@dorkos/shared/work-graph-reads';
import { sessionDisplayTitle } from '@/layers/entities/session';
import type { ChatStatus, FoldedSpinOff } from './build-chat-list';
import { launchingWords, neverStartedWords } from './chat-tree-words';

/**
 * What a node in the tree is.
 *
 * - `chat`: a chat this list holds. It opens.
 * - `elsewhere`: a chat that ran but is not in this list, such as another
 *   agent's. It opens by its id.
 * - `unknown`: only a start record proves it. It can't be opened, and that is
 *   what its row says.
 * - `launching`: waiting to start, or starting.
 * - `never-started`: its run ended before its turn began.
 * - `private`: a chat you may not read, kept because one you may hangs below.
 */
export type ChatTreeNodeKind =
  'chat' | 'elsewhere' | 'unknown' | 'launching' | 'never-started' | 'private';

/** One chat in the tree. */
export interface ChatTreeNode {
  /** Stable among its siblings: the chat's id, or a position for a private joint. */
  key: string;
  /** The chat's id, or null for a private joint. */
  chatId: string | null;
  /** What it is. */
  kind: ChatTreeNodeKind;
  /** The name the row shows. */
  title: string;
  /** The words after it: a status, or why it never started. Null for none. */
  detail: string | null;
  /** What a chat this list holds is doing, for its dot. Null for every other kind. */
  status: ChatStatus | null;
  /** Whether the row opens the chat. */
  opens: boolean;
  /** The chats it started, oldest first. */
  children: ChatTreeNode[];
}

/** The tree under one row. */
export interface ChatTreeModel {
  /** The chats the row started, oldest first, each with its own below it. */
  nodes: ChatTreeNode[];
  /** How many chats the tree holds, private joints left out. */
  count: number;
  /** True when the read left chats out: too deep, or too many. */
  truncated: boolean;
}

/** The word a chat this list holds shows beside its title. */
const STATUS_WORD: Record<ChatStatus, string> = {
  running: 'Running',
  idle: 'Done',
  'needs-you': 'Needs you',
  'out-of-usage': 'Out of usage',
  failed: 'Error',
};

/** The title of a chat the list has no title for. */
const NEW_CHAT = 'New chat';

/**
 * One node, from what the tree read says of it and what the list knows.
 *
 * @param entry - The tree read's entry.
 * @param index - Its place in the read, which keys a joint.
 * @param byId - Every chat in the list, with what it is doing.
 */
function nodeOf(
  entry: ChatTreeDescendant,
  index: number,
  byId: ReadonlyMap<string, FoldedSpinOff>
): ChatTreeNode {
  const base = { children: [] as ChatTreeNode[], status: null, opens: false };
  if (entry.chatId === null) {
    return {
      ...base,
      key: `private:${index}`,
      chatId: null,
      kind: 'private',
      title: 'A private chat',
      detail: null,
    };
  }
  const known = byId.get(entry.chatId);
  const title = known ? sessionDisplayTitle(known.session.title) : null;
  const { state } = entry;
  const node = { ...base, key: entry.chatId, chatId: entry.chatId };
  switch (state.kind) {
    case 'chat':
      return known
        ? {
            ...node,
            kind: 'chat',
            title: title ?? NEW_CHAT,
            detail: STATUS_WORD[known.status],
            status: known.status,
            opens: true,
          }
        : { ...node, kind: 'elsewhere', title: 'Another chat', detail: null, opens: true };
    case 'unknown':
      // The state is the name: "A chat" beside it said nothing, and on a phone
      // it was the part a deep row cut to "A c…".
      return { ...node, kind: 'unknown', title: 'Can’t be opened', detail: null };
    case 'launching':
      return {
        ...node,
        kind: 'launching',
        title: title ?? NEW_CHAT,
        detail: launchingWords(state.status),
      };
    case 'never-started':
      return {
        ...node,
        kind: 'never-started',
        title: title ?? NEW_CHAT,
        detail: neverStartedWords(state.reason),
      };
  }
}

/** One entry of the tree read, ready to hang: its node, its depth and its parent. */
interface TreeEntry {
  depth: number;
  parentId: string | null;
  node: ChatTreeNode;
}

/**
 * Hang the tree read's entries under their parents. A chat hangs under the
 * chat its `parentId` names. A chat under a private joint has no `parentId`,
 * so it hangs under the nearest joint, or chat, one level up before it: the
 * read is depth first, so that is the one, and it holds across pages. A depth
 * of 1 hangs under the row itself.
 *
 * @param entries - The read's entries, depth first, repeats already resolved.
 */
function nest(entries: readonly TreeEntry[]): ChatTreeNode[] {
  const roots: ChatTreeNode[] = [];
  const byId = new Map<string, ChatTreeNode>();
  const lastAtDepth: ChatTreeNode[] = [];
  for (const { depth, parentId, node } of entries) {
    const parent =
      depth <= 1
        ? undefined
        : ((parentId === null ? undefined : byId.get(parentId)) ?? lastAtDepth[depth - 1]);
    if (!byId.has(node.key) || node.chatId === null) {
      (parent ? parent.children : roots).push(node);
      if (node.chatId !== null) byId.set(node.chatId, node);
    }
    lastAtDepth[depth] = node;
    lastAtDepth.length = depth + 1;
  }
  return roots;
}

/** How many nodes a tree holds, private joints left out. */
function countOf(nodes: readonly ChatTreeNode[]): number {
  return nodes.reduce(
    (sum, node) => sum + (node.kind === 'private' ? 0 : 1) + countOf(node.children),
    0
  );
}

/**
 * The tree from the tree read's pages. The chats above the row repeat on every
 * page and are not part of what it draws, so only the descendants are read; a
 * chat a later page lists again is drawn once.
 *
 * A folded spin-off the read does not name still shows: under the chat that
 * started it when the tree has that chat, else at the top. The list's own
 * record of who started whom is older than the work graph, so a chat from
 * before it has no edge to be found by, and the fold must never lose a chat
 * the list already showed.
 *
 * @param pages - Every page read so far, first first.
 * @param spinOffs - The row's folded spin-offs, from the list, oldest first.
 * @param byId - Every chat in the list, with what it is doing.
 */
function fromPages(
  pages: readonly ChatTree[],
  spinOffs: readonly FoldedSpinOff[],
  byId: ReadonlyMap<string, FoldedSpinOff>
): ChatTreeModel {
  const seen = new Map<string, ChatTreeNode>();
  const entries: TreeEntry[] = [];
  let index = 0;
  for (const page of pages) {
    for (const entry of page.descendants) {
      const at = index++;
      // A chat a later page lists again keeps the node it already has, so
      // the chats after it still find their place by it.
      const known = entry.chatId === null ? undefined : seen.get(entry.chatId);
      const node = known ?? nodeOf(entry, at, byId);
      if (entry.chatId !== null) seen.set(entry.chatId, node);
      entries.push({ depth: entry.depth, parentId: entry.parentId, node });
    }
  }
  const nodes = nest(entries);
  // Placed whether or not more pages wait: a later page moves a chat to its
  // place, and until then the fold still shows every chat the list did.
  const unnamed = spinOffs.filter((spinOff) => !seen.has(spinOff.session.id));
  for (const leftover of fromList(unnamed, seen).nodes) nodes.push(leftover);
  return {
    nodes,
    count: countOf(nodes),
    truncated: pages.some((page) => page.truncated),
  };
}

/**
 * The tree from the list's own folded spin-offs: each under the spin-off that
 * started it, else under a chat the tree read already placed, else under the
 * row. What the fold draws before the tree read answers, or when it can't.
 *
 * @param spinOffs - Its folded spin-offs, oldest first.
 * @param placed - Chats the tree read already drew, by id, to hang these under.
 */
function fromList(
  spinOffs: readonly FoldedSpinOff[],
  placed: ReadonlyMap<string, ChatTreeNode> = new Map()
): ChatTreeModel {
  const nodes = new Map<string, ChatTreeNode>();
  for (const spinOff of spinOffs) {
    nodes.set(spinOff.session.id, {
      key: spinOff.session.id,
      chatId: spinOff.session.id,
      kind: 'chat',
      title: sessionDisplayTitle(spinOff.session.title),
      detail: STATUS_WORD[spinOff.status],
      status: spinOff.status,
      opens: true,
      children: [],
    });
  }
  // No loop can reach here: the list makes the first chat of a loop a row of
  // its own (`placeChats`), so every folded chain ends at the host.
  const roots: ChatTreeNode[] = [];
  for (const spinOff of spinOffs) {
    const node = nodes.get(spinOff.session.id);
    if (!node) continue;
    const startedBy = spinOff.session.startedBy;
    const parentId = startedBy?.kind === 'chat' ? startedBy.sessionId : null;
    const parent = parentId === null ? undefined : (nodes.get(parentId) ?? placed.get(parentId));
    (parent ?? { children: roots }).children.push(node);
  }
  return { nodes: roots, count: countOf(roots), truncated: false };
}

/** What {@link buildChatTree} is built from. */
export interface BuildChatTreeInput {
  /** Its folded spin-offs, from the list, oldest first. */
  spinOffs: readonly FoldedSpinOff[];
  /** The tree read's pages, or null while they are not here. */
  pages: readonly ChatTree[] | null;
  /** Every chat in the list, with what it is doing. */
  byId: ReadonlyMap<string, FoldedSpinOff>;
}

/**
 * The tree of chats under one row: from the tree read once it answers, else
 * from the list's folded spin-offs.
 *
 * @param input - The row's spin-offs, the tree read's pages and the list's chats.
 */
export function buildChatTree({ spinOffs, pages, byId }: BuildChatTreeInput): ChatTreeModel {
  return pages === null ? fromList(spinOffs) : fromPages(pages, spinOffs, byId);
}

/**
 * Every chat id in a subtree, for deciding whether a fold must open to show
 * the open chat.
 *
 * @param nodes - The subtree.
 */
export function chatIdsIn(nodes: readonly ChatTreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.chatId === null ? [] : [node.chatId]),
    ...chatIdsIn(node.children),
  ]);
}
