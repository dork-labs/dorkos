/**
 * A tree page resumes forward, never back, when a start time it needs is lost
 * between pages (W4, DOR-4970): a gone chat whose cursor holds no start time,
 * or a sibling whose start record went, never makes the next page list a chat
 * already listed. Over the page logic itself, with the order the walk reads
 * handed in.
 */
import { describe, expect, it } from 'vitest';
import { OWNER_READER } from '../../../audit/visibility.js';
import type { ChatLineage, LineageDescendant } from '../../chat-lineage.js';
import type { LineageParent } from '../../lineage-reads.js';
import { filterChatTree, type ChatTreeOrder } from '../chat-tree.js';

/** root → a → a0, a1, a2;  root → b. Siblings oldest first. */
const TREE: Array<[id: string, parent: string, depth: number, at: string]> = [
  ['a', 'root', 1, '2026-11-20T09:00:00.000Z'],
  ['a0', 'a', 2, '2026-11-20T09:01:00.000Z'],
  ['a1', 'a', 2, '2026-11-20T09:02:00.000Z'],
  ['a2', 'a', 2, '2026-11-20T09:03:00.000Z'],
  ['b', 'root', 1, '2026-11-20T09:04:00.000Z'],
];

/** The lineage, less the chats named. */
function lineage(without: readonly string[] = []): ChatLineage {
  const descendants: LineageDescendant[] = TREE.filter(([id]) => !without.includes(id)).map(
    ([chatId, parentId, depth]) => ({
      chatId,
      parentId,
      depth,
      via: 'started',
      state: { kind: 'chat' },
    })
  );
  return { chatId: 'root', state: { kind: 'chat' }, ancestors: [], descendants, truncated: false };
}

/** The walk's order, with the start times of the chats named lost. */
function order(lost: readonly string[] = []): ChatTreeOrder {
  return {
    current: (ids) => new Map(ids.map((id) => [id, id])),
    parentsOf: (ids) =>
      new Map(
        TREE.filter(([id]) => ids.includes(id) && !lost.includes(id)).map(
          ([id, parent, , at]): [string, LineageParent] => [
            id,
            { chatId: parent, via: 'started', at },
          ]
        )
      ),
  };
}

const readable = new Set(['root', ...TREE.map(([id]) => id)]);
const page = (cursor?: string) => ({
  limit: 3,
  reader: OWNER_READER,
  ...(cursor ? { cursor } : {}),
});
const ids = (tree: { descendants: { chatId: string | null }[] }) =>
  tree.descendants.map((d) => d.chatId);

describe('a tree page whose resume point lost its start time', () => {
  it('skips forward when the gone chat’s own start time was lost before its cursor was made', () => {
    const first = filterChatTree(lineage(), readable, page(), order(['a1']));
    expect(ids(first)).toEqual(['a', 'a0', 'a1']);
    const next = filterChatTree(lineage(['a1']), readable, page(first.nextCursor!), order());
    // Never `a0` again: the rest of `a`'s subtree is skipped, and the page goes on at `b`.
    expect(ids(next)).toEqual(['b']);
  });

  it('skips forward past a sibling whose start record went between the pages', () => {
    const first = filterChatTree(lineage(), readable, page(), order());
    const next = filterChatTree(lineage(['a1']), readable, page(first.nextCursor!), order(['a2']));
    expect(ids(next)).toEqual(['b']);
  });
});
