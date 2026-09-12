/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { CanvasDocument as ServerCanvasDocument } from '@dorkos/shared/room-schemas';
import { MAX_CANVAS_DOCUMENTS } from '@/layers/shared/lib/constants';
import { useAppStore } from '../app-store';

/** Reset the canvas slice to an empty, session-bound state before each test. */
function resetCanvas(sessionId: string | null = 'sess-1') {
  localStorage.clear();
  useAppStore.setState({
    canvasOpen: false,
    openDocuments: [],
    activeCanvasDocumentId: null,
    activeBrowserDocumentId: null,
    canvasSessionId: sessionId,
  });
}

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
    scope: 'session:sess-1',
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

describe('CanvasSlice — multi-document reducer', () => {
  beforeEach(() => resetCanvas());

  it('openCanvasDocument appends and activates each new document', () => {
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    openCanvasDocument(fileDoc('b.ts'));

    const { openDocuments, activeCanvasDocumentId } = useAppStore.getState();
    expect(openDocuments).toHaveLength(2);
    // The most-recently opened document is active.
    expect(openDocuments[1].id).toBe(activeCanvasDocumentId);
    expect(openDocuments.map((d) => (d.content as { sourcePath: string }).sourcePath)).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('dedups by source: re-opening the same path re-activates instead of duplicating', () => {
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    openCanvasDocument(fileDoc('b.ts'));
    openCanvasDocument(fileDoc('a.ts'));

    const { openDocuments, activeCanvasDocumentId } = useAppStore.getState();
    expect(openDocuments).toHaveLength(2);
    // The existing 'a.ts' document is re-activated, not appended.
    expect(
      (
        openDocuments.find((d) => d.id === activeCanvasDocumentId)!.content as {
          sourcePath: string;
        }
      ).sourcePath
    ).toBe('a.ts');
  });

  it('coalesces repeated diffs of one file onto a single document, labelled by base name (DOR-212)', () => {
    const { openCanvasDocument } = useAppStore.getState();
    const diffDoc = (path: string): UiCanvasContent => ({ type: 'diff', sourcePath: path });
    openCanvasDocument(diffDoc('src/App.tsx'));
    openCanvasDocument(diffDoc('src/App.tsx'));

    const { openDocuments, activeCanvasDocumentId } = useAppStore.getState();
    // A second edit to the same file refreshes the existing diff, no new tab.
    expect(openDocuments.filter((d) => d.content.type === 'diff')).toHaveLength(1);
    expect(openDocuments.find((d) => d.id === activeCanvasDocumentId)!.sourceLabel).toBe('App.tsx');
  });

  it('keeps a file document and its diff document separate (distinct source keys)', () => {
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('src/App.tsx'));
    openCanvasDocument({ type: 'diff', sourcePath: 'src/App.tsx' });

    expect(useAppStore.getState().openDocuments).toHaveLength(2);
  });

  it('dedups audio and video documents by src, keeping distinct sources apart', () => {
    const { openCanvasDocument } = useAppStore.getState();
    const audioDoc = (src: string): UiCanvasContent => ({ type: 'audio', src });
    openCanvasDocument(audioDoc('sounds/theme.mp3'));
    openCanvasDocument(audioDoc('sounds/theme.mp3'));
    openCanvasDocument({ type: 'video', src: 'clips/demo.mp4' });

    const { openDocuments } = useAppStore.getState();
    // Re-opening the same audio src re-activates the one doc; the video is a
    // distinct media source and opens its own tab.
    expect(openDocuments.filter((d) => d.content.type === 'audio')).toHaveLength(1);
    expect(openDocuments.filter((d) => d.content.type === 'video')).toHaveLength(1);
  });

  it('evicts the least-recently-active document past the cap', () => {
    const { openCanvasDocument } = useAppStore.getState();
    for (let i = 0; i <= MAX_CANVAS_DOCUMENTS; i++) {
      openCanvasDocument(fileDoc(`file-${i}.ts`));
    }
    const { openDocuments } = useAppStore.getState();
    expect(openDocuments).toHaveLength(MAX_CANVAS_DOCUMENTS);
    // The first-opened document (file-0) was evicted; the newest remains.
    const paths = openDocuments.map((d) => (d.content as { sourcePath: string }).sourcePath);
    expect(paths).not.toContain('file-0.ts');
    expect(paths).toContain(`file-${MAX_CANVAS_DOCUMENTS}.ts`);
  });

  it('updateActiveDocument mutates the active document content', () => {
    const { openCanvasDocument, updateActiveDocument } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    updateActiveDocument({ type: 'markdown', content: 'v2' });

    const active = useAppStore
      .getState()
      .openDocuments.find((d) => d.id === useAppStore.getState().activeCanvasDocumentId)!;
    expect((active.content as { content: string }).content).toBe('v2');
  });

  it('per-document edit-protection: agent push to an edited doc is held, other docs stay writable', () => {
    const { openCanvasDocument, setDocumentEditing, updateActiveDocument, activateCanvasDocument } =
      useAppStore.getState();

    openCanvasDocument({ type: 'markdown', content: 'A1' });
    const docA = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument({ type: 'markdown', content: 'B1' });
    const docB = useAppStore.getState().activeCanvasDocumentId!;

    // Edit doc B; an agent push to B is ignored.
    setDocumentEditing(docB, true);
    updateActiveDocument({ type: 'markdown', content: 'B2' });
    const bContent = () =>
      (
        useAppStore.getState().openDocuments.find((d) => d.id === docB)!.content as {
          content: string;
        }
      ).content;
    expect(bContent()).toBe('B1');

    // Switching to doc A (not being edited) leaves it agent-writable — isolation.
    activateCanvasDocument(docA);
    updateActiveDocument({ type: 'markdown', content: 'A2' });
    const aContent = (
      useAppStore.getState().openDocuments.find((d) => d.id === docA)!.content as {
        content: string;
      }
    ).content;
    expect(aContent).toBe('A2');
    // Doc B's protected content is untouched.
    expect(bContent()).toBe('B1');
  });

  it('a held push survives, then Reload applies it and Keep mine discards it (ADR-0292)', () => {
    const { openCanvasDocument, setDocumentEditing, updateActiveDocument } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'mine' });
    const doc = useAppStore.getState().activeCanvasDocumentId!;
    setDocumentEditing(doc, true);

    const read = () => useAppStore.getState().openDocuments.find((d) => d.id === doc)!;
    const body = () => (read().content as { content: string }).content;

    // The push is kept instead of vanishing — this is the whole ticket.
    updateActiveDocument({ type: 'markdown', content: 'theirs' });
    expect(body()).toBe('mine');
    expect(read().heldUpdate).toEqual({ type: 'markdown', content: 'theirs' });

    // Keep mine throws it away and leaves the edit running.
    useAppStore.getState().discardHeldUpdate(doc);
    expect(read().heldUpdate).toBeNull();
    expect(body()).toBe('mine');
    expect(read().editing).toBe(true);

    // Reload takes the agent's version and ends the edit.
    updateActiveDocument({ type: 'markdown', content: 'theirs again' });
    useAppStore.getState().applyHeldUpdate(doc);
    expect(body()).toBe('theirs again');
    expect(read().heldUpdate).toBeNull();
    expect(read().editing).toBe(false);
  });

  it('drops a stale hold once a newer push lands on a document nobody is editing', () => {
    const { openCanvasDocument, setDocumentEditing, updateActiveDocument } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    const doc = useAppStore.getState().activeCanvasDocumentId!;
    const read = () => useAppStore.getState().openDocuments.find((d) => d.id === doc)!;

    setDocumentEditing(doc, true);
    updateActiveDocument({ type: 'markdown', content: 'v2' });
    // The person stops editing WITHOUT answering the banner.
    setDocumentEditing(doc, false);
    updateActiveDocument({ type: 'markdown', content: 'v3' });

    // v3 landed, so offering v2 back would hand them a version older than what
    // they are looking at.
    expect((read().content as { content: string }).content).toBe('v3');
    expect(read().heldUpdate).toBeNull();
  });

  it('never leaves Reload offering a version older than what is on screen', () => {
    // The scenario, which the re-open path used to get wrong: hold v2 while
    // editing, stop editing without answering, let v3 LAND through the same
    // dedupe path, come back. A hold that survived that would put v2 — older
    // than the v3 on screen — behind the Reload button.
    const { openCanvasDocument, setDocumentEditing } = useAppStore.getState();
    const version = (n: string) =>
      ({ type: 'markdown', content: n, sourcePath: 'notes.md' }) as UiCanvasContent;

    openCanvasDocument(version('v1'));
    const doc = useAppStore.getState().activeCanvasDocumentId!;
    const read = () => useAppStore.getState().openDocuments.find((d) => d.id === doc)!;

    setDocumentEditing(doc, true);
    openCanvasDocument(version('v2'));
    expect(read().heldUpdate).toEqual(version('v2'));

    setDocumentEditing(doc, false);
    openCanvasDocument(version('v3'));

    expect((read().content as { content: string }).content).toBe('v3');
    expect(read().heldUpdate).toBeNull();

    // And the button that would have done the damage does nothing at all.
    useAppStore.getState().applyHeldUpdate(doc);
    expect((read().content as { content: string }).content).toBe('v3');
  });

  it('holds an open_canvas that re-opens a document being edited', () => {
    const { openCanvasDocument, setDocumentEditing } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'mine', sourcePath: 'notes.md' });
    const doc = useAppStore.getState().activeCanvasDocumentId!;
    setDocumentEditing(doc, true);

    // Same source key, so this re-opens the SAME document rather than adding one.
    openCanvasDocument({ type: 'markdown', content: 'theirs', sourcePath: 'notes.md' });

    const read = () => useAppStore.getState().openDocuments.find((d) => d.id === doc)!;
    expect(useAppStore.getState().openDocuments).toHaveLength(1);
    expect((read().content as { content: string }).content).toBe('mine');
    expect(read().heldUpdate).toEqual({
      type: 'markdown',
      content: 'theirs',
      sourcePath: 'notes.md',
    });
  });

  it('setDocumentEditing clears a NON-active document (unmount after a tab switch)', () => {
    const { openCanvasDocument, setDocumentEditing, activateCanvasDocument } =
      useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'A1' });
    const docA = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument({ type: 'markdown', content: 'B1' });
    const docB = useAppStore.getState().activeCanvasDocumentId!;

    // Edit B, then switch to A (B is no longer active) — simulating B's editor
    // unmounting on tab switch and clearing its own flag by id.
    setDocumentEditing(docB, true);
    activateCanvasDocument(docA);
    setDocumentEditing(docB, false);

    const b = useAppStore.getState().openDocuments.find((d) => d.id === docB)!;
    expect(b.editing).toBe(false);
  });

  it('setDocumentContent writes unconditionally (the editor is the sole writer)', () => {
    const { openCanvasDocument, setDocumentEditing, setDocumentContent } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    const id = useAppStore.getState().activeCanvasDocumentId!;
    setDocumentEditing(id, true);
    // Even while editing, the editor's own write lands.
    setDocumentContent(id, { type: 'markdown', content: 'edited' });
    const active = useAppStore
      .getState()
      .openDocuments.find((d) => d.id === useAppStore.getState().activeCanvasDocumentId)!;
    expect((active.content as { content: string }).content).toBe('edited');
  });

  it('closeCanvasDocument removes the doc and activates a remaining one', () => {
    const { openCanvasDocument, closeCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    const docA = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument(fileDoc('b.ts'));
    const docB = useAppStore.getState().activeCanvasDocumentId!;

    closeCanvasDocument(docB);
    const { openDocuments, activeCanvasDocumentId } = useAppStore.getState();
    expect(openDocuments).toHaveLength(1);
    expect(activeCanvasDocumentId).toBe(docA);
  });

  it('loadCanvasForSession clears edit mode so a new session never inherits it', () => {
    const { openCanvasDocument, setDocumentEditing } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    setDocumentEditing(useAppStore.getState().activeCanvasDocumentId!, true);

    useAppStore.getState().loadCanvasForSession('sess-2');
    const docs = useAppStore.getState().openDocuments;
    expect(docs.every((d) => d.editing === false)).toBe(true);
  });

  it('loadCanvasForSession empties the slice, ready for the snapshot to fill it', () => {
    // A RESET rather than a read. The table is the server's now (spec
    // `canvas-agent-seat` §1.5) and arrives on the session stream's cold
    // connect — so a switch that left the previous session's documents on
    // screen would be showing one session's canvas under another's name.
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    openCanvasDocument(fileDoc('b.ts'));
    expect(useAppStore.getState().openDocuments).toHaveLength(2);

    useAppStore.getState().loadCanvasForSession('sess-other');
    expect(useAppStore.getState().openDocuments).toHaveLength(0);
    expect(useAppStore.getState().canvasSessionId).toBe('sess-other');
  });
});

const browserDoc = (url: string): UiCanvasContent => ({ type: 'browser', url });

describe('CanvasSlice — per-document browser history (DOR-252)', () => {
  beforeEach(() => resetCanvas());

  it('writeBrowserHistory round-trips an entry for an open document', () => {
    const { openCanvasDocument, writeBrowserHistory } = useAppStore.getState();
    openCanvasDocument(browserDoc('https://a.test/'));
    const id = useAppStore.getState().activeBrowserDocumentId!;

    writeBrowserHistory(id, {
      contentUrl: 'https://a.test/',
      stack: ['https://a.test/', 'https://b.test/'],
      cursor: 1,
    });

    expect(useAppStore.getState().browserHistories[id]).toEqual({
      contentUrl: 'https://a.test/',
      stack: ['https://a.test/', 'https://b.test/'],
      cursor: 1,
    });
  });

  it('does NOT resurrect history for a document that is no longer open', () => {
    const { writeBrowserHistory } = useAppStore.getState();
    // No such document is open — a late write-through must be ignored.
    writeBrowserHistory('ghost', {
      contentUrl: 'https://x.test/',
      stack: ['https://x.test/'],
      cursor: 0,
    });
    expect(useAppStore.getState().browserHistories.ghost).toBeUndefined();
  });

  it('closeCanvasDocument prunes the closed document’s history', () => {
    const { openCanvasDocument, writeBrowserHistory, closeCanvasDocument } = useAppStore.getState();
    openCanvasDocument(browserDoc('https://a.test/'));
    const docA = useAppStore.getState().activeBrowserDocumentId!;
    openCanvasDocument(browserDoc('https://b.test/'));
    const docB = useAppStore.getState().activeBrowserDocumentId!;

    writeBrowserHistory(docA, {
      contentUrl: 'https://a.test/',
      stack: ['https://a.test/'],
      cursor: 0,
    });
    writeBrowserHistory(docB, {
      contentUrl: 'https://b.test/',
      stack: ['https://b.test/'],
      cursor: 0,
    });

    closeCanvasDocument(docB);
    expect(useAppStore.getState().browserHistories[docB]).toBeUndefined();
    // The surviving document keeps its history.
    expect(useAppStore.getState().browserHistories[docA]).toBeDefined();
  });

  it('LRU eviction prunes the evicted document’s history', () => {
    const { openCanvasDocument, writeBrowserHistory } = useAppStore.getState();
    // Open the first browser doc and record history for it.
    openCanvasDocument(browserDoc('https://first.test/'));
    const first = useAppStore.getState().activeBrowserDocumentId!;
    writeBrowserHistory(first, {
      contentUrl: 'https://first.test/',
      stack: ['https://first.test/'],
      cursor: 0,
    });
    // A second page, so the first is no longer the one the Browser view is
    // showing — a view's own document is never evicted (see the cap test below).
    openCanvasDocument(browserDoc('https://second.test/'));

    // Open enough more documents to push the first past the cap and evict it.
    for (let i = 0; i < MAX_CANVAS_DOCUMENTS; i++) {
      openCanvasDocument(fileDoc(`file-${i}.ts`));
    }

    const ids = new Set(useAppStore.getState().openDocuments.map((d) => d.id));
    expect(ids.has(first)).toBe(false); // evicted
    expect(useAppStore.getState().browserHistories[first]).toBeUndefined();
  });

  it('loadCanvasForSession clears browser histories (in-memory, per-session scope)', () => {
    const { openCanvasDocument, writeBrowserHistory } = useAppStore.getState();
    openCanvasDocument(browserDoc('https://a.test/'));
    const id = useAppStore.getState().activeBrowserDocumentId!;
    writeBrowserHistory(id, {
      contentUrl: 'https://a.test/',
      stack: ['https://a.test/'],
      cursor: 0,
    });
    expect(Object.keys(useAppStore.getState().browserHistories)).toHaveLength(1);

    useAppStore.getState().loadCanvasForSession('sess-2');
    expect(useAppStore.getState().browserHistories).toEqual({});
  });
});

describe('CanvasSlice — two views over one store (ADR 260911-200304)', () => {
  beforeEach(() => resetCanvas());

  it('opening a browser document activates the Browser view and leaves the Canvas view alone', () => {
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    const canvasDoc = useAppStore.getState().activeCanvasDocumentId!;

    openCanvasDocument(browserDoc('https://a.test/'));

    const { activeCanvasDocumentId, activeBrowserDocumentId, openDocuments } =
      useAppStore.getState();
    // One list, two views: the page did not take over the Canvas tab.
    expect(openDocuments).toHaveLength(2);
    expect(activeCanvasDocumentId).toBe(canvasDoc);
    expect(activeBrowserDocumentId).not.toBe(canvasDoc);
    expect(
      useAppStore.getState().openDocuments.find((d) => d.id === activeBrowserDocumentId)!.content
        .type
    ).toBe('browser');
  });

  it('each view remembers its own document across a switch back and forth', () => {
    const { openCanvasDocument, activateCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    const fileA = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument(browserDoc('https://a.test/'));
    const pageA = useAppStore.getState().activeBrowserDocumentId!;
    openCanvasDocument(fileDoc('b.ts'));
    const fileB = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument(browserDoc('https://b.test/'));
    const pageB = useAppStore.getState().activeBrowserDocumentId!;

    expect([fileA, pageA, fileB, pageB]).toHaveLength(new Set([fileA, pageA, fileB, pageB]).size);
    expect(useAppStore.getState().activeCanvasDocumentId).toBe(fileB);
    expect(useAppStore.getState().activeBrowserDocumentId).toBe(pageB);

    // Re-activating a document in one view never touches the other's selection.
    activateCanvasDocument(fileA);
    expect(useAppStore.getState().activeCanvasDocumentId).toBe(fileA);
    expect(useAppStore.getState().activeBrowserDocumentId).toBe(pageB);

    activateCanvasDocument(pageA);
    expect(useAppStore.getState().activeBrowserDocumentId).toBe(pageA);
    expect(useAppStore.getState().activeCanvasDocumentId).toBe(fileA);
  });

  it('closing the active document picks the next one in ITS view, never the other view’s', () => {
    const { openCanvasDocument, closeCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    const fileA = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument(fileDoc('b.ts'));
    const fileB = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument(browserDoc('https://a.test/'));
    const page = useAppStore.getState().activeBrowserDocumentId!;

    closeCanvasDocument(fileB);
    // The Canvas view falls back to its own survivor — not to the page, which is
    // the most-recently-active document overall.
    expect(useAppStore.getState().activeCanvasDocumentId).toBe(fileA);
    expect(useAppStore.getState().activeBrowserDocumentId).toBe(page);

    closeCanvasDocument(page);
    expect(useAppStore.getState().activeBrowserDocumentId).toBeNull();
    expect(useAppStore.getState().activeCanvasDocumentId).toBe(fileA);
  });

  it('updateActiveDocument routes a page push to the Browser view, leaving the Canvas document intact', () => {
    const { openCanvasDocument, updateActiveDocument } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'notes' });
    const doc = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument(browserDoc('https://a.test/'));

    updateActiveDocument({ type: 'browser', url: 'https://b.test/' });

    const byId = (id: string) => useAppStore.getState().openDocuments.find((d) => d.id === id)!;
    // Before the split this overwrote whichever document was active — here, the
    // markdown one — turning a document into a page under the reader.
    expect(byId(doc).content).toEqual({ type: 'markdown', content: 'notes' });
    expect(byId(useAppStore.getState().activeBrowserDocumentId!).content).toEqual({
      type: 'browser',
      url: 'https://b.test/',
    });
  });

  it('never evicts the document a view is showing, however stale it is', () => {
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(browserDoc('https://first.test/'));
    const page = useAppStore.getState().activeBrowserDocumentId!;
    // A burst of agent-opened Canvas documents fills the shared cap. The page is
    // the least-recently-active of them all — `lastActiveAt` moves on open and
    // activate, never on a tab switch — so a plain LRU takes the one document
    // the reader is sitting on in the other tab.
    for (let i = 0; i <= MAX_CANVAS_DOCUMENTS; i++) openCanvasDocument(fileDoc(`file-${i}.ts`));

    const { openDocuments, activeBrowserDocumentId, activeCanvasDocumentId } =
      useAppStore.getState();
    expect(openDocuments).toHaveLength(MAX_CANVAS_DOCUMENTS);
    expect(activeBrowserDocumentId).toBe(page);
    expect(openDocuments.some((d) => d.id === page)).toBe(true);
    // And both views still point at something that is open.
    expect(openDocuments.some((d) => d.id === activeCanvasDocumentId)).toBe(true);
  });

  it('re-derives both active ids when a snapshot hydrates the table', () => {
    // The pair used to round-trip through `localStorage`. They are re-derived
    // from the server's rows instead, and the property that matters is the same
    // one: neither view is left pointing at a document that is gone while it
    // still holds tabs (spec `canvas-agent-seat` §1.5).
    useAppStore.getState().loadCanvasForSession('sess-1');
    useAppStore
      .getState()
      .hydrateCanvasFromSnapshot('sess-1', [
        serverDocument({ id: 'doc-file', content: fileDoc('a.ts') }),
        serverDocument({ id: 'doc-page', content: browserDoc('https://a.test/') }),
      ]);

    expect(useAppStore.getState().activeCanvasDocumentId).toBe('doc-file');
    expect(useAppStore.getState().activeBrowserDocumentId).toBe('doc-page');
  });
});
