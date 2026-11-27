/**
 * `chat_tree` (W4, DOR-4970): a chat's ancestors and the chats below it, as
 * the lineage query (W3) answers them for one reader. It reads only
 * `readChatLineage`'s answer and never repeats its join: which chats are
 * shown, and in what state, is decided there.
 *
 * **What a reader may not read (Security, DOR-4970).** The asked chat must be
 * readable, or the answer is the same as for a chat that does not exist. The
 * lineage is read with the reader's filter (`ChatLineageOptions.readable`), so
 * below the asked chat a chat the reader may not read is already left out with
 * its whole subtree when nothing below it is readable, and the cap and
 * `truncated` count only what is kept: the tree says nothing of whether such a
 * chat exists, how deep it went or how many it started. When a readable chat
 * hangs below it, it is kept, and here it becomes only a bare joint
 * (`{ chatId: null, state: { kind: 'private' } }`, with no time, agent, link
 * kind or count), so those chats stay connected; they name it as
 * `parentId: null`. A chat above the asked one always has a readable chat
 * below it, the asked one, so one the reader may not read is a joint too.
 *
 * **Pages.** The descendants keep the lineage's depth-first order (siblings
 * oldest first), and a page goes on after the chat the last one ended on. A
 * chat started since sits after its older siblings, so nothing already listed
 * moves: a page never repeats a chat or skips one listed before. The ancestors
 * (at most `LINEAGE_MAX_DEPTH`) repeat on every page.
 *
 * The sealed cursor (`./page-cursor.ts`) holds that chat's path: it and each
 * chat above it, nearest first, with the order key it sits under its parent by
 * (its start time, then its id, as the walk orders siblings). So when that chat
 * is gone from the next read (deleted, or no longer readable to this reader),
 * the page goes on from where it was: after its older siblings under the
 * nearest chat on its path still in the tree. A re-keyed chat is found under
 * its new id. Only a path too long for the cursor's fixed length (about 20
 * levels), every step of which is gone, can't be resumed; it answers
 * `INVALID_CURSOR`.
 *
 * It names states and ids, never a chat's words: a launching chat's title is
 * left out. It grants no read of any chat in it: `chat_read` keeps its own
 * reach (`mayReadChat`'s `READ_REACH_DEPTH`), unchanged.
 *
 * @module services/work-graph/reads/chat-tree
 */
import type {
  ChatTree,
  ChatTreeAncestor,
  ChatTreeDescendant,
  ChatTreeState,
} from '@dorkos/shared/work-graph-reads';
import type { AuditReader } from '../../audit/visibility.js';
import type { ChatLineage, LineageDescendant, LineageState } from '../chat-lineage.js';
import type { LineageReads } from '../lineage-reads.js';
import { invalidCursor } from '../../../lib/paging/keyset-page.js';
import { decodePageCursor, encodePageCursor } from './page-cursor.js';

/** The fixed length a tree cursor's contents are padded to: room for about 20 levels. */
const TREE_CURSOR_BYTES = 2048;

/** The joint a chat the reader may not read becomes. */
const JOINT = { chatId: null, state: { kind: 'private' } } as const;

/** Which page of a tree's descendants. */
export interface ChatTreePage {
  /** The `nextCursor` of the page before, if any. */
  cursor?: string | undefined;
  /** How many descendants this page holds at most. */
  limit: number;
  /** Who is asking: a cursor is bound to the reader it was given to. */
  reader: AuditReader;
}

/** What a tree page reads beyond the lineage: each chat's parent and sibling order. */
export type ChatTreeOrder = Pick<LineageReads, 'parentsOf' | 'current'>;

/** One step of a cursor's path: a chat and the order key it sits under its parent by. */
type Step = [chatId: string, at: string];

/** What a tree cursor holds. */
interface TreePosition {
  /** The asked chat. */
  root: string;
  /** The last chat listed, then each chat above it, nearest first. */
  path: Step[];
  /** Whether `path` reaches a chat the asked one started (false when cut to fit). */
  whole: boolean;
}

/**
 * One page of a lineage as a reader may see it.
 *
 * @param lineage - The lineage read with the reader's filter; its asked chat is readable.
 * @param readable - The chats in it the reader may read.
 * @param page - Which page of the descendants, and for whom.
 * @param order - Each chat's parent and sibling order, as the walk reads them.
 */
export function filterChatTree(
  lineage: ChatLineage,
  readable: ReadonlySet<string>,
  page: ChatTreePage,
  order: ChatTreeOrder
): ChatTree {
  const ancestors: ChatTreeAncestor[] = lineage.ancestors.map((a) =>
    readable.has(a.chatId)
      ? { chatId: a.chatId, depth: a.depth, via: a.via, state: shownState(a.state) }
      : { ...JOINT, depth: a.depth }
  );
  const from =
    page.cursor === undefined
      ? 0
      : resumeAt(lineage, decodeTreePosition(page.reader, page.cursor), order);
  const taken = lineage.descendants.slice(from, from + page.limit);
  const descendants: ChatTreeDescendant[] = taken.map((d) => {
    const parentId = readable.has(d.parentId) ? d.parentId : null;
    return readable.has(d.chatId)
      ? { chatId: d.chatId, parentId, depth: d.depth, via: d.via, state: shownState(d.state) }
      : { ...JOINT, parentId, depth: d.depth };
  });
  const last = taken.at(-1);
  return {
    chatId: lineage.chatId,
    state: shownState(lineage.state),
    ancestors,
    descendants,
    truncated: lineage.truncated,
    nextCursor:
      last && from + taken.length < lineage.descendants.length
        ? encodePageCursor(page.reader, positionOf(lineage, last, order), TREE_CURSOR_BYTES)
        : null,
  };
}

/** The path from `last` up to a chat the asked one started, as much of it as fits. */
function positionOf(
  lineage: ChatLineage,
  last: LineageDescendant,
  order: ChatTreeOrder
): TreePosition {
  const byId = new Map(lineage.descendants.map((d) => [d.chatId, d]));
  const chain: LineageDescendant[] = [];
  for (let step: LineageDescendant | undefined = last; step; step = byId.get(step.parentId)) {
    chain.push(step);
  }
  const starts = order.parentsOf(chain.map((d) => d.chatId));
  const position: TreePosition = { root: lineage.chatId, path: [], whole: true };
  for (const d of chain) {
    const next = {
      ...position,
      path: [...position.path, [d.chatId, starts.get(d.chatId)?.at ?? '']],
    };
    // Bytes, not characters: the padding is counted in bytes. 128 are kept for the reader key.
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > TREE_CURSOR_BYTES - 128) {
      position.whole = false;
      break;
    }
    position.path = next.path as Step[];
  }
  return position;
}

/** A tree cursor's position, or the refusal. */
function decodeTreePosition(reader: AuditReader, cursor: string): TreePosition {
  const value = decodePageCursor(reader, cursor, TREE_CURSOR_BYTES) as Partial<TreePosition>;
  const path = value?.path;
  if (
    typeof value?.root === 'string' &&
    typeof value.whole === 'boolean' &&
    Array.isArray(path) &&
    path.length > 0 &&
    path.every(
      (step) =>
        Array.isArray(step) &&
        step.length === 2 &&
        typeof step[0] === 'string' &&
        typeof step[1] === 'string'
    )
  ) {
    return value as TreePosition;
  }
  throw invalidCursor();
}

/**
 * Where the page after a cursor's chat starts in this read of the tree: right
 * after it when it is still listed (under its new id, if re-keyed); else, at
 * the nearest chat on its path still listed (or the asked chat), the first of
 * that chat's children that sorts after the gone one, or the end of that
 * chat's subtree when none does.
 */
function resumeAt(lineage: ChatLineage, position: TreePosition, order: ChatTreeOrder): number {
  if (position.root !== lineage.chatId) throw invalidCursor();
  const list = lineage.descendants;
  const current = order.current(position.path.map(([id]) => id));
  const path = position.path.map(([id, at]): Step => [current.get(id) ?? id, at]);
  const index = new Map(list.map((d, i) => [d.chatId, i]));
  const own = index.get(path[0]![0]);
  if (own !== undefined) return own + 1;
  for (let j = 1; j <= path.length; j += 1) {
    const gone = path[j - 1]!;
    if (j < path.length && !index.has(path[j]![0])) continue;
    if (j === path.length && !position.whole) break;
    const anchorAt = j < path.length ? index.get(path[j]![0])! : -1;
    const anchor = j < path.length ? path[j]![0] : lineage.chatId;
    return afterGoneChild(list, anchorAt, anchor, gone, order);
  }
  throw invalidCursor();
}

/**
 * The first child of `anchor` that sorts after `gone`, or the end of `anchor`'s
 * subtree. A start time either side has lost (its start record went between
 * the pages) can't be placed, so the page skips forward rather than repeat:
 * a gone chat with none goes on at the end of `anchor`'s subtree, and a child
 * with none is never taken as the one after.
 */
function afterGoneChild(
  list: readonly LineageDescendant[],
  anchorAt: number,
  anchor: string,
  gone: Step,
  order: ChatTreeOrder
): number {
  const depth = anchorAt < 0 ? 0 : list[anchorAt]!.depth;
  let end = anchorAt + 1;
  while (end < list.length && list[end]!.depth > depth) end += 1;
  const children = list
    .map((d, i) => ({ d, i }))
    .slice(anchorAt + 1, end)
    .filter(({ d }) => d.parentId === anchor);
  if (gone[1] === '') return end;
  const starts = order.parentsOf(children.map(({ d }) => d.chatId));
  const after = children.find(({ d }) => {
    const at = starts.get(d.chatId)?.at;
    if (at === undefined) return false;
    return at > gone[1] || (at === gone[1] && d.chatId > gone[0]);
  });
  return after ? after.i : end;
}

/** Every chat id a lineage names, for one visibility lookup. */
export function chatIdsOf(lineage: ChatLineage): string[] {
  return [
    lineage.chatId,
    ...lineage.ancestors.map((a) => a.chatId),
    ...lineage.descendants.map((d) => d.chatId),
  ];
}

/** A lineage state on the wire: the same, without a launching chat's title. */
function shownState(state: LineageState): ChatTreeState {
  if (state.kind === 'launching') {
    return { kind: 'launching', runId: state.runId, status: state.status };
  }
  return state;
}
