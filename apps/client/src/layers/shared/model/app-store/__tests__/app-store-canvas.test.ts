/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { MAX_CANVAS_DOCUMENTS } from '@/layers/shared/lib';
import { useAppStore } from '../app-store';

/** Reset the canvas slice to an empty, session-bound state before each test. */
function resetCanvas(sessionId: string | null = 'sess-1') {
  localStorage.clear();
  useAppStore.setState({
    canvasOpen: false,
    openDocuments: [],
    activeDocumentId: null,
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

    const { openDocuments, activeDocumentId } = useAppStore.getState();
    expect(openDocuments).toHaveLength(2);
    // The most-recently opened document is active.
    expect(openDocuments[1].id).toBe(activeDocumentId);
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

    const { openDocuments, activeDocumentId } = useAppStore.getState();
    expect(openDocuments).toHaveLength(2);
    // The existing 'a.ts' document is re-activated, not appended.
    expect(
      (openDocuments.find((d) => d.id === activeDocumentId)!.content as { sourcePath: string })
        .sourcePath
    ).toBe('a.ts');
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
      .openDocuments.find((d) => d.id === useAppStore.getState().activeDocumentId)!;
    expect((active.content as { content: string }).content).toBe('v2');
  });

  it('per-document edit-protection: agent push to an edited doc is held, other docs stay writable', () => {
    const { openCanvasDocument, setDocumentEditing, updateActiveDocument, activateCanvasDocument } =
      useAppStore.getState();

    openCanvasDocument({ type: 'markdown', content: 'A1' });
    const docA = useAppStore.getState().activeDocumentId!;
    openCanvasDocument({ type: 'markdown', content: 'B1' });
    const docB = useAppStore.getState().activeDocumentId!;

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
    const docA = useAppStore.getState().activeDocumentId!;
    openCanvasDocument({ type: 'markdown', content: 'B1' });
    const docB = useAppStore.getState().activeDocumentId!;

    // Edit B, then switch to A (B is no longer active) — simulating B's editor
    // unmounting on tab switch and clearing its own flag by id.
    setDocumentEditing(docB, true);
    activateCanvasDocument(docA);
    setDocumentEditing(docB, false);

    const b = useAppStore.getState().openDocuments.find((d) => d.id === docB)!;
    expect(b.editing).toBe(false);
  });

  it('setActiveDocumentContent writes unconditionally (the editor is the sole writer)', () => {
    const { openCanvasDocument, setDocumentEditing, setActiveDocumentContent } =
      useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    setDocumentEditing(useAppStore.getState().activeDocumentId!, true);
    // Even while editing, the editor's own write lands.
    setActiveDocumentContent({ type: 'markdown', content: 'edited' });
    const active = useAppStore
      .getState()
      .openDocuments.find((d) => d.id === useAppStore.getState().activeDocumentId)!;
    expect((active.content as { content: string }).content).toBe('edited');
  });

  it('closeCanvasDocument removes the doc and activates a remaining one', () => {
    const { openCanvasDocument, closeCanvasDocument } = useAppStore.getState();
    openCanvasDocument(fileDoc('a.ts'));
    const docA = useAppStore.getState().activeDocumentId!;
    openCanvasDocument(fileDoc('b.ts'));
    const docB = useAppStore.getState().activeDocumentId!;

    closeCanvasDocument(docB);
    const { openDocuments, activeDocumentId } = useAppStore.getState();
    expect(openDocuments).toHaveLength(1);
    expect(activeDocumentId).toBe(docA);
  });

  it('loadCanvasForSession clears edit mode so a new session never inherits it', () => {
    const { openCanvasDocument, setDocumentEditing } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    setDocumentEditing(useAppStore.getState().activeDocumentId!, true);

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
    const id = useAppStore.getState().activeDocumentId!;

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
    const docA = useAppStore.getState().activeDocumentId!;
    openCanvasDocument(browserDoc('https://b.test/'));
    const docB = useAppStore.getState().activeDocumentId!;

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
    const first = useAppStore.getState().activeDocumentId!;
    writeBrowserHistory(first, {
      contentUrl: 'https://first.test/',
      stack: ['https://first.test/'],
      cursor: 0,
    });

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
    const id = useAppStore.getState().activeDocumentId!;
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
