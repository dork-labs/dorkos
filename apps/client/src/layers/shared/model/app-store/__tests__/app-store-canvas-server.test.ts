/**
 * @vitest-environment jsdom
 */
/**
 * The canvas slice as a view of the SERVER's table (spec `canvas-agent-seat`
 * §1.5).
 *
 * Three properties, and each one is today's bug reappearing one layer up if it
 * is wrong: a window that hydrates from the snapshot, a mutator that writes
 * through and puts the screen back when the write fails, and a `rev` tiebreak
 * that lets a second device's write win in order while this window's own echo
 * changes nothing.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Applying an arriving frame regardless of `rev` reddens the stale-frame test,
 *   and would let this window's own echo overwrite a newer row.
 * - Leaving the optimistic row in place when the POST rejects reddens the revert
 *   test, and would leave the window showing a document the server never got —
 *   the exact divergence the move to the server removes.
 * - Landing an arriving frame on a document somebody is typing in reddens the
 *   held-update test, and would take their draft.
 *
 * @module shared/model/app-store/tests/app-store-canvas-server
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import { MAX_CANVAS_DOCUMENTS } from '@/layers/shared/lib/constants';
import { useAppStore } from '../app-store';
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
    useAppStore.getState().loadCanvasForSession(SESSION);
  });

  afterEach(() => {
    setSessionCanvasTransport(null);
    vi.restoreAllMocks();
  });

  describe('hydration', () => {
    it('fills the slice from the snapshot, in the order the server sent', () => {
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
          serverDocument({ id: 'doc-b', content: fileDoc('b.ts') }),
        ]);
      expect(useAppStore.getState().openDocuments.map((d) => d.id)).toEqual(['doc-a', 'doc-b']);
    });

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

    it('ignores a snapshot for a session this window has left', () => {
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot('sess-other', [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
        ]);
      expect(useAppStore.getState().openDocuments).toHaveLength(0);
    });
  });

  /**
   * The cap is the SERVER's rule, applied here too (DOR-2006 review, 9 / 10a).
   *
   * Two LRUs over one table is two answers: when this window counted pinned
   * rows toward the twelve, thirteen documents with two pinned had it evict
   * locally what the server keeps — and the next hydrate simply put the row
   * back, which is the divergence §1.5 exists to remove.
   */
  describe('the cap', () => {
    it('does not count pinned documents, exactly as the server does not', () => {
      const documents = Array.from({ length: MAX_CANVAS_DOCUMENTS + 2 }, (_, i) => ({
        ...serverDocument({ id: `doc-${i}`, content: fileDoc(`file-${i}.ts`) }),
        pinned: i < 2,
      }));
      useAppStore.getState().hydrateCanvasFromSnapshot(SESSION, documents);
      expect(useAppStore.getState().openDocuments).toHaveLength(MAX_CANVAS_DOCUMENTS + 2);

      // One more arrives from another window. Twelve unpinned is the cap, so
      // this evicts one unpinned row and leaves both pins alone.
      useAppStore.getState().applyCanvasEvent(SESSION, {
        documentId: 'doc-new',
        document: serverDocument({ id: 'doc-new', content: fileDoc('file-new.ts') }),
        change: 'opened',
      });

      const open = useAppStore.getState().openDocuments;
      expect(open.filter((d) => !d.pinned)).toHaveLength(MAX_CANVAS_DOCUMENTS);
      expect(open.filter((d) => d.pinned).map((d) => d.id)).toEqual(['doc-0', 'doc-1']);
    });
  });

  describe('the canvas event', () => {
    beforeEach(() => {
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts'), rev: 5 }),
        ]);
    });

    it('adds a document another window opened', () => {
      useAppStore.getState().applyCanvasEvent(SESSION, {
        documentId: 'doc-b',
        document: serverDocument({ id: 'doc-b', content: fileDoc('b.ts') }),
        change: 'opened',
      });
      expect(useAppStore.getState().openDocuments.map((d) => d.id)).toEqual(['doc-a', 'doc-b']);
    });

    it('applies an update with a HIGHER rev', () => {
      useAppStore.getState().applyCanvasEvent(SESSION, {
        documentId: 'doc-a',
        document: serverDocument({ id: 'doc-a', content: fileDoc('renamed.ts'), rev: 6 }),
        change: 'updated',
      });
      const held = useAppStore.getState().openDocuments[0]!;
      expect(held.content).toEqual(fileDoc('renamed.ts'));
      expect(held.rev).toBe(6);
    });

    it('DROPS a frame whose rev is not greater — the echo of your own write', () => {
      useAppStore.getState().applyCanvasEvent(SESSION, {
        documentId: 'doc-a',
        document: serverDocument({ id: 'doc-a', content: fileDoc('stale.ts'), rev: 5 }),
        change: 'updated',
      });
      expect(useAppStore.getState().openDocuments[0]!.content).toEqual(fileDoc('a.ts'));
    });

    it('removes a closed document', () => {
      useAppStore.getState().applyCanvasEvent(SESSION, { documentId: 'doc-a', closed: true });
      expect(useAppStore.getState().openDocuments).toHaveLength(0);
      expect(useAppStore.getState().activeCanvasDocumentId).toBeNull();
    });

    it('HOLDS an arrival for the banner while somebody is typing in that document', () => {
      // ADR-0292's rule, over the wire: a frame that landed underneath an editor
      // would take the draft, which is the silent drop the held update exists to
      // remove.
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

    it('ignores an event for a session this window has left', () => {
      useAppStore.getState().applyCanvasEvent('sess-other', {
        documentId: 'doc-a',
        closed: true,
      });
      expect(useAppStore.getState().openDocuments).toHaveLength(1);
    });
  });

  describe('writing through', () => {
    it('opens optimistically, then adopts the id the server answered with', async () => {
      const transport = fakeTransport();
      setSessionCanvasTransport(transport);

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      // On screen immediately, under a pending id.
      expect(useAppStore.getState().openDocuments[0]!.id).toMatch(/^pending:/);

      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments[0]!.id).toBe('server-doc');
      });
      expect(transport.openSessionCanvasDocument).toHaveBeenCalledWith(SESSION, fileDoc('a.ts'));
      // And the view that was showing the pending row follows it.
      expect(useAppStore.getState().activeCanvasDocumentId).toBe('server-doc');
    });

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
     * The dedupe branch has its OWN revert, and it is not the fresh branch's
     * (DOR-2006 review, blocker 2).
     *
     * Re-opening a file that is already on the canvas resolves onto the existing
     * row rather than minting one. The single revert removed `pendingId` — which
     * on that branch IS the real document's id — so a routine refusal (a 409
     * while somebody types in it) deleted a row the server still holds, in the
     * one window that asked. That is the divergence §1.5 exists to remove,
     * reintroduced by the recovery path.
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

    it('takes and releases the edit lock on the server', async () => {
      const transport = fakeTransport();
      setSessionCanvasTransport(transport);
      useAppStore
        .getState()
        .hydrateCanvasFromSnapshot(SESSION, [
          serverDocument({ id: 'doc-a', content: fileDoc('a.ts') }),
        ]);

      useAppStore.getState().setDocumentEditing('doc-a', true);
      expect(transport.setSessionCanvasEditing).toHaveBeenCalledWith(SESSION, 'doc-a', true);
      useAppStore.getState().setDocumentEditing('doc-a', false);
      expect(transport.setSessionCanvasEditing).toHaveBeenCalledWith(SESSION, 'doc-a', false);
    });

    it('writes nothing at all with no transport bound — a purely local window', () => {
      // A shell with no server, and every test that has not asked for one. The
      // optimistic apply stands on its own, which is what this slice always did.
      expect(() => useAppStore.getState().openCanvasDocument(fileDoc('a.ts'))).not.toThrow();
      expect(useAppStore.getState().openDocuments).toHaveLength(1);
    });
  });

  /**
   * A session the server has not heard of YET (DOR-2016).
   *
   * `POST /api/sessions/:id/canvas` refuses an id no projector and no runtime
   * binding knows, which is what keeps a canvas out of a scope nothing can ever
   * reclaim. The window it leaves open is small and completely ordinary: a
   * session that has never taken a turn, and a person who opens a file from the
   * tree as their very first action, before the durable stream has attached. The
   * open was reverted and they were told "Session not found" about a session
   * they were looking at.
   *
   * Seeded defects, each run red before the fix stood:
   *
   * - Reverting on that refusal (the old `writeThrough` catch) reddens the two
   *   held-write cases: the tab disappears and the toast is spoken.
   * - Replacing `openDocuments` wholesale on hydrate reddens the settle case:
   *   the snapshot takes the optimistic row off screen and the retry's answer
   *   has nothing left to land on.
   * - Firing the held writes together instead of in sequence reddens the order
   *   case about half the time; sequencing makes it deterministic.
   */
  describe('a session whose stream has not attached yet', () => {
    beforeEach(() => {
      // The slice's toast is a module-level spy shared by every test in the
      // file, and "nobody was told anything" is an assertion about THIS test.
      vi.mocked(toast.error).mockClear();
    });

    /**
     * Let every pending rejection handler run.
     *
     * `vi.waitFor` on the call count returns while the request's own rejection
     * is still a queued microtask, so a test that asserted straight afterwards
     * would be measuring the moment BEFORE the slice decided anything — and
     * would pass whatever the slice went on to do.
     */
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    /** The refusal the route answers for an id it cannot place. */
    function sessionNotFound(): Error & { code: string; status: number } {
      return Object.assign(new Error('Session not found'), {
        code: 'SESSION_NOT_FOUND',
        status: 404,
      });
    }

    it('keeps the document on screen and says nothing, then lands it on attach', async () => {
      const open = vi
        .fn()
        .mockRejectedValueOnce(sessionNotFound())
        .mockImplementation((_id: string, content: UiCanvasContent) =>
          Promise.resolve(serverDocument({ id: 'server-doc', content }))
        );
      setSessionCanvasTransport(fakeTransport({ openSessionCanvasDocument: open }));

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await settle();
      expect(open).toHaveBeenCalledTimes(1);
      // Still there, still theirs, and nobody was told anything went wrong.
      expect(useAppStore.getState().openDocuments).toHaveLength(1);
      expect(useAppStore.getState().openDocuments[0]!.id).toMatch(/^pending:/);
      expect(toast.error).not.toHaveBeenCalled();

      // The stream attaches: an empty snapshot, because the server really does
      // hold nothing for this session yet.
      useAppStore.getState().hydrateCanvasFromSnapshot(SESSION, []);
      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments[0]!.id).toBe('server-doc');
      });
      expect(open).toHaveBeenCalledTimes(2);
      expect(toast.error).not.toHaveBeenCalled();
      expect(useAppStore.getState().activeCanvasDocumentId).toBe('server-doc');
    });

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

    it('reverts and says so for a session that really is not there', async () => {
      setSessionCanvasTransport(
        fakeTransport({ openSessionCanvasDocument: vi.fn().mockRejectedValue(sessionNotFound()) })
      );
      // The stream attached and the server answered: this window knows the
      // session exists. A refusal now is the ghost-id 404 the route is for.
      useAppStore.getState().hydrateCanvasFromSnapshot(SESSION, []);

      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments).toHaveLength(0);
      });
      expect(toast.error).toHaveBeenCalledWith(
        'That did not reach your canvas',
        expect.objectContaining({ description: 'Session not found' })
      );
    });

    it('gives up after one retry, rather than holding a write for ever', async () => {
      setSessionCanvasTransport(
        fakeTransport({ openSessionCanvasDocument: vi.fn().mockRejectedValue(sessionNotFound()) })
      );
      useAppStore.getState().openCanvasDocument(fileDoc('a.ts'));
      await settle();
      expect(useAppStore.getState().openDocuments).toHaveLength(1);

      useAppStore.getState().hydrateCanvasFromSnapshot(SESSION, []);
      await vi.waitFor(() => {
        expect(useAppStore.getState().openDocuments).toHaveLength(0);
      });
      expect(toast.error).toHaveBeenCalled();
    });
  });
});
