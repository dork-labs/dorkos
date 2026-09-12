/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mockCanvasDocument } from '@dorkos/test-utils';
import type { CanvasDocument, RoomCanvasEvent } from '@dorkos/shared/room-schemas';
import { useAppStore } from '../app-store';
import { roomDocumentsInView } from '../app-store-room-canvas';

const ROOM = 'room-1';
const VIEWER = 'author-you';

/** Put the room canvas slice back to knowing nothing about any room. */
function resetRoomCanvas() {
  useAppStore.setState({
    roomCanvasDocuments: {},
    roomCanvasActive: {},
    roomCanvasUnread: {},
    roomCanvasEditing: {},
    roomCanvasStale: {},
  });
}

/** One document on `ROOM`'s table. */
function doc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return mockCanvasDocument({ roomId: ROOM, scope: `room:${ROOM}`, ...overrides });
}

/** The frame a live open/update/activate/pin publishes. */
function frame(
  document: CanvasDocument,
  change: RoomCanvasEvent['change'] = 'opened'
): RoomCanvasEvent {
  return { type: 'canvas', documentId: document.id, document, change };
}

/** The frame a resync sends: whole state, no `change`. */
function resyncFrame(document: CanvasDocument): RoomCanvasEvent {
  return { type: 'canvas', documentId: document.id, document };
}

/** Apply a frame as the viewer above. */
function apply(event: RoomCanvasEvent, viewer: string | null = VIEWER) {
  useAppStore.getState().applyRoomCanvasFrame(ROOM, event, viewer);
}

/** This room's table, as the slice holds it. */
function table(): readonly CanvasDocument[] {
  return useAppStore.getState().roomCanvasDocuments[ROOM] ?? [];
}

describe('RoomCanvasSlice — hydration', () => {
  beforeEach(resetRoomCanvas);

  it('builds the table from the resync burst a resume sends', () => {
    apply(resyncFrame(doc({ id: 'd1' })));
    apply(resyncFrame(doc({ id: 'd2', content: { type: 'json', data: {} } })));

    expect(table().map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('sweeps a document closed while away, once the resync burst has ended', () => {
    apply(resyncFrame(doc({ id: 'd1' })));
    apply(resyncFrame(doc({ id: 'closed-while-away' })));

    // The reader reconnects. The resync that follows names only what is still
    // on the table — nothing names the document that was closed, because a
    // close is a deletion and leaves no frame to replay.
    useAppStore.getState().beginRoomCanvasCycle(ROOM);
    apply(resyncFrame(doc({ id: 'd1' })));
    useAppStore.getState().endRoomCanvasCycle(ROOM);

    expect(table().map((d) => d.id)).toEqual(['d1']);
  });

  it('never lets an empty table be observed between a cycle starting and its resync', () => {
    // **The bug this replaces.** Emptying the table at cycle start rendered:
    // the view fell to its splash, the editor unmounted, and a half-typed draft
    // went with it — from a two-second network blip. So the property is about
    // what any reader of the store could SEE, not about where it ends up.
    apply(resyncFrame(doc({ id: 'd1' })));
    apply(resyncFrame(doc({ id: 'd2' })));

    const seen: number[] = [];
    const stop = useAppStore.subscribe((state) => {
      seen.push((state.roomCanvasDocuments[ROOM] ?? []).length);
    });
    try {
      useAppStore.getState().beginRoomCanvasCycle(ROOM);
      apply(resyncFrame(doc({ id: 'd1' })));
      apply(resyncFrame(doc({ id: 'd2' })));
      useAppStore.getState().endRoomCanvasCycle(ROOM);
    } finally {
      stop();
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(0);
  });

  it('keeps the document this viewer is editing, even when nothing vouches for it', () => {
    // Their draft is the only copy of what they have typed. A table that tidied
    // itself by throwing that away is the failure this design exists to stop.
    apply(resyncFrame(doc({ id: 'drafting' })));
    useAppStore.getState().setRoomCanvasEditing(ROOM, 'drafting');

    useAppStore.getState().beginRoomCanvasCycle(ROOM);
    useAppStore.getState().endRoomCanvasCycle(ROOM);

    expect(table().map((d) => d.id)).toEqual(['drafting']);
  });

  it('a close arriving during a cycle vouches for its own row, so the sweep is a no-op for it', () => {
    apply(resyncFrame(doc({ id: 'd1' })));
    useAppStore.getState().beginRoomCanvasCycle(ROOM);
    apply({ type: 'canvas', documentId: 'd1', closed: true });
    useAppStore.getState().endRoomCanvasCycle(ROOM);

    expect(table()).toHaveLength(0);
    expect(useAppStore.getState().roomCanvasStale[ROOM]).toEqual([]);
  });
});

describe('RoomCanvasSlice — frames', () => {
  beforeEach(resetRoomCanvas);

  it('applies opened, updated, closed, activated and pinned frames', () => {
    apply(frame(doc({ id: 'd1', title: 'Notes' }), 'opened'));
    expect(table()).toHaveLength(1);

    apply(frame(doc({ id: 'd1', title: 'Notes v2', rev: 2 }), 'updated'));
    expect(table()[0].title).toBe('Notes v2');

    apply(frame(doc({ id: 'd1', title: 'Notes v2', rev: 3 }), 'activated'));
    expect(table()).toHaveLength(1);

    apply(frame(doc({ id: 'd1', title: 'Notes v2', rev: 4, pinned: true }), 'pinned'));
    expect(table()[0].pinned).toBe(true);

    apply({ type: 'canvas', documentId: 'd1', closed: true });
    expect(table()).toHaveLength(0);
  });

  it('drops a frame carrying a lower rev than the row already held', () => {
    apply(frame(doc({ id: 'd1', title: 'newer', rev: 5 })));
    apply(frame(doc({ id: 'd1', title: 'older', rev: 2 }), 'updated'));

    expect(table()[0].title).toBe('newer');
  });

  it('ignores a frame about another room', () => {
    apply(frame(doc({ id: 'd1' })));
    apply(frame(mockCanvasDocument({ id: 'elsewhere', roomId: 'room-2' })));

    expect(table().map((d) => d.id)).toEqual(['d1']);
  });

  it('sorts pinned documents first, then by when they were opened', () => {
    apply(frame(doc({ id: 'early', openedAt: '2026-09-11T00:00:00.000Z' })));
    apply(frame(doc({ id: 'late', openedAt: '2026-09-11T01:00:00.000Z' })));
    apply(
      frame(doc({ id: 'pinned', openedAt: '2026-09-11T02:00:00.000Z', pinned: true }), 'pinned')
    );

    expect(table().map((d) => d.id)).toEqual(['pinned', 'early', 'late']);
  });
});

describe('RoomCanvasSlice — nothing steals focus (§9.3)', () => {
  beforeEach(resetRoomCanvas);

  it("shows a viewer the document THEY opened, and leaves another member's where it was", () => {
    apply(frame(doc({ id: 'mine', authorId: VIEWER })));
    expect(useAppStore.getState().roomCanvasActive[ROOM]?.canvas).toBe('mine');

    apply(frame(doc({ id: 'theirs', authorId: 'author-ana' })));
    expect(useAppStore.getState().roomCanvasActive[ROOM]?.canvas).toBe('mine');
  });

  it('marks another member’s arrival unread on the view it belongs to', () => {
    apply(frame(doc({ id: 'mine', authorId: VIEWER })));
    apply(frame(doc({ id: 'theirs', authorId: 'author-ana' })));
    apply(
      frame(
        doc({
          id: 'their-page',
          authorId: 'author-ana',
          content: { type: 'url', url: 'https://dorkos.ai' },
        })
      )
    );

    const unread = useAppStore.getState().roomCanvasUnread[ROOM];
    expect(unread?.canvas).toEqual(['theirs']);
    expect(unread?.browser).toEqual(['their-page']);
  });

  it('never moves a viewer who is editing, even off their own arrival', () => {
    apply(frame(doc({ id: 'drafting', authorId: VIEWER })));
    useAppStore.getState().setRoomCanvasEditing(ROOM, 'drafting');

    apply(frame(doc({ id: 'another-of-mine', authorId: VIEWER })));

    expect(useAppStore.getState().roomCanvasActive[ROOM]?.canvas).toBe('drafting');
  });

  it('an update, an activate or a pin moves nobody — not even its own author', () => {
    apply(frame(doc({ id: 'first', authorId: VIEWER })));
    apply(frame(doc({ id: 'second', authorId: 'author-ana' })));
    useAppStore.getState().activateRoomCanvasDocument(ROOM, 'second');

    apply(frame(doc({ id: 'first', authorId: VIEWER, rev: 2 }), 'updated'));
    apply(frame(doc({ id: 'first', authorId: VIEWER, rev: 3 }), 'activated'));
    apply(frame(doc({ id: 'first', authorId: VIEWER, rev: 4, pinned: true }), 'pinned'));

    expect(useAppStore.getState().roomCanvasActive[ROOM]?.canvas).toBe('second');
  });

  it('keeps each view’s active document apart', () => {
    apply(
      frame(doc({ id: 'page', authorId: VIEWER, content: { type: 'url', url: 'https://a.dev' } }))
    );
    apply(frame(doc({ id: 'note', authorId: VIEWER })));

    const active = useAppStore.getState().roomCanvasActive[ROOM];
    expect(active?.browser).toBe('page');
    expect(active?.canvas).toBe('note');
  });
});

describe('RoomCanvasSlice — closing and reading', () => {
  beforeEach(resetRoomCanvas);

  it('hands a view its next document when the one it showed is closed', () => {
    apply(frame(doc({ id: 'd1', authorId: VIEWER, openedAt: '2026-09-11T00:00:00.000Z' })));
    apply(frame(doc({ id: 'd2', authorId: VIEWER, openedAt: '2026-09-11T01:00:00.000Z' })));
    expect(useAppStore.getState().roomCanvasActive[ROOM]?.canvas).toBe('d2');

    apply({ type: 'canvas', documentId: 'd2', closed: true });

    expect(useAppStore.getState().roomCanvasActive[ROOM]?.canvas).toBe('d1');
  });

  it('drops the unread mark of a closed document', () => {
    apply(frame(doc({ id: 'theirs', authorId: 'author-ana' })));
    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual(['theirs']);

    apply({ type: 'canvas', documentId: 'theirs', closed: true });

    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual([]);
  });

  it('marks a document looked at when the viewer shows it', () => {
    apply(frame(doc({ id: 'theirs', authorId: 'author-ana' })));
    useAppStore.getState().activateRoomCanvasDocument(ROOM, 'theirs');

    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual([]);
    expect(useAppStore.getState().roomCanvasActive[ROOM]?.canvas).toBe('theirs');
  });

  it('does not re-light a dot the reader cleared, on every reconnect', () => {
    // A resync frame is the server saying "this is still here". Read as an
    // arrival it would put the mark back once per network blip, forever.
    // The reader sits on their own document, so `theirs` is a tab they are NOT
    // looking at — which is the only state in which a dot can be lit at all.
    apply(frame(doc({ id: 'mine', authorId: VIEWER })));
    apply(frame(doc({ id: 'theirs', authorId: 'author-ana' })));
    useAppStore.getState().clearRoomCanvasUnread(ROOM, 'canvas');

    useAppStore.getState().beginRoomCanvasCycle(ROOM);
    apply(resyncFrame(doc({ id: 'theirs', authorId: 'author-ana', rev: 2 })));
    useAppStore.getState().endRoomCanvasCycle(ROOM);

    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual([]);
  });

  it('lights nothing for an activate or a pin — those change the order, not what it says', () => {
    apply(frame(doc({ id: 'mine', authorId: VIEWER })));
    apply(frame(doc({ id: 'theirs', authorId: 'author-ana' })));
    useAppStore.getState().clearRoomCanvasUnread(ROOM, 'canvas');

    apply(frame(doc({ id: 'theirs', authorId: 'author-ana', rev: 2 }), 'activated'));
    apply(frame(doc({ id: 'theirs', authorId: 'author-ana', rev: 3, pinned: true }), 'pinned'));

    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual([]);
  });

  it('lights the dot again when another member really changes a document', () => {
    // The reader is looking at their OWN document; a document you are looking
    // at is never unread, so the one being changed has to be a different tab.
    apply(frame(doc({ id: 'mine', authorId: VIEWER })));
    apply(frame(doc({ id: 'theirs', authorId: 'author-ana' })));
    useAppStore.getState().clearRoomCanvasUnread(ROOM, 'canvas');

    apply(frame(doc({ id: 'theirs', authorId: 'author-ana', rev: 2 }), 'updated'));

    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual(['theirs']);
  });

  it('clears a whole view’s unread marks when the reader arrives on that tab', () => {
    apply(frame(doc({ id: 'a', authorId: 'author-ana' })));
    apply(frame(doc({ id: 'b', authorId: 'author-ana' })));

    useAppStore.getState().clearRoomCanvasUnread(ROOM, 'canvas');

    expect(useAppStore.getState().roomCanvasUnread[ROOM]?.canvas).toEqual([]);
  });
});

describe('roomDocumentsInView', () => {
  it('sends url and browser documents to the Browser view and the rest to Canvas', () => {
    const documents = [
      doc({ id: 'url', content: { type: 'url', url: 'https://a.dev' } }),
      doc({ id: 'browser', content: { type: 'browser', url: 'https://b.dev' } }),
      doc({ id: 'markdown' }),
      doc({ id: 'app', content: { type: 'mcp_app', serverName: 's', uri: 'ui://x' } }),
    ];

    expect(roomDocumentsInView(documents, 'browser').map((d) => d.id)).toEqual(['url', 'browser']);
    expect(roomDocumentsInView(documents, 'canvas').map((d) => d.id)).toEqual(['markdown', 'app']);
  });
});
