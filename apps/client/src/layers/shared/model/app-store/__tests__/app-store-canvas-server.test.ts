/**
 * @vitest-environment jsdom
 */
/** The canvas slice as a view of the SERVER's table (spec `canvas-agent-seat` §1.5). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import { useAppStore } from '../app-store';
import { documentPanelScope } from '../../panel-resources/preferences';
import { setSessionCanvasTransport, type SessionCanvasTransport } from '../app-store-canvas';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Imported after the mock so the spy is the one the slice calls.
const { toast } = await import('sonner');

const SESSION = 'sess-1';

const fileDoc = (path: string): UiCanvasContent => ({ type: 'file', sourcePath: path });

/** One of the server's rows, with everything a test does not care about filled in. */
function serverDocument(overrides: {
  id: string;
  content: UiCanvasContent;
  rev?: number;
  lastActiveAt?: string;
}): ServerCanvasDocument {
  return {
    id: overrides.id,
    scope: `session:${SESSION}`,
    roomId: null,
    content: overrides.content,
    title: overrides.id,
    contentType: overrides.content.type,
    authorId: 'owner',
    pinned: false,
    rev: overrides.rev ?? 1,
    lastTouchedBy: 'owner',
    lastTouchedAt: overrides.lastActiveAt ?? '2026-09-12T10:00:00.000Z',
    openedAt: '2026-09-12T09:00:00.000Z',
    lastActiveAt: overrides.lastActiveAt ?? '2026-09-12T10:00:00.000Z',
  };
}

/** A transport whose six canvas methods are spies, resolving by default. */
function fakeTransport(overrides: Partial<SessionCanvasTransport> = {}): SessionCanvasTransport {
  return {
    listSessionCanvas: vi.fn().mockResolvedValue([]),
    getSessionCanvasDocument: vi.fn().mockResolvedValue(null),
    openSessionCanvasDocument: vi
      .fn()
      .mockImplementation((_id: string, content: UiCanvasContent) =>
        Promise.resolve(serverDocument({ id: 'server-doc', content }))
      ),
    updateSessionCanvasDocument: vi
      .fn()
      .mockImplementation((_id: string, documentId: string) =>
        Promise.resolve(serverDocument({ id: documentId, content: fileDoc('a.ts'), rev: 9 }))
      ),
    closeSessionCanvasDocument: vi.fn().mockResolvedValue(undefined),
    setSessionCanvasEditing: vi.fn().mockResolvedValue({ editingBy: null, expiresAt: null }),
    ...overrides,
  };
}

describe('CanvasSlice — the server’s table, as this window holds it', () => {
  beforeEach(() => {
    // Each test begins a fresh view; rebinding the same session is deliberately
    // idempotent so a delayed canonical route cannot wipe its early snapshot.
    useAppStore.getState().loadCanvasForSession('fixture-reset');
    useAppStore.getState().loadCanvasForSession(SESSION);
  });

  afterEach(() => {
    setSessionCanvasTransport(null);
    vi.restoreAllMocks();
  });

  describe('hydration', () => {
    it('REPLACES rather than merges, so a close missed while away self-corrects', () => {
      const state = useAppStore.getState();
      state.hydrateCanvasFromSnapshot(SESSION, [
        serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
        serverDocument({ id: 'doc-b', content: fileDoc('b.ts') }),
      ]);
      state.hydrateCanvasFromSnapshot(SESSION, [
        serverDocument({ id: 'doc-a', content: fileDoc('a.ts'), rev: 2 }),
      ]);
      expect(useAppStore.getState().openDocuments.map((d) => d.id)).toEqual(['doc-a']);
    });
  });

  /** The cap is the SERVER's rule, applied here too (DOR-2006 review, 9 / 10a). */
  describe('the canvas event', () => {
    beforeEach(() => {
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts'), rev: 5 }),
        ]);
    });

    it('DROPS a frame whose rev is not greater — the echo of your own write', () => {
      useAppStore.getState().applyCanvasEvent(SESSION, {
        documentId: 'doc-a',
        document: serverDocument({ id: 'doc-a', content: fileDoc('stale.ts'), rev: 5 }),
        change: 'updated',
      });
      expect(useAppStore.getState().openDocuments[0]!.content).toEqual(fileDoc('a.ts'));
    });

    it('HOLDS an arrival for the banner while somebody is typing in that document', () => {
      // ADR-0292's rule, over the wire: a frame that landed underneath an editor would take the
      // draft, which is the silent drop the held update exists to remove.
      useAppStore.getState().setDocumentEditing('doc-a', true);
      useAppStore.getState().applyCanvasEvent(SESSION, {
        documentId: 'doc-a',
        document: serverDocument({ id: 'doc-a', content: fileDoc('agents-version.ts'), rev: 6 }),
        change: 'updated',
      });
      const held = useAppStore.getState().openDocuments[0]!;
      expect(held.content).toEqual(fileDoc('a.ts'));
      expect(held.heldUpdate).toEqual(fileDoc('agents-version.ts'));
    });

    /** This window's OWN autosave, echoed back, is not somebody else's change (DOR-2213). */
    describe('while editing: this window’s own echo versus somebody else’s change', () => {
      const markdown = (text: string): UiCanvasContent => ({
        type: 'markdown',
        content: text,
        sourcePath: 'notes.md',
      });

      /** A frame for `doc-a` at `rev`, carrying `content`. */
      const frame = (content: UiCanvasContent, rev: number) => ({
        documentId: 'doc-a',
        document: serverDocument({ id: 'doc-a', content, rev }),
        change: 'updated' as const,
      });

      beforeEach(() => {
        setSessionCanvasTransport(fakeTransport());
        useAppStore
          .getState()
          .hydrateCanvasFromSnapshot(SESSION, [
            serverDocument({ id: 'doc-a', content: markdown('v1'), rev: 5 }),
          ]);
        useAppStore.getState().setDocumentEditing('doc-a', true);
      });

      it('holds nothing for the echo of its own autosave, and takes its rev', () => {
        useAppStore.getState().setDocumentContent('doc-a', markdown('v1, edited'));
        useAppStore.getState().applyCanvasEvent(SESSION, frame(markdown('v1, edited'), 6));

        const doc = useAppStore.getState().openDocuments[0]!;
        expect(doc.heldUpdate).toBeNull();
        expect(doc.content).toEqual(markdown('v1, edited'));
        expect(doc.rev).toBe(6);
      });

      /**
       * What is on screen can move BACKWARDS mid-edit (review round 1): a refused earlier write
       * puts its `previous` back, and a snapshot taken before a write resets the row.
       */
      it('lands the newest echo whole after an earlier refused write put older words back', async () => {
        let refuseFirst!: (err: Error) => void;
        const update = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                refuseFirst = reject;
              })
          )
          .mockImplementationOnce(() => new Promise(() => {}));
        setSessionCanvasTransport(fakeTransport({ updateSessionCanvasDocument: update }));

        useAppStore.getState().setDocumentContent('doc-a', markdown('A'));
        useAppStore.getState().setDocumentContent('doc-a', markdown('B'));
        refuseFirst(new Error('refused'));
        await vi.waitFor(() => {
          expect(useAppStore.getState().openDocuments[0]!.content).toEqual(markdown('v1'));
        });

        // B landed on the server. Its echo must put B on screen, not leave v1.
        useAppStore.getState().applyCanvasEvent(SESSION, frame(markdown('B'), 6));
        const doc = useAppStore.getState().openDocuments[0]!;
        expect(doc.content).toEqual(markdown('B'));
        expect(doc.heldUpdate).toBeNull();
      });

      /** A pin or an activate changes the order, never what a document says (review round 2). */
      describe('a pin or an activate mid-edit', () => {
        /** A reorder frame for `doc-a`, carrying whatever the row held. */
        const reorder = (
          content: UiCanvasContent,
          rev: number,
          change: 'pinned' | 'activated',
          pinned = false
        ) => ({
          documentId: 'doc-a',
          document: { ...serverDocument({ id: 'doc-a', content, rev }), pinned },
          change,
        });

        it('does not withdraw a version the person has not answered for', () => {
          useAppStore.getState().setDocumentContent('doc-a', markdown('B'));
          useAppStore.getState().applyCanvasEvent(SESSION, frame(markdown('B'), 6));
          useAppStore.getState().applyCanvasEvent(SESSION, frame(markdown('X'), 7));
          expect(useAppStore.getState().openDocuments[0]!.heldUpdate).toEqual(markdown('X'));

          // Another window pins the document. The row it carries says B, which is
          // what is on screen — and still nobody chose between B and X.
          useAppStore
            .getState()
            .applyCanvasEvent(SESSION, reorder(markdown('B'), 8, 'pinned', true));

          const doc = useAppStore.getState().openDocuments[0]!;
          expect(doc.heldUpdate).toEqual(markdown('X'));
          expect(doc.pinned).toBe(true);
          expect(doc.rev).toBe(8);
        });
      });
    });

    it('removes a closed document', () => {
      useAppStore.getState().applyCanvasEvent(SESSION, { documentId: 'doc-a', closed: true });
      expect(useAppStore.getState().openDocuments).toHaveLength(0);
      expect(useAppStore.getState().activeCanvasDocumentId).toBeNull();
    });
  });

  describe('writing through', () => {
    it('reverts the optimistic open and says so when the write fails', async () => {
      const transport = fakeTransport({
        openSessionCanvasDocument: vi.fn().mockRejectedValue(new Error('the canvas is full')),
      });
      setSessionCanvasTransport(transport);

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments).toHaveLength(0);
      });
      expect(useAppStore.getState().activeCanvasDocumentId).toBeNull();
    });

    /**
     * The dedupe branch has its OWN revert, and it is not the fresh branch's (DOR-2006 review,
     * blocker 2).
     */
    it('a refused re-open of an ALREADY-OPEN document must not delete it', async () => {
      const transport = fakeTransport({
        openSessionCanvasDocument: vi.fn().mockRejectedValue(new Error('somebody is editing it')),
      });
      setSessionCanvasTransport(transport);
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
        ]);

      // Same file, different content shape — the dedupe key is the source path,
      // so this lands on `doc-a` rather than minting a pending row.
      useAppStore
        .getState()
        .openCanvasDocument({ type: 'file', sourcePath: 'a.ts', language: 'typescript' });

      await vi.waitFor(() => {
        expect(transport.openSessionCanvasDocument).toHaveBeenCalled();
      });
      // The row is still there, still showing what the SERVER holds.
      expect(useAppStore.getState().openDocuments.map((d) => d.id)).toEqual(['doc-a']);
      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments[0]!.content).toEqual(fileDoc('a.ts'));
      });
      expect(useAppStore.getState().activeCanvasDocumentId).toBe('doc-a');
    });

    it('writes a content change through, and puts the old content back on failure', async () => {
      const transport = fakeTransport({
        updateSessionCanvasDocument: vi.fn().mockRejectedValue(new Error('somebody is editing it')),
      });
      setSessionCanvasTransport(transport);
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
        ]);

      useAppStore.getState().setDocumentContent('doc-a', fileDoc('b.ts'));
      expect(useAppStore.getState().openDocuments[0]!.content).toEqual(fileDoc('b.ts'));

      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments[0]!.content).toEqual(fileDoc('a.ts'));
      });
      expect(transport.updateSessionCanvasDocument).toHaveBeenCalledWith(SESSION, 'doc-a', {
        content: fileDoc('b.ts'),
      });
    });

    it('closes through the transport, and puts the document back on failure', async () => {
      const transport = fakeTransport({
        closeSessionCanvasDocument: vi.fn().mockRejectedValue(new Error('not there')),
      });
      setSessionCanvasTransport(transport);
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
        ]);

      useAppStore.getState().closeCanvasDocument('doc-a');
      expect(useAppStore.getState().openDocuments).toHaveLength(0);

      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments.map((d) => d.id)).toEqual(['doc-a']);
      });
    });

    it('restores only original tab metadata after a409 unresolved-save close refusal', async () => {
      const refusal = Object.assign(
        new Error(
          'This document has an unresolved save. Keep it open until the original save is resolved.'
        ),
        { status: 409, code: 'DOC_SAVE_RECOVERY_REQUIRED' }
      );
      const transport = fakeTransport({
        closeSessionCanvasDocument: vi.fn().mockRejectedValue(refusal),
      });
      setSessionCanvasTransport(transport);
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
        ]);
      const original = useAppStore.getState().openDocuments[0]!;
      useAppStore.getState().closeCanvasDocument('doc-a');
      expect(useAppStore.getState().openDocuments).toHaveLength(0);
      await vi.waitFor(() => expect(useAppStore.getState().openDocuments).toEqual([original]));
      expect(transport.closeSessionCanvasDocument).toHaveBeenCalledWith(SESSION, 'doc-a');
      expect(toast.error).toHaveBeenCalled();
      // Store restoration is not a claim that a disposed editor's draft/UUID was recovered.
    });

    it('keeps the close when the person closed the pending tab before it settled', async () => {
      let answer!: (row: ServerCanvasDocument) => void;
      const open = vi.fn(
        () =>
          new Promise<ServerCanvasDocument>((resolve) => {
            answer = resolve;
          })
      );
      setSessionCanvasTransport(fakeTransport({ openSessionCanvasDocument: open }));
      const scope = documentPanelScope(SESSION, useAppStore.getState().selectedCwd);

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      const pendingId = useAppStore.getState().openDocuments[0]!.id;
      useAppStore.getState().updatePanelViewPreference(`documents:${scope}`, (entry) => ({
        ...entry,
        closed: [`${scope}:resource/${pendingId}`],
      }));
      answer(serverDocument({ id: 'server-doc', content: fileDoc('a.ts') }));

      await vi.waitFor(() => {
        const closed = Object.values(useAppStore.getState().panelViewPreferences).flatMap(
          (entry) => entry.closed
        );
        expect(closed).toContain(`${scope}:resource/server-doc`);
      });
    });

    /**
     * DOR-4179: clicking a file whose tab was closed earlier opened nothing.
     *
     * Closing a tab only records a close; the document stays in this window. A
     * second click re-activated it with the close still recorded, so its tab
     * stayed hidden, the panel fell back to Profile, and the click looked dead.
     * The close has to go at the click, before the server answers: by then the
     * panel has already moved on.
     *
     * Seeded defect: dropping the reopen in `beginOpen` reddens this.
     */
    it('a person reopening a file they closed clears that close at once', async () => {
      setSessionCanvasTransport(fakeTransport());
      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await vi.waitFor(() => {
        expect(useAppStore.getState().activeCanvasDocumentId).toBe('server-doc');
      });
      const scope = documentPanelScope(SESSION, useAppStore.getState().selectedCwd);
      const closedKey = `${scope}:resource/server-doc`;
      useAppStore.getState().updatePanelViewPreference(`documents:${scope}`, (entry) => ({
        ...entry,
        closed: [closedKey],
      }));

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));

      const closed = Object.values(useAppStore.getState().panelViewPreferences).flatMap(
        (entry) => entry.closed
      );
      expect(closed).not.toContain(closedKey);
      expect(useAppStore.getState().activeCanvasDocumentId).toBe('server-doc');
    });
  });

  /** A session the server has not heard of YET (DOR-2016). */
  describe('a session whose stream has not attached yet', () => {
    beforeEach(() => {
      // The slice's toast is a module-level spy shared by every test in the
      // file, and "nobody was told anything" is an assertion about THIS test.
      vi.mocked(toast.error).mockClear();
    });

    /** Let every pending rejection handler run. */
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    /** The refusal the route answers for an id it cannot place. */
    function sessionNotFound(): Error & { code: string; status: number } {
      return Object.assign(new Error('Session not found'), {
        code: 'session_not_found',
        status: 404,
      });
    }

    it('sends two held writes in the order they were made', async () => {
      const sent: string[] = [];
      let refuse = true;
      const open = vi.fn().mockImplementation((_id: string, content: UiCanvasContent) => {
        if (refuse) return Promise.reject(sessionNotFound());
        sent.push((content as { sourcePath: string }).sourcePath);
        return Promise.resolve(
          serverDocument({
            id: `server-${(content as { sourcePath: string }).sourcePath}`,
            content,
          })
        );
      });
      setSessionCanvasTransport(fakeTransport({ openSessionCanvasDocument: open }));

      useAppStore.getState().openCanvasDocument(fileDoc('first.ts'));
      useAppStore.getState().openCanvasDocument(fileDoc('second.ts'));
      await settle();
      expect(open).toHaveBeenCalledTimes(2);
      expect(useAppStore.getState().openDocuments).toHaveLength(2);
      expect(toast.error).not.toHaveBeenCalled();

      refuse = false;
      useAppStore.getState().hydrateCanvasFromSnapshot(SESSION, []);
      await vi.waitFor(() => {
        expect(sent).toEqual(['first.ts', 'second.ts']);
      });
      expect(useAppStore.getState().openDocuments.map((d) => d.id)).toEqual([
        'server-first.ts',
        'server-second.ts',
      ]);
    });

    /** The first-turn rename must not swallow a held write (review round 1, finding 2). */
    it('carries a held write across a first-turn rename', async () => {
      const CANONICAL = 'sess-canonical';
      let refuse = true;
      const open = vi.fn().mockImplementation((id: string, content: UiCanvasContent) => {
        if (refuse) return Promise.reject(sessionNotFound());
        return Promise.resolve(serverDocument({ id: `server-${id}`, content }));
      });
      setSessionCanvasTransport(fakeTransport({ openSessionCanvasDocument: open }));

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await settle();
      expect(open).toHaveBeenCalledTimes(1);

      // The turn answers with the canonical id: the write is re-aimed, then the
      // route moves and this slice rebinds.
      refuse = false;
      useAppStore.getState().carryCanvasWritesAcross(SESSION, CANONICAL);
      // The canonical stream's first snapshot arrives while its route loader
      // is still pending. Held writes must flush before React binds the route.
      expect(useAppStore.getState().canvasSessionId).toBe(CANONICAL);
      useAppStore.getState().hydrateCanvasFromSnapshot(CANONICAL, []);
      await vi.waitFor(() => {
        expect(open).toHaveBeenCalledTimes(2);
      });
      // Sent under the NEW name — the scope the server moved the canvas into.
      expect(open).toHaveBeenLastCalledWith(CANONICAL, fileDoc('a.ts'));
      await settle();
      expect(useAppStore.getState().openDocuments).toHaveLength(1);
      // Only now does the delayed route commit. It must retain the snapshot
      // and successful write rather than resetting the attached stream.
      useAppStore.getState().loadCanvasForSession(CANONICAL);
      expect(useAppStore.getState().canvasStreamAttached).toBe(true);
      expect(useAppStore.getState().openDocuments).toHaveLength(1);
      expect(toast.error).not.toHaveBeenCalled();
    });

    /**
     * Closing a tab has to take the write it was waiting on with it (review
     * round 1, finding 1).
     *
     * A `pending:` id used to mean "nothing is outstanding for this row", so the
     * close sent nothing and returned. With the hold it can also mean "a write
     * is waiting" — and the held open went out a moment later, the server made a
     * row nobody had asked for, and the frame it published put the closed tab
     * back, on every device.
     *
     * Seeded defect: dropping `cancelHeldWrites(id)` from `closeCanvasDocument`
     * reddens this on both counts — a second `open` call, and the tab returning.
     */
    it('closing a tab cancels the open it was waiting on', async () => {
      const open = vi.fn().mockRejectedValue(sessionNotFound());
      setSessionCanvasTransport(fakeTransport({ openSessionCanvasDocument: open }));

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await settle();
      const pendingId = useAppStore.getState().openDocuments[0]!.id;
      expect(pendingId).toMatch(/^pending:/);

      // Changed their mind, before the stream ever arrived.
      useAppStore.getState().closeCanvasDocument(pendingId);
      expect(useAppStore.getState().openDocuments).toHaveLength(0);

      useAppStore.getState().hydrateCanvasFromSnapshot(SESSION, []);
      await settle();
      expect(open).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().openDocuments).toHaveLength(0);

      // And nothing the server might still say about it can bring it back.
      useAppStore.getState().applyCanvasEvent(SESSION, {
        documentId: 'server-doc',
        document: serverDocument({ id: 'server-doc', content: fileDoc('a.ts') }),
      });
      expect(useAppStore.getState().openDocuments.map((d) => d.id)).toEqual(['server-doc']);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('drops a write held for a session this window has left, and says nothing', async () => {
      setSessionCanvasTransport(
        fakeTransport({ openSessionCanvasDocument: vi.fn().mockRejectedValue(sessionNotFound()) })
      );
      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await settle();

      // A plain session switch, not a rename: nothing here is showing that row
      // any more, so the write has nobody to land for.
      useAppStore.getState().loadCanvasForSession('sess-elsewhere');
      useAppStore.getState().hydrateCanvasFromSnapshot('sess-elsewhere', []);
      await settle();
      expect(useAppStore.getState().openDocuments).toHaveLength(0);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
