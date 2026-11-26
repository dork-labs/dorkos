import { describe, it, expect } from 'vitest';
import { createMockSession } from '@dorkos/test-utils/mock-factories';
import type { Session } from '@dorkos/shared/types';
import type { ChatTree, ChatTreeDescendant } from '@dorkos/shared/work-graph-reads';
import type { ChatStatus, FoldedSpinOff } from '../model/build-chat-list';
import { buildChatTree, type ChatTreeNode } from '../model/build-chat-tree';

/** A chat in the list, with what it is doing. */
function known(
  id: string,
  status: ChatStatus = 'idle',
  extra: Partial<Session> = {}
): FoldedSpinOff {
  return { session: createMockSession({ id, title: id, ...extra }), status, lifecycle: null };
}

/** A spin-off the list folded, started by `parentId`. */
function folded(id: string, parentId: string): FoldedSpinOff {
  return known(id, 'idle', {
    startedBy: { kind: 'chat', sessionId: parentId, title: null, reason: null, permission: null },
  });
}

/** A chat below the asked one, as the tree read lists it. */
function below(chatId: string, parentId: string, depth: number): ChatTreeDescendant {
  return { chatId, parentId, depth, via: 'started', state: { kind: 'chat' } };
}

/** One page of a tree under `host`. */
function page(descendants: ChatTreeDescendant[], extra: Partial<ChatTree> = {}): ChatTree {
  return {
    chatId: 'host',
    state: { kind: 'chat' },
    ancestors: [],
    descendants,
    truncated: false,
    nextCursor: null,
    ...extra,
  };
}

/** The tree as indented lines: `title (detail)`, two spaces a level. */
function outline(nodes: readonly ChatTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.title}${node.detail === null ? '' : ` (${node.detail})`}${node.opens ? '' : ' [no open]'}`,
    ...outline(node.children, depth + 1),
  ]);
}

const byId = (...chats: FoldedSpinOff[]) => new Map(chats.map((c) => [c.session.id, c]));

describe('buildChatTree', () => {
  it('nests the tree read at any depth, each chat under the one that started it', () => {
    const chats = byId(known('a'), known('b', 'running'), known('c'), known('d'));
    const model = buildChatTree({
      spinOffs: [],
      byId: chats,
      pages: [
        page([
          below('a', 'host', 1),
          below('b', 'a', 2),
          below('c', 'b', 3),
          below('d', 'host', 1),
        ]),
      ],
    });
    expect(outline(model.nodes)).toEqual(['a (Done)', '  b (Running)', '    c (Done)', 'd (Done)']);
    expect(model.count).toBe(4);
  });

  it('goes on across pages, and draws a chat a later page repeats once', () => {
    const chats = byId(known('a'), known('b'), known('c'));
    const model = buildChatTree({
      spinOffs: [],
      byId: chats,
      pages: [
        page([below('a', 'host', 1), below('b', 'a', 2)], { nextCursor: 'next' }),
        // The next page goes on inside a's subtree, then back up to the top.
        page([below('b', 'a', 2), below('c', 'host', 1)]),
      ],
    });
    expect(outline(model.nodes)).toEqual(['a (Done)', '  b (Done)', 'c (Done)']);
  });

  it('says what each chat that has not run, or that you may not read, is', () => {
    const model = buildChatTree({
      spinOffs: [],
      byId: byId(known('titled', 'idle', { title: 'Draft the post' })),
      pages: [
        page([
          {
            chatId: 'titled',
            parentId: 'host',
            depth: 1,
            via: 'started',
            state: { kind: 'launching', runId: 'r1', status: 'queued' },
          },
          {
            chatId: 'fresh',
            parentId: 'host',
            depth: 1,
            via: 'started',
            state: { kind: 'launching', runId: 'r2', status: 'starting' },
          },
          {
            chatId: 'lost',
            parentId: 'host',
            depth: 1,
            via: 'started',
            state: { kind: 'never-started', runId: 'r3', reason: 'start_lost' },
          },
          {
            chatId: 'odd',
            parentId: 'host',
            depth: 1,
            via: 'started',
            state: { kind: 'never-started', runId: 'r4', reason: 'a_new_reason' },
          },
          {
            chatId: 'proof',
            parentId: 'host',
            depth: 1,
            via: 'started',
            state: { kind: 'unknown' },
          },
          below('theirs', 'host', 1),
          // A private chat, kept because a chat you may read hangs below it.
          { chatId: null, parentId: 'host', depth: 1, state: { kind: 'private' } },
          {
            chatId: 'visible',
            parentId: null,
            depth: 2,
            via: 'started',
            state: { kind: 'unknown' },
          },
        ]),
      ],
    });
    expect(outline(model.nodes)).toEqual([
      'Draft the post (Waiting to start) [no open]',
      'New chat (Starting) [no open]',
      'New chat (Didn’t start: lost in a restart) [no open]',
      'New chat (Didn’t start) [no open]',
      'Can’t be opened [no open]',
      'Another chat',
      'A private chat [no open]',
      '  Can’t be opened [no open]',
    ]);
    // The joint is not a chat you can count; the one below it is.
    expect(model.count).toBe(7);
  });

  it('draws the list’s own spin-offs, nested, until the tree read answers', () => {
    const model = buildChatTree({
      spinOffs: [folded('mid', 'host'), folded('leaf', 'mid'), folded('other', 'host')],
      byId: new Map(),
      pages: null,
    });
    expect(outline(model.nodes)).toEqual(['mid (Done)', '  leaf (Done)', 'other (Done)']);
  });

  it('keeps a spin-off the tree read does not name, under its starter when the tree has it', () => {
    const chats = byId(known('a'));
    const model = buildChatTree({
      spinOffs: [folded('a', 'host'), folded('old', 'a'), folded('older', 'host')],
      byId: chats,
      pages: [page([below('a', 'host', 1)])],
    });
    expect(outline(model.nodes)).toEqual(['a (Done)', '  old (Done)', 'older (Done)']);
  });

  it('keeps the list’s spin-offs in view while more pages wait, until their page places them', () => {
    const spinOffs = [folded('a', 'host'), folded('b', 'a')];
    const chats = byId(...spinOffs);
    const first = page([], { nextCursor: 'next', truncated: true });
    const waiting = buildChatTree({ spinOffs, byId: chats, pages: [first] });
    expect(outline(waiting.nodes)).toEqual(['a (Done)', '  b (Done)']);
    expect(waiting.count).toBe(2);
    expect(waiting.truncated).toBe(true);

    const both = buildChatTree({
      spinOffs,
      byId: chats,
      pages: [first, page([below('a', 'host', 1), below('b', 'a', 2)])],
    });
    expect(outline(both.nodes)).toEqual(['a (Done)', '  b (Done)']);
  });

  it('hangs a chat under the parent the read names, even after a repeat', () => {
    const chats = byId(known('a'), known('b'), known('x'), known('y'), known('e'));
    const model = buildChatTree({
      spinOffs: [],
      byId: chats,
      pages: [
        page([below('a', 'host', 1), below('b', 'a', 2), below('x', 'a', 2), below('y', 'x', 3)], {
          nextCursor: 'next',
        }),
        // The next page repeats b, then lists a chat b started: under b, not
        // under x, where the depth alone would put it.
        page([below('b', 'a', 2), below('e', 'b', 3)]),
      ],
    });
    expect(outline(model.nodes)).toEqual([
      'a (Done)',
      '  b (Done)',
      '    e (Done)',
      '  x (Done)',
      '    y (Done)',
    ]);
  });
});
