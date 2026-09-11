/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { MAX_CANVAS_DOCUMENTS, STORAGE_KEYS } from '@/layers/shared/lib/constants';
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

  it('persists the document array per session and rehydrates it', () => {
    const { openCanvasDocument, setCanvasOpen } = useAppStore.getState();
    setCanvasOpen(true);
    openCanvasDocument(fileDoc('a.ts'));
    openCanvasDocument(fileDoc('b.ts'));

    // Switch away and back — the documents rehydrate from localStorage.
    useAppStore.getState().loadCanvasForSession('sess-other');
    expect(useAppStore.getState().openDocuments).toHaveLength(0);
    useAppStore.getState().loadCanvasForSession('sess-1');
    expect(useAppStore.getState().openDocuments).toHaveLength(2);
    expect(useAppStore.getState().canvasOpen).toBe(true);
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

  it('hydrates a legacy entry whose single active id named a page', () => {
    // Exactly what a browser that last ran before the split has on disk: one
    // `activeDocumentId`, pointing at a `url` document.
    localStorage.setItem(
      STORAGE_KEYS.CANVAS_SESSIONS,
      JSON.stringify({
        'sess-legacy': {
          open: true,
          documents: [
            {
              id: 'doc-md',
              content: { type: 'markdown', content: 'notes' },
              openedAt: 1,
              lastActiveAt: 1,
              sourceLabel: 'Document',
            },
            {
              id: 'doc-page',
              content: { type: 'url', url: 'https://a.test/' },
              openedAt: 2,
              lastActiveAt: 2,
              sourceLabel: 'a.test',
            },
          ],
          activeDocumentId: 'doc-page',
          accessedAt: 2,
        },
      })
    );

    useAppStore.getState().loadCanvasForSession('sess-legacy');

    const { openDocuments, activeBrowserDocumentId, activeCanvasDocumentId, canvasOpen } =
      useAppStore.getState();
    expect(canvasOpen).toBe(true);
    expect(openDocuments).toHaveLength(2);
    // The old active id belonged to the Browser view, and the Canvas view still
    // gets its own document rather than a splash above a full tab strip.
    expect(activeBrowserDocumentId).toBe('doc-page');
    expect(activeCanvasDocumentId).toBe('doc-md');
  });

  it('round-trips both active ids through localStorage', () => {
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    const file = useAppStore.getState().activeCanvasDocumentId!;
    openCanvasDocument(browserDoc('https://a.test/'));
    const page = useAppStore.getState().activeBrowserDocumentId!;

    useAppStore.getState().loadCanvasForSession('sess-other');
    useAppStore.getState().loadCanvasForSession('sess-1');

    expect(useAppStore.getState().activeCanvasDocumentId).toBe(file);
    expect(useAppStore.getState().activeBrowserDocumentId).toBe(page);
  });
});
