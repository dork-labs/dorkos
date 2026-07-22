/**
 * @vitest-environment jsdom
 *
 * Integration coverage for CanvasFileContent's MARKDOWN branch against the REAL
 * Blintz editor (unmocked). This branch shipped a regression — the pencil toggled
 * `editable` but Blintz captured it at construction, so `contenteditable` never
 * flipped — because it was never render-tested end to end. Blintz 0.4.0 makes
 * `editable` reactive; this proves the toggle live through the real editor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

const mockState = {
  selectedCwd: '/work' as string | null,
  setDocumentEditing: vi.fn(),
};
const readFileContent = vi.fn();

const DOC_ID = 'doc-md';

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  return {
    useAppStore,
    // The real BlintzCanvas (unmocked here) resolves its theme via this hook.
    useResolvedTheme: () => 'light' as const,
    useTransport: () => ({ readFileContent }),
  };
});

// The save hook is unit-tested separately; control it so the edit→save path is
// deterministic and off the real transport. `save` records what the autosave
// debounce flushes.
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

import { CanvasFileContent } from '../ui/CanvasFileContent';

function renderMarkdownFile(sourcePath = 'notes.md') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CanvasFileContent documentId={DOC_ID} content={{ type: 'file', sourcePath }} />
    </QueryClientProvider>
  );
}

/** The ProseMirror editable surface Blintz mounts (query by the contenteditable attr). */
function editableSurface(): HTMLElement | null {
  return document.querySelector('[contenteditable]');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.selectedCwd = '/work';
  mockFileSave.status = 'idle';
  mockFileSave.conflict = null;
  mockFileSave.save.mockResolvedValue('saved');
  mockFileSave.getConfirmedBase.mockReturnValue({ hash: 'h1', content: '# Notes\n' });
  readFileContent.mockResolvedValue({
    content: '# Notes\n\nbody\n',
    hash: 'h1',
    encoding: 'utf-8',
  });
});
afterEach(cleanup);

describe('CanvasFileContent markdown branch (real Blintz)', () => {
  it('mounts the real editor read-only and flips contenteditable on the pencil (no remount)', async () => {
    renderMarkdownFile();

    // Real Blintz mounts its ProseMirror surface asynchronously; wait for it.
    await waitFor(() => expect(editableSurface()).not.toBeNull(), { timeout: 4000 });

    // View mode: the surface is not editable.
    expect(editableSurface()).toHaveAttribute('contenteditable', 'false');
    const beforeSurface = editableSurface();

    // Click the pencil → the SAME editor instance turns editable (0.4.0 reactive
    // prop, no remount). The regression was contenteditable staying false here.
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));

    await waitFor(() => expect(editableSurface()).toHaveAttribute('contenteditable', 'true'), {
      timeout: 4000,
    });
    expect(mockState.setDocumentEditing).toHaveBeenCalledWith(DOC_ID, true);
    // Same DOM node — the editor was not torn down and rebuilt.
    expect(editableSurface()).toBe(beforeSurface);

    // The host autosave wiring (Blintz onChange → debounced save) is covered by
    // the mocked-onChange tests in CanvasFileContent.test.tsx and
    // CanvasMarkdownContent.test.tsx. Driving a real ProseMirror keystroke here
    // is intentionally avoided: jsdom lacks the coordinate APIs (elementFromPoint /
    // posAtCoords) ProseMirror calls, so a real keystroke floods uncaught async
    // errors. This test's job is to prove the reactive `editable` flip end to end.
  });
});
