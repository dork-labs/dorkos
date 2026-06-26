/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mutable mock store — the component reads canvasSessionId/selectedCwd reactively
// (via selectors) and live (via getState() inside callbacks), and calls
// setCanvasEditing to flag edit mode.
const mockState = {
  canvasSessionId: 'sess-A' as string | null,
  selectedCwd: '/work' as string | null,
  setCanvasEditing: vi.fn(),
};

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  return { useAppStore };
});

// The save hook is unit-tested separately; here we control it so the component
// test stays focused on edit toggling, frontmatter handling, and conflict UI
// (and off the real crypto/transport).
const mockFileSave = {
  status: 'idle' as 'idle' | 'saving' | 'saved' | 'error' | 'conflict',
  conflict: null as { currentHash: string; currentContent: string } | null,
  canSave: true,
  save: vi.fn(),
  overwrite: vi.fn(),
  adoptDisk: vi.fn(),
};
vi.mock('../model/use-canvas-file-save', () => ({
  useCanvasFileSave: () => mockFileSave,
}));

// Mock the heavy Blintz wrapper: jsdom never loads the real editor. The stub
// surfaces `value`/`editable` and a button that fires `onChange`, standing in
// for a keystroke.
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
    mockState.canvasSessionId = 'sess-A';
    mockState.selectedCwd = '/work';
    mockFileSave.status = 'idle';
    mockFileSave.conflict = null;
    mockFileSave.canSave = true;
    mockFileSave.adoptDisk.mockReturnValue(undefined);
  });

  async function renderEditor(content: MarkdownContent = fileBacked, onContentChange = vi.fn()) {
    render(<CanvasMarkdownContent content={content} onContentChange={onContentChange} />);
    await screen.findByTestId('blintz-canvas');
    return onContentChange;
  }

  it('renders read-only and strips frontmatter from the displayed body', async () => {
    await renderEditor();
    const editor = screen.getByTestId('blintz-canvas');
    expect(editor).toHaveAttribute('data-editable', 'false');
    // The YAML frontmatter is not handed to the editor…
    expect(screen.getByTestId('blintz-value')).not.toHaveTextContent('title: T');
    // …only the body is.
    expect(screen.getByTestId('blintz-value')).toHaveTextContent('# Body');
    expect(screen.getByRole('button', { name: 'Edit document' })).toBeInTheDocument();
  });

  it('offers no edit control for generated (non-file-backed) content', async () => {
    mockFileSave.canSave = false;
    await renderEditor(generated);
    expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-editable', 'false');
    expect(screen.queryByRole('button', { name: 'Edit document' })).not.toBeInTheDocument();
  });

  it('enters edit mode: editable, seeds the body draft, flags canvasEditing', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    expect(screen.getByTestId('blintz-canvas')).toHaveAttribute('data-editable', 'true');
    expect(screen.getByTestId('blintz-value')).toHaveTextContent('# Body');
    expect(mockFileSave.save).not.toHaveBeenCalled();
    expect(mockState.setCanvasEditing).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Finish editing' })).toBeInTheDocument();
  });

  it('autosaves the rejoined document (frontmatter + edited body) to the file', async () => {
    const onContentChange = await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.click(screen.getByTestId('blintz-fire-change'));

    const expectedFull = `${FM}edited body`;
    await waitFor(() => expect(mockFileSave.save).toHaveBeenCalledWith(expectedFull), {
      timeout: 2000,
    });
    expect(onContentChange).toHaveBeenCalledWith({ ...fileBacked, content: expectedFull });
  });

  it('flushes the pending draft immediately when leaving edit mode', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.click(screen.getByTestId('blintz-fire-change'));
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
    expect(mockFileSave.save).toHaveBeenCalledWith(`${FM}edited body`);
    expect(mockState.setCanvasEditing).toHaveBeenCalledWith(false);
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
      <CanvasMarkdownContent content={fileBacked} onContentChange={onContentChange} />
    );
    await screen.findByTestId('blintz-canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    expect(screen.getByRole('button', { name: 'Finish editing' })).toBeInTheDocument();

    mockState.canvasSessionId = 'sess-B';
    rerender(<CanvasMarkdownContent content={fileBacked} onContentChange={onContentChange} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit document' })).toBeInTheDocument()
    );
    expect(mockState.setCanvasEditing).toHaveBeenCalledWith(false);
  });
});
