/**
 * The work graph the playground's "server" answers with (W5, DOR-4971): the
 * tree under the chat-list showcase's "Plan the launch week", with one chat in
 * every state the tree read names, and no pull requests anywhere.
 *
 * @module dev/showcases/work-graph-mock-data
 */
import type { ChatTree, WorkPage } from '@dorkos/shared/work-graph-reads';

/** The chat whose tree the playground knows: the showcase's spin-off host. */
const TREE_HOST = 'sw-plan';

/** Below the host: its spin-offs, one of theirs, a private joint, and three that have not run. */
const HOST_DESCENDANTS: ChatTree['descendants'] = [
  { chatId: 'sw-spin-1', parentId: TREE_HOST, depth: 1, via: 'started', state: { kind: 'chat' } },
  { chatId: 'sw-spin-2', parentId: TREE_HOST, depth: 1, via: 'started', state: { kind: 'chat' } },
  {
    chatId: 'sw-spin-2a',
    parentId: 'sw-spin-2',
    depth: 2,
    via: 'started',
    state: { kind: 'chat' },
  },
  { chatId: null, parentId: 'sw-spin-2a', depth: 3, state: { kind: 'private' } },
  { chatId: 'sw-deep-1', parentId: null, depth: 4, via: 'started', state: { kind: 'unknown' } },
  {
    chatId: 'sw-queued-1',
    parentId: TREE_HOST,
    depth: 1,
    via: 'started',
    state: { kind: 'launching', runId: 'run-1', status: 'queued' },
  },
  {
    chatId: 'sw-lost-1',
    parentId: TREE_HOST,
    depth: 1,
    via: 'started',
    state: { kind: 'never-started', runId: 'run-2', reason: 'start_lost' },
  },
  { chatId: 'sw-spin-3', parentId: TREE_HOST, depth: 1, via: 'started', state: { kind: 'chat' } },
];

/**
 * A chat's tree, as `GET /api/sessions/{id}/tree` answers: the host's full
 * tree, and a tree of one for any other chat.
 *
 * @param chatId - The chat asked about.
 */
export function playgroundChatTree(chatId: string): ChatTree {
  return {
    chatId,
    state: { kind: 'chat' },
    ancestors: [],
    descendants: chatId === TREE_HOST ? HOST_DESCENDANTS : [],
    truncated: false,
    nextCursor: null,
  };
}

/** No pull requests: the honest answer for a playground with no server. */
export const PLAYGROUND_NO_WORK: WorkPage = { items: [], nextCursor: null };
