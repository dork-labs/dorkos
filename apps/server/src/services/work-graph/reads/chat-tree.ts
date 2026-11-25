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
 * oldest first), and a page goes on after the chat the last one ended on,
 * named in a sealed cursor (`./page-cursor.ts`). A chat started since sits
 * after its older siblings, so nothing already listed moves: a page never
 * repeats a chat or skips one listed before. The ancestors (at most
 * `LINEAGE_MAX_DEPTH`) repeat on every page.
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
import type { ChatLineage, LineageState } from '../chat-lineage.js';
import { decodePageCursor, encodePageCursor, invalidCursor } from './page-cursor.js';

/** The joint a chat the reader may not read becomes. */
const JOINT = { chatId: null, state: { kind: 'private' } } as const;

/** Which page of a tree's descendants. */
export interface ChatTreePage {
  /** The `nextCursor` of the page before, if any. */
  cursor?: string | undefined;
  /** How many descendants this page holds at most. */
  limit: number;
}

/**
 * One page of a lineage as a reader may see it.
 *
 * @param lineage - The lineage read with the reader's filter; its asked chat is readable.
 * @param readable - The chats in it the reader may read.
 * @param page - Which page of the descendants.
 */
export function filterChatTree(
  lineage: ChatLineage,
  readable: ReadonlySet<string>,
  page: ChatTreePage
): ChatTree {
  const ancestors: ChatTreeAncestor[] = lineage.ancestors.map((a) =>
    readable.has(a.chatId)
      ? { chatId: a.chatId, depth: a.depth, via: a.via, state: shownState(a.state) }
      : { ...JOINT, depth: a.depth }
  );
  const from = page.cursor === undefined ? 0 : resumeAfter(lineage, page.cursor);
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
        ? encodePageCursor([lineage.chatId, last.chatId])
        : null,
  };
}

/** Where the page after the cursor's chat starts, refusing a cursor of another tree. */
function resumeAfter(lineage: ChatLineage, cursor: string): number {
  const [root, after] = decodePageCursor(cursor, 2) as [string, string];
  const at = lineage.descendants.findIndex((d) => d.chatId === after);
  if (root !== lineage.chatId || at < 0) throw invalidCursor();
  return at + 1;
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
