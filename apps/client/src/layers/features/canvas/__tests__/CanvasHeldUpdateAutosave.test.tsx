/**
 * What "Reload" must NOT do to the file on disk.
 *
 * Taking the agent's version ends the person's edit from outside the editor,
 * and the editor is usually mid-autosave when that happens: it debounces every
 * keystroke by 500 ms. If the pending timer survived, the draft the person just
 * gave up would be written to their file a moment after they chose the other
 * version — the exact clobber ADR-0292 exists to prevent, arriving late.
 *
 * Two cancel effects guard that (`CanvasMarkdownContent`, `CanvasFileContent`),
 * and deleting either left every other canvas test green. These are the cases
 * that go red instead. They use the REAL save hook over a mock `Transport`, so
 * what they assert is whether a WRITE went out — never whether a timer object
 * exists.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';

// Same for CodeMirror, which is what a non-markdown `file` document opens in.
vi.mock('../ui/CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    value,
    editable,
    onChange,
  }: {
    value: string;
    editable: boolean;
    onChange?: (v: string) => void;
  }) => (
    <div data-testid="codemirror" data-editable={String(editable)}>
      <span data-testid="cm-value">{value}</span>
      <button data-testid="type-a-keystroke" onClick={() => onChange?.('my draft, still unsaved')}>
        type
      </button>
    </div>
  ),
}));

// jsdom cannot load Milkdown/ProseMirror. The stub exposes a button that fires
// `onChange`, which stands in for a keystroke and arms the autosave debounce.
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({
    value,
    editable,
    onChange,
  }: {
    value: string;
    editable: boolean;
    onChange?: (md: string) => void;
  }) => (
    <div data-testid="blintz-canvas" data-editable={String(editable)}>
      <span data-testid="blintz-value">{value}</span>
      <button data-testid="type-a-keystroke" onClick={() => onChange?.('my draft, still unsaved')}>
        type
      </button>
    </div>
  ),
}));

import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { CanvasContent } from '../ui/CanvasViews';
import { CanvasFileContent } from '../ui/CanvasFileContent';

/** The autosave debounce the editors use, in ms. */
const AUTOSAVE_DELAY_MS = 500;

const MINE: UiCanvasContent = { type: 'markdown', content: 'v1', sourcePath: 'notes.md' };
const THEIRS: UiCanvasContent = { type: 'markdown', content: 'their v2', sourcePath: 'notes.md' };

/** The `file` variant of the same pair — a second editor, a second cancel effect. */
const MY_FILE: UiCanvasContent = { type: 'file', sourcePath: 'src/index.ts' };
const THEIR_FILE: UiCanvasContent = { type: 'file', sourcePath: 'src/index.ts', title: 'theirs' };

let transport: ReturnType<typeof createMockTransport>;

/** Wrap a canvas surface in the two providers its editors need. */
function renderWithProviders(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

/** The whole canvas body, banner included. */
function renderCanvas() {
  return renderWithProviders(<CanvasContent />);
}

/** The active document as the store currently holds it. */
function activeDoc() {
  const s = useAppStore.getState();
  return s.openDocuments.find((d) => d.id === s.activeCanvasDocumentId)!;
}

/** Open the document, start editing, and arm the autosave with one keystroke. */
async function editWithAPendingSave(): Promise<void> {
  act(() => {
    useAppStore.getState().openCanvasDocument(MINE);
    useAppStore.setState({ canvasOpen: true, selectedCwd: '/work' });
  });
  renderCanvas();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0); // resolve the lazy editor chunk
  });
  fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
  fireEvent.click(screen.getByTestId('type-a-keystroke'));
  expect(transport.writeFile).not.toHaveBeenCalled();
}

/** Push the agent's version at the document being edited. */
function agentPushes(): void {
  act(() => useAppStore.getState().updateActiveDocument(THEIRS));
}

describe('a pending autosave when the edit ends from outside', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    transport = createMockTransport();
    useAppStore.setState({
      canvasOpen: false,
      openDocuments: [],
      activeCanvasDocumentId: null,
      activeBrowserDocumentId: null,
      canvasSessionId: 'sess-1',
      selectedCwd: null,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('writes the draft when the person just keeps editing', async () => {
    // The probe for the two cases below: the same setup, no Reload, and the
    // debounced write really does go out. Without this, a broken cancel and a
    // broken keystroke would look identical.
    await editWithAPendingSave();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    });

    expect(transport.writeFile).toHaveBeenCalledTimes(1);
    expect(transport.writeFile).toHaveBeenCalledWith(
      '/work',
      'notes.md',
      'my draft, still unsaved',
      expect.anything()
    );
  });

  it('sends no write at all when Reload takes the agent version first', async () => {
    await editWithAPendingSave();
    agentPushes();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 4);
    });

    // The person chose the other version. Their abandoned draft must not turn up
    // in their file half a second later.
    expect(transport.writeFile).not.toHaveBeenCalled();
    expect(activeDoc().content).toEqual(THEIRS);
    expect(activeDoc().editing).toBe(false);
  });

  it('leaves a write that already went out alone, and adds none of its own', async () => {
    await editWithAPendingSave();
    // The debounce fires: the draft is on its way to disk.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    });
    expect(transport.writeFile).toHaveBeenCalledTimes(1);

    agentPushes();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 4);
    });

    // Reload changes what the canvas SHOWS, never the file. A second write here
    // would be the canvas racing the write it already sent.
    expect(transport.writeFile).toHaveBeenCalledTimes(1);
    expect(activeDoc().content).toEqual(THEIRS);
  });

  it('sends no write for a `file` document either — the other editor, the other effect', async () => {
    // `CanvasFileContent` owns its own copy of the cancel, because its edit mode
    // is owned by a parent rather than by the editor. Deleting either effect on
    // its own left every other canvas test green.
    //
    // Mounted directly rather than through the canvas body: `CanvasViews` loads
    // this viewer with `React.lazy`, and its Suspense boundary never resolves
    // under fake timers. The banner's own click is covered by the markdown
    // cases above; what this case owns is the effect, driven through the same
    // store action the banner calls.
    act(() => {
      useAppStore.getState().openCanvasDocument(MY_FILE);
      useAppStore.setState({ canvasOpen: true, selectedCwd: '/work' });
    });
    // Let the open settle before reading the id. A document is on screen the
    // instant it is opened, under a provisional id, and adopts the server's the
    // moment the write answers (spec `canvas-agent-seat` §1.5). `CanvasViews`
    // re-reads the active document every render and never notices; a test that
    // mounts a viewer DIRECTLY has to hold the settled id, or it is driving a
    // document that no longer exists.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const documentId = useAppStore.getState().activeCanvasDocumentId!;
    renderWithProviders(<CanvasFileContent documentId={documentId} content={MY_FILE} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    fireEvent.click(screen.getByTestId('type-a-keystroke'));
    act(() => useAppStore.getState().updateActiveDocument(THEIR_FILE));
    expect(activeDoc().heldUpdate).toEqual(THEIR_FILE);

    act(() => useAppStore.getState().applyHeldUpdate(documentId));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 4);
    });

    expect(transport.writeFile).not.toHaveBeenCalled();
    expect(activeDoc().editing).toBe(false);
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-editable', 'false');
  });

  it('keeps writing when the person answers Keep mine instead', async () => {
    await editWithAPendingSave();
    agentPushes();

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
    });

    // The edit is still running, so the draft still lands — the cancel must be
    // scoped to the edit ending, not to the notice going away.
    expect(transport.writeFile).toHaveBeenCalledTimes(1);
    expect(activeDoc().editing).toBe(true);
  });
});
