/**
 * The doc comment store over a real migrated SQLite database: threads keyed by
 * doc, comments in order, resolve and reopen, batched anchors that never move
 * another doc's thread, per-author counts in a chain, and kept chats.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { DocCommentStore, type NewDocComment } from '../comment-store.js';

let store: DocCommentStore;

const AT = '2026-10-17T10:00:00.000Z';
const LATER = '2026-10-17T11:00:00.000Z';

function comment(overrides: Partial<NewDocComment> = {}): NewDocComment {
  return {
    id: 'c1',
    threadId: 't1',
    authorId: 'author-owner',
    body: 'Is this date right?',
    mentionsJson: '[]',
    cascadeRoot: 'c1',
    cascadeDepth: 0,
    createdAt: AT,
    ...overrides,
  };
}

function openThread(id = 't1', docKey = 'doc-a', first: Partial<NewDocComment> = {}) {
  return store.insertThread(
    {
      id,
      docKey,
      spaceKey: 'space-1',
      docPath: 'plan.md',
      anchorJson: JSON.stringify({ v: 1, quote: 'Friday' }),
      createdByAuthorId: 'author-owner',
      createdAt: AT,
    },
    comment({ id: `${id}-c1`, threadId: id, cascadeRoot: `${id}-c1`, ...first })
  );
}

beforeEach(() => {
  store = new DocCommentStore(createTestDb());
});

describe('DocCommentStore', () => {
  it('opens a thread with its first comment and lists it by doc', () => {
    openThread('t1', 'doc-a');
    openThread('t2', 'doc-b');

    const listed = store.listThreads('doc-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.thread).toMatchObject({ id: 't1', resolved: false, updatedAt: AT });
    expect(listed[0]!.comments.map((c) => c.id)).toEqual(['t1-c1']);
  });

  it('finds a thread only on the doc it belongs to', () => {
    openThread('t1', 'doc-a');
    expect(store.getThread('doc-a', 't1')).not.toBeNull();
    expect(store.getThread('doc-b', 't1')).toBeNull();
  });

  it('adds replies in order and marks the thread changed', () => {
    openThread();
    store.insertComment(comment({ id: 'c2', body: 'Yes.', createdAt: LATER }));

    const stored = store.getThread('doc-a', 't1')!;
    expect(stored.comments.map((c) => c.body)).toEqual(['Is this date right?', 'Yes.']);
    expect(stored.thread.updatedAt).toBe(LATER);
  });

  it('resolves and reopens, recording who resolved it', () => {
    openThread();
    store.setResolved('t1', true, 'author-agent', LATER);
    expect(store.getThread('doc-a', 't1')!.thread).toMatchObject({
      resolved: true,
      resolvedAt: LATER,
      resolvedByAuthorId: 'author-agent',
    });

    store.setResolved('t1', false, 'author-owner', LATER);
    expect(store.getThread('doc-a', 't1')!.thread).toMatchObject({
      resolved: false,
      resolvedAt: null,
      resolvedByAuthorId: null,
    });
  });

  it('updates anchors in a batch and skips threads on another doc', () => {
    openThread('t1', 'doc-a');
    openThread('t2', 'doc-b');

    const updated = store.updateAnchors('doc-a', [
      { id: 't1', anchorJson: '{"v":1,"quote":"Monday"}' },
      { id: 't2', anchorJson: '{"v":1,"quote":"hijacked"}' },
      { id: 'missing', anchorJson: '{}' },
    ]);

    expect(updated).toBe(1);
    expect(store.getThread('doc-a', 't1')!.thread.anchorJson).toBe('{"v":1,"quote":"Monday"}');
    expect(store.getThread('doc-b', 't2')!.thread.anchorJson).toContain('Friday');
  });

  it('edits a comment and stamps when', () => {
    openThread();
    const first = store.getComment('t1', 't1-c1')!;
    store.editComment(first, 'Is Friday right?', LATER);
    expect(store.getComment('t1', 't1-c1')).toMatchObject({
      body: 'Is Friday right?',
      editedAt: LATER,
    });
    expect(store.getComment('t2', 't1-c1')).toBeNull();
  });

  it('counts comments by author in one chain', () => {
    openThread('t1', 'doc-a', { cascadeRoot: 'root' });
    store.insertComment(comment({ id: 'c2', authorId: 'agent-a', cascadeRoot: 'root' }));
    store.insertComment(comment({ id: 'c3', authorId: 'agent-a', cascadeRoot: 'root' }));
    store.insertComment(comment({ id: 'c4', authorId: 'agent-a', cascadeRoot: 'other' }));

    expect(Object.fromEntries(store.commentsByAuthorInCascade('root'))).toEqual({
      'author-owner': 1,
      'agent-a': 2,
    });
  });

  it('keeps one chat per agent, replacing it when it changes', () => {
    expect(store.keptChat('agent-a')).toBeNull();
    store.keepChat('agent-a', 'chat-1', AT);
    store.keepChat('agent-a', 'chat-2', LATER);
    expect(store.keptChat('agent-a')).toBe('chat-2');
  });
});
