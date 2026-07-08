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
    const {
      openCanvasDocument,
      setActiveDocumentEditing,
      updateActiveDocument,
      activateCanvasDocument,
    } = useAppStore.getState();

    openCanvasDocument({ type: 'markdown', content: 'A1' });
    const docA = useAppStore.getState().activeDocumentId!;
    openCanvasDocument({ type: 'markdown', content: 'B1' });
    const docB = useAppStore.getState().activeDocumentId!;

    // Edit doc B; an agent push to B is ignored.
    setActiveDocumentEditing(true);
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

  it('setActiveDocumentContent writes unconditionally (the editor is the sole writer)', () => {
    const { openCanvasDocument, setActiveDocumentEditing, setActiveDocumentContent } =
      useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    setActiveDocumentEditing(true);
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
    const { openCanvasDocument, setActiveDocumentEditing } = useAppStore.getState();
    openCanvasDocument({ type: 'markdown', content: 'v1' });
    setActiveDocumentEditing(true);

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
