/**
 * `chat_tree` (W4, DOR-4970): a chat's ancestors and the chats below it, as
 * the lineage query (W3) answers them, filtered for who is asking. It reads
 * only `readChatLineage`'s answer and never repeats its join: which chats are
 * shown, and in what state, is decided there.
 *
 * **What a reader may not read (Security, DOR-4970).** The asked chat must be
 * readable, or the answer is the same as for a chat that does not exist. Below
 * it, a chat the reader may not read is left out with its whole subtree when
 * nothing below it is readable, so the tree says nothing of whether it exists,
 * how deep it went or how many it started. When a readable chat hangs below it,
 * it stays only as a bare joint (`{ chatId: null, state: { kind: 'private' } }`,
 * with no time, agent, link kind or count), so those chats stay connected, and
 * they name it as `parentId: null`. A chat above the asked one always has a
 * readable chat below it, the asked one, so one the reader may not read is a
 * joint too.
 *
 * The descendants are paged in their depth-first order, after the filter, so
 * a joint is decided on the whole tree and never on one page of it. The
 * ancestors (at most `LINEAGE_MAX_DEPTH`) come on every page.
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
import { CapabilityToolError } from '../../core/capabilities/index.js';
import type { ChatLineage, LineageState } from '../chat-lineage.js';
import { decodePageCursor, encodePageCursor } from './page-cursor.js';

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
 * @param lineage - The lineage query's answer; its asked chat is readable.
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
  // Children before parents: a chat with a readable chat anywhere below it is kept.
  const keeps = new Set<string>();
  for (const d of [...lineage.descendants].reverse()) {
    if (readable.has(d.chatId) || keeps.has(d.chatId)) keeps.add(d.parentId);
  }
  const descendants: ChatTreeDescendant[] = [];
  for (const d of lineage.descendants) {
    const parentId = readable.has(d.parentId) ? d.parentId : null;
    if (readable.has(d.chatId)) {
      descendants.push({
        chatId: d.chatId,
        parentId,
        depth: d.depth,
        via: d.via,
        state: shownState(d.state),
      });
    } else if (keeps.has(d.chatId)) {
      descendants.push({ ...JOINT, parentId, depth: d.depth });
    }
  }
  const from = page.cursor === undefined ? 0 : offsetOf(page.cursor, lineage.chatId);
  const shown = descendants.slice(from, from + page.limit);
  const next = from + shown.length;
  return {
    chatId: lineage.chatId,
    state: shownState(lineage.state),
    ancestors,
    descendants: shown,
    truncated: lineage.truncated,
    nextCursor: next < descendants.length ? encodePageCursor([lineage.chatId, String(next)]) : null,
  };
}

/** Where a cursor of this chat's tree goes on from, refusing one for another chat. */
function offsetOf(cursor: string, chatId: string): number {
  const [forChat, offset] = decodePageCursor(cursor);
  if (forChat !== chatId || !/^\d{1,6}$/.test(offset)) {
    throw new CapabilityToolError({
      code: 'INVALID_CURSOR',
      error: 'That cursor was not given by this list. Leave it out to start again.',
    });
  }
  return Number(offset);
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
