/**
 * @vitest-environment jsdom
 */
import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

// Store mock: the viewer reads selectedCwd + the theme and flags per-document
// edit mode via setDocumentEditing(id, editing).
const mockState = {
  selectedCwd: '/work' as string | null,
  setDocumentEditing: vi.fn(),
};
const readFileContent = vi.fn();

/** Document id passed to the viewer under test. */
const DOC_ID = 'doc-1';

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  return {
    useAppStore,
    useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
    useTransport: () => ({ readFileContent }),
  };
});

// The save hook is unit-tested separately; control it here to drive the
// edit→save→409 flow deterministically (and off the real crypto/transport).
const mockFileSave = {
  status: 'idle' as 'idle' | 'saving' | 'saved' | 'error' | 'conflict',
  conflict: null as { currentHash: string; currentContent: string } | null,
  canSave: true,
  save: vi.fn(),
  overwrite: vi.fn(),
  adoptDisk: vi.fn(),
  getConfirmedBase: vi.fn(),
};
vi.mock('../model/use-canvas-file-save', () => ({
  useCanvasFileSave: () => mockFileSave,
}));

// Count CodeMirror instantiations so a test can prove an autosave does NOT
// remount the editor (which would discard in-progress edit state).
let codeMirrorMountCount = 0;

// Stub the heavy CodeMirror wrapper: surface value/editable + a change button.
vi.mock('../ui/CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    value,
    editable,
    onChange,
  }: {
    value: string;
    editable: boolean;
    onChange?: (v: string) => void;
  }) => {
    // useEffect(mount) fires once per mount; a remount bumps the count.
    useEffect(() => {
      codeMirrorMountCount += 1;
    }, []);
    return (
      <div data-testid="codemirror" data-editable={String(editable)}>
        <span data-testid="cm-value">{value}</span>
        <button data-testid="cm-fire-change" onClick={() => onChange?.('edited body')}>
          change
        </button>
      </div>
    );
  },
}));

import { CanvasFileContent } from '../ui/CanvasFileContent';

function renderFile(sourcePath = 'src/index.ts') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CanvasFileContent documentId={DOC_ID} content={{ type: 'file', sourcePath }} />
    </QueryClientProvider>
  );
}

afterEach(cleanup);

describe('CanvasFileContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codeMirrorMountCount = 0;
    mockState.selectedCwd = '/work';
    mockFileSave.status = 'idle';
    mockFileSave.conflict = null;
    // Default: a save lands cleanly and the confirmed base advances to the draft.
    mockFileSave.save.mockResolvedValue('saved');
    mockFileSave.getConfirmedBase.mockReturnValue({ hash: 'h1', content: 'const x = 1;' });
    readFileContent.mockResolvedValue({ content: 'const x = 1;', hash: 'h1', encoding: 'utf-8' });
  });

  it('loads the file and renders read-only in CodeMirror', async () => {
    renderFile();
    await screen.findByTestId('codemirror');
    expect(readFileContent).toHaveBeenCalledWith('/work', 'src/index.ts');
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-editable', 'false');
    expect(screen.getByTestId('cm-value')).toHaveTextContent('const x = 1;');
    expect(screen.getByRole('button', { name: 'Edit file' })).toBeInTheDocument();
  });

  it('edit → change autosaves through the file-save flow and flags edit mode', async () => {
    renderFile();
    await screen.findByTestId('codemirror');

    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    expect(mockState.setDocumentEditing).toHaveBeenCalledWith(DOC_ID, true);
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-editable', 'true');

    fireEvent.click(screen.getByTestId('cm-fire-change'));
    await waitFor(() => expect(mockFileSave.save).toHaveBeenCalledWith('edited body'), {
      timeout: 2000,
    });
  });

  it('edit → change → checkmark shows the NEW content, not the pre-edit cache (DOR-232)', async () => {
    // The exact repro: leaving edit mode must render what was just written.
    mockFileSave.getConfirmedBase.mockReturnValue({ hash: 'h2', content: 'edited body' });
    renderFile();
    await screen.findByTestId('codemirror');

    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    fireEvent.click(screen.getByTestId('cm-fire-change'));
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));

    // Flush pending save must complete BEFORE the view settles on the new bytes.
    await waitFor(() => expect(screen.getByTestId('cm-value')).toHaveTextContent('edited body'));
    expect(mockFileSave.save).toHaveBeenLastCalledWith('edited body');
    // Back in read-only view.
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-editable', 'false');
    expect(screen.getByRole('button', { name: 'Edit file' })).toBeInTheDocument();
  });

  it('an autosave mid-edit does NOT remount the editor (draft survives)', async () => {
    renderFile();
    await screen.findByTestId('codemirror');
    expect(codeMirrorMountCount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    fireEvent.click(screen.getByTestId('cm-fire-change'));
    await waitFor(() => expect(mockFileSave.save).toHaveBeenCalledWith('edited body'));

    // The debounced save fired, but the read cache is left untouched until exit,
    // so the editor is never re-keyed: same instance, live draft, still editable.
    expect(codeMirrorMountCount).toBe(1);
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-editable', 'true');
    expect(screen.getByTestId('cm-value')).toHaveTextContent('edited body');
  });

  it('stays in edit mode when the flush conflicts (409 owns reconciliation)', async () => {
    mockFileSave.save.mockResolvedValue('conflict');
    renderFile();
    await screen.findByTestId('codemirror');

    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    fireEvent.click(screen.getByTestId('cm-fire-change'));
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));

    await waitFor(() => expect(mockFileSave.save).toHaveBeenLastCalledWith('edited body'));
    // A conflicting flush must not exit edit mode or clobber the draft.
    expect(screen.getByTestId('codemirror')).toHaveAttribute('data-editable', 'true');
    expect(screen.getByTestId('cm-value')).toHaveTextContent('edited body');
  });

  it('refresh button refetches from disk and renders the updated content', async () => {
    renderFile();
    await screen.findByTestId('codemirror');
    expect(screen.getByTestId('cm-value')).toHaveTextContent('const x = 1;');

    // An agent rewrote the file on disk while we viewed it.
    readFileContent.mockResolvedValue({ content: 'const x = 2;', hash: 'h9', encoding: 'utf-8' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh from disk' }));

    await waitFor(() => expect(screen.getByTestId('cm-value')).toHaveTextContent('const x = 2;'));
  });

  it('hides the refresh button while editing (the 409 flow owns mid-edit changes)', async () => {
    renderFile();
    await screen.findByTestId('codemirror');
    expect(screen.getByRole('button', { name: 'Refresh from disk' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    expect(screen.queryByRole('button', { name: 'Refresh from disk' })).not.toBeInTheDocument();
  });

  it('releases this document edit-protection on unmount (tab switch / close mid-edit)', async () => {
    // Regression: an editor unmounting mid-edit (its tab deactivated, or the
    // canvas closed) must clear ITS OWN document's editing flag by id, so the
    // agent-write contract to that document is never permanently locked.
    const { unmount } = renderFile();
    await screen.findByTestId('codemirror');

    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    expect(mockState.setDocumentEditing).toHaveBeenLastCalledWith(DOC_ID, true);

    unmount();
    expect(mockState.setDocumentEditing).toHaveBeenLastCalledWith(DOC_ID, false);
  });

  it('surfaces a 409 conflict banner and wires Reload / Overwrite', async () => {
    mockFileSave.status = 'conflict';
    mockFileSave.conflict = { currentHash: 'h2', currentContent: 'const y = 2;' };
    mockFileSave.adoptDisk.mockReturnValue('const y = 2;');
    renderFile();
    await screen.findByTestId('codemirror');

    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(mockFileSave.adoptDisk).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(mockFileSave.overwrite).toHaveBeenCalled();
  });

  it('shows a friendly message for a binary file', async () => {
    readFileContent.mockRejectedValue(Object.assign(new Error('binary'), { code: 'BINARY_FILE' }));
    renderFile('assets/blob.bin');
    await waitFor(() =>
      expect(screen.getByText(/isn.t text and can.t be shown/i)).toBeInTheDocument()
    );
  });
});
