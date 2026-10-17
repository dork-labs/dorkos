/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mutable mock store — the component reads canvasSessionId/selectedCwd reactively
// (via selectors) and live (via getState() inside callbacks), and calls
// setDocumentEditing(id, editing) to flag this document's per-document edit mode.
/**
 * The per-document edit flag the editor writes with `setDocumentEditing` — and,
 * since notify-and-reconcile, READS back: "Reload" on the held-update banner
 * ends the edit from outside, and the editor follows the store out of edit mode.
 * A mock that swallowed the write would leave the editor stuck in edit mode
 * against a store that says otherwise, which is the state the effect exists to
 * resolve.
 */
const mockState = {
  canvasSessionId: 'sess-A' as string | null,
  selectedCwd: '/work' as string | null,
  openDocuments: [{ id: 'doc-1', editing: false }],
  setDocumentEditing: vi.fn((id: string, editing: boolean) => {
    mockState.openDocuments = mockState.openDocuments.map((d) =>
      d.id === id ? { ...d, editing } : d
    );
  }),
};

/** Document id passed to the editor under test. */
const DOC_ID = 'doc-1';

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  return { useAppStore };
});

// The save hook is unit-tested separately; here we control it so the component
// test stays focused on edit toggling, autosave, and conflict UI
// (and off the real crypto/transport).
const mockFileSave = {
  status: 'idle' as 'idle' | 'saving' | 'saved' | 'error' | 'conflict',
  conflict: null as { currentHash: string; currentContent: string } | null,
  canSave: true,
  save: vi.fn(),
  prepareFinalSave: (content: string) => ({
    cancel: vi.fn(),
    flush: () => mockFileSave.save(content),
  }),
  overwrite: vi.fn(),
  adoptDisk: vi.fn(),
};
vi.mock('../model/use-canvas-file-save', () => ({
  useCanvasFileSave: () => mockFileSave,
}));

// The Docs feature, switched on and off per test. Its own gate is tested in
// features/docs; here the question is what the markdown canvas does with it.
// Wiki links are tested there too, and stay off here.
const docs = vi.hoisted(() => ({ embeds: undefined as Record<string, unknown> | undefined }));
vi.mock('@/layers/features/docs', () => ({
  useDocWikiLinks: () => undefined,
  useDocEmbeds: () => docs.embeds,
  SaveAsWebPageButton: ({ markdown, sourcePath }: { markdown: string; sourcePath: string }) =>
    docs.embeds ? (
      <button type="button" data-testid="save-web-page" data-source={sourcePath}>
        {markdown}
      </button>
    ) : null,
}));

// Mock the heavy Blintz wrapper: jsdom never loads the real editor. The stub
// surfaces `value`/`editable`, whether it got embeds, and a button that fires
// `onChange`, standing in for a keystroke.
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({
    value,
    editable,
    onChange,
    embeds,
  }: {
    value: string;
    editable: boolean;
    onChange?: (md: string) => void;
    embeds?: Record<string, unknown>;
  }) => (
    <div
      data-testid="blintz-canvas"
      data-editable={String(editable)}
      data-embeds={embeds ? Object.keys(embeds).join(',') : 'none'}
    >
      <span data-testid="blintz-value">{value}</span>
      <button data-testid="blintz-fire-change" onClick={() => onChange?.('edited body')}>
        fire change
      </button>
    </div>
  ),
}));

import type { UiCanvasContent } from '@dorkos/shared/types';
import { CanvasMarkdownContent } from '../ui/CanvasMarkdownContent';

type MarkdownContent = Extract<UiCanvasContent, { type: 'markdown' }>;

const FM = '---\ntitle: T\n---\n';
const fileBacked = {
  type: 'markdown' as const,
  content: `${FM}\n# Body\n\ntext\n`,
  title: 'Doc',
  sourcePath: 'doc.md',
};
const generated = { type: 'markdown' as const, content: '# Generated\n\nno file\n' };

afterEach(cleanup);

describe('CanvasMarkdownContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.openDocuments = [{ id: 'doc-1', editing: false }];
    mockState.canvasSessionId = 'sess-A';
    mockState.selectedCwd = '/work';
    mockFileSave.status = 'idle';
    mockFileSave.conflict = null;
    mockFileSave.canSave = true;
    mockFileSave.adoptDisk.mockReturnValue(undefined);
    docs.embeds = undefined;
  });

  async function renderEditor(content: MarkdownContent = fileBacked, onContentChange = vi.fn()) {
    render(
      <CanvasMarkdownContent
        documentId={DOC_ID}
        content={content}
        onContentChange={onContentChange}
      />
    );
    await screen.findByTestId('blintz-canvas');
    return onContentChange;
  }

  it('renders read-only with the whole document (frontmatter handed to Blintz)', async () => {
    await renderEditor();
    const editor = screen.getByTestId('blintz-canvas');
    expect(editor).toHaveAttribute('data-editable', 'false');
    // Blintz round-trips frontmatter itself, so the whole document is handed in.
    expect(screen.getByTestId('blintz-value')).toHaveTextContent('title: T');
    expect(screen.getByTestId('blintz-value')).toHaveTextContent('# Body');
    expect(screen.getByRole('button', { name: 'Edit document' })).toBeInTheDocument();
  });

  it('offers no edit control for generated (non-file-backed) content', async () => {
    mockFileSave.canSave = false;
    await renderEditor(generated);
    expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-editable', 'false');
    expect(screen.queryByRole('button', { name: 'Edit document' })).not.toBeInTheDocument();
  });

  it('enters edit mode: editable, seeds the document draft, flags canvasEditing', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-editable', 'true');
    expect(screen.getByTestId('blintz-value')).toHaveTextContent('title: T');
    expect(screen.getByTestId('blintz-value')).toHaveTextContent('# Body');
    expect(mockFileSave.save).not.toHaveBeenCalled();
    expect(mockState.setDocumentEditing).toHaveBeenCalledWith(DOC_ID, true);
    expect(screen.getByRole('button', { name: 'Finish editing' })).toBeInTheDocument();
  });

  it('autosaves the edited document to the file', async () => {
    const onContentChange = await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.click(screen.getByTestId('blintz-fire-change'));

    // Blintz emits the whole document (frontmatter included); no host re-glue.
    await waitFor(() => expect(mockFileSave.save).toHaveBeenCalledWith('edited body'), {
      timeout: 2000,
    });
    expect(onContentChange).toHaveBeenCalledWith({ ...fileBacked, content: 'edited body' });
  });

  it('flushes the pending draft immediately when leaving edit mode', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.click(screen.getByTestId('blintz-fire-change'));
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
    expect(mockFileSave.save).toHaveBeenCalledWith('edited body');
    expect(mockState.setDocumentEditing).toHaveBeenCalledWith(DOC_ID, false);
  });

  it('skips the save when the owning session changed (no cross-session leak)', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' })); // owns sess-A
    fireEvent.click(screen.getByTestId('blintz-fire-change'));
    mockState.canvasSessionId = 'sess-B'; // session switches before the flush
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
    expect(mockFileSave.save).not.toHaveBeenCalled();
  });

  it('shows a save-status label while file-backed', async () => {
    mockFileSave.status = 'saving';
    await renderEditor();
    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  it('surfaces a conflict banner and wires Reload / Overwrite', async () => {
    mockFileSave.status = 'conflict';
    mockFileSave.conflict = { currentHash: 'h2', currentContent: '# Disk\n' };
    mockFileSave.adoptDisk.mockReturnValue('# Disk\n');
    const onContentChange = await renderEditor();

    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(mockFileSave.adoptDisk).toHaveBeenCalled();
    expect(onContentChange).toHaveBeenCalledWith({ ...fileBacked, content: '# Disk\n' });

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(mockFileSave.overwrite).toHaveBeenCalled();
  });

  it('exits edit mode when the active canvas session changes', async () => {
    const onContentChange = vi.fn();
    const { rerender } = render(
      <CanvasMarkdownContent
        documentId={DOC_ID}
        content={fileBacked}
        onContentChange={onContentChange}
      />
    );
    await screen.findByTestId('blintz-canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    expect(screen.getByRole('button', { name: 'Finish editing' })).toBeInTheDocument();

    mockState.canvasSessionId = 'sess-B';
    rerender(
      <CanvasMarkdownContent
        documentId={DOC_ID}
        content={fileBacked}
        onContentChange={onContentChange}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit document' })).toBeInTheDocument()
    );
    expect(mockState.setDocumentEditing).toHaveBeenCalledWith(DOC_ID, false);
  });

  describe('with Docs', () => {
    it('passes no embeds and no save action while Docs is off', async () => {
      await renderEditor();
      expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-embeds', 'none');
      expect(screen.queryByTestId('save-web-page')).not.toBeInTheDocument();
    });

    it('passes the embeds to the editor, file-backed or not, while Docs is on', async () => {
      docs.embeds = { chart: {} };
      await renderEditor(generated);
      expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-embeds', 'chart');
    });

    it('offers Save as web page for a file-backed doc only, with what it shows', async () => {
      docs.embeds = { chart: {} };
      await renderEditor();
      expect(screen.getByTestId('save-web-page')).toHaveAttribute('data-source', 'doc.md');
      fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
      fireEvent.click(screen.getByTestId('blintz-fire-change'));
      // While editing, the saved page is the draft, not the last saved copy.
      expect(screen.getByTestId('save-web-page')).toHaveTextContent('edited body');
      cleanup();

      mockFileSave.canSave = false;
      await renderEditor(generated);
      expect(screen.queryByTestId('save-web-page')).not.toBeInTheDocument();
    });
  });
});
