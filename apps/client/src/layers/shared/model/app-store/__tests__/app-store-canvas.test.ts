/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { MAX_CANVAS_DOCUMENTS } from '@/layers/shared/lib/constants';
import { useAppStore } from '../app-store';

/** Reset the canvas slice to an empty, session-bound state before each test. */
function resetCanvas(sessionId: string | null = 'sess-1') {
  localStorage.clear();
  useAppStore.setState({
    panelViewPreferences: {},
    canvasSessionCwd: undefined,
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

  it('never leaves Reload offering a version older than what is on screen', () => {
    // The scenario, which the re-open path used to get wrong: hold v2 while editing, stop editing
    // without answering, let v3 LAND through the same dedupe path, come back.
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

  it('loadCanvasForSession clears edit mode so a new session never inherits it', () => {
    const { openCanvasDocument, setDocumentEditing } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    setDocumentEditing(useAppStore.getState().activeCanvasDocumentId!, true);

    useAppStore.getState().loadCanvasForSession('sess-2');
    const docs = useAppStore.getState().openDocuments;
    expect(docs.every((d) => d.editing === false)).toBe(true);
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

  it('never evicts the document a view is showing, however stale it is', () => {
    const { openCanvasDocument } = useAppStore.getState();
    openCanvasDocument(browserDoc('https://first.test/'));
    const page = useAppStore.getState().activeBrowserDocumentId!;
    // A burst of agent-opened Canvas documents fills the shared cap.
    for (let i = 0; i <= MAX_CANVAS_DOCUMENTS; i++) openCanvasDocument(fileDoc(`file-${i}.ts`));

    const { openDocuments, activeBrowserDocumentId, activeCanvasDocumentId } =
      useAppStore.getState();
    expect(openDocuments).toHaveLength(MAX_CANVAS_DOCUMENTS);
    expect(activeBrowserDocumentId).toBe(page);
    expect(openDocuments.some((d) => d.id === page)).toBe(true);
    // And both views still point at something that is open.
    expect(openDocuments.some((d) => d.id === activeCanvasDocumentId)).toBe(true);
  });
});
