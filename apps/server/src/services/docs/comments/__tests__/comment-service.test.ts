/**
 * The doc comment service's own rules (DOR-2983): threads read back with
 * their authors, mentions resolved once, resolve and reopen, edits only by the
 * author, and anchors saved in a batch.
 */
import { describe, expect, it } from 'vitest';
import { DocCommentError } from '../comment-errors.js';
import { ANCHOR, DOC, createCommentHarness } from './comment-harness.js';

describe('DocCommentService', () => {
  it('reads threads back with their authors and resolved mentions', async () => {
    const h = createCommentHarness();
    const { thread } = await h.service.createThread(DOC, h.ownerInPerson, {
      anchor: ANCHOR,
      body: 'Ask @scout, not @nobody',
    });

    const [listed] = h.service.list(DOC);
    expect(listed).toEqual(thread);
    expect(listed!.path).toBe('notes/plan.md');
    expect(listed!.anchor).toEqual(ANCHOR);
    expect(listed!.comments[0]!.author).toMatchObject({ id: h.owner.id, isOwner: true });
    expect(listed!.comments[0]!.mentions).toEqual([h.agentAuthor('scout').id]);
  });

  it('keeps mentions as written when a comment is edited, and wakes nobody', async () => {
    const h = createCommentHarness();
    const { thread } = await h.service.createThread(DOC, h.ownerInPerson, {
      anchor: ANCHOR,
      body: 'A note',
    });
    const edited = h.service.edit(
      DOC,
      h.ownerInPerson,
      thread.id,
      thread.comments[0]!.id,
      'A note for @scout'
    );
    expect(edited.comments[0]).toMatchObject({ body: 'A note for @scout', mentions: [] });
    expect(edited.comments[0]!.editedAt).not.toBeNull();
    expect(h.dispatched).toEqual([]);
  });

  it("refuses to change somebody else's comment", async () => {
    const h = createCommentHarness();
    const { thread } = await h.service.createThread(DOC, h.ownerInPerson, {
      anchor: ANCHOR,
      body: 'Mine',
    });
    expect(() =>
      h.service.edit(
        DOC,
        { author: h.agentAuthor('scout') },
        thread.id,
        thread.comments[0]!.id,
        'x'
      )
    ).toThrow(expect.objectContaining({ code: 'NOT_YOURS' }));
  });

  it('resolves and reopens a thread, naming who resolved it', async () => {
    const h = createCommentHarness();
    const { thread } = await h.service.createThread(DOC, h.ownerInPerson, {
      anchor: ANCHOR,
      body: 'Done?',
    });
    const resolved = h.service.setResolved(
      DOC,
      { author: h.agentAuthor('scout') },
      thread.id,
      true
    );
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedBy).toMatchObject({ kind: 'agent', displayName: 'scout' });

    const reopened = h.service.setResolved(DOC, h.ownerInPerson, thread.id, false);
    expect(reopened).toMatchObject({ resolved: false, resolvedBy: null, resolvedAt: null });
  });

  it('refuses a thread that is not on this doc', async () => {
    const h = createCommentHarness();
    const { thread } = await h.service.createThread(DOC, h.ownerInPerson, {
      anchor: ANCHOR,
      body: 'Here',
    });
    const other = { ...DOC, key: 'another-doc' };
    await expect(h.service.reply(other, h.ownerInPerson, thread.id, 'x')).rejects.toBeInstanceOf(
      DocCommentError
    );
  });

  it('saves the anchors the editor moved', async () => {
    const h = createCommentHarness();
    const { thread } = await h.service.createThread(DOC, h.ownerInPerson, {
      anchor: ANCHOR,
      body: 'Here',
    });
    const moved = { ...ANCHOR, start: 20, end: 26 };
    expect(h.service.updateAnchors(DOC, h.ownerInPerson, [{ id: thread.id, anchor: moved }])).toBe(
      1
    );
    expect(h.service.list(DOC)[0]!.anchor).toEqual(moved);
  });

  it('lets anybody but a person in the app move only the threads it opened', async () => {
    const h = createCommentHarness();
    const { thread } = await h.service.createThread(DOC, h.ownerInPerson, {
      anchor: ANCHOR,
      body: 'Mine',
    });
    const agent = { author: h.agentAuthor('scout') };
    expect(h.service.updateAnchors(DOC, agent, [{ id: thread.id, anchor: { v: 1 } }])).toBe(0);
    const own = await h.service.createThread(DOC, agent, { anchor: ANCHOR, body: 'Agent’s' });
    expect(h.service.updateAnchors(DOC, agent, [{ id: own.thread.id, anchor: { v: 1 } }])).toBe(1);
  });

  it('offers every agent, and the owner once they have a handle, to mention', () => {
    const h = createCommentHarness();
    expect(h.service.mentionable().map((p) => p.handle)).toEqual(['quill', 'scout']);
    h.authors.setHandle(h.owner.id, 'dorian');
    expect(h.service.mentionable().map((p) => p.handle)).toEqual(['quill', 'scout', 'dorian']);
  });
});
