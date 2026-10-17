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

/**
 * The per-document edit flag the editor writes with `setDocumentEditing` — and,
 * since notify-and-reconcile, READS back: "Reload" on the held-update banner
 * ends the edit from outside, and the editor follows the store out of edit mode.
 * A mock that swallowed the write would leave the editor stuck in edit mode
 * against a store that says otherwise, which is the state the effect exists to
 * resolve.
 */
const mockState = {
  selectedCwd: '/work' as string | null,
  openDocuments: [{ id: 'doc-md', editing: false }],
  setDocumentEditing: vi.fn((id: string, editing: boolean) => {
    mockState.openDocuments = mockState.openDocuments.map((d) =>
      d.id === id ? { ...d, editing } : d
    );
  }),
};
const readFileContent = vi.fn();

const DOC_ID = 'doc-md';

// The Docs feature, off unless a test turns it on. When on, it hands the real
// editor one stand-in embed, so a test can see the registry arrive end to end.
const docs = vi.hoisted(() => ({ on: false }));
vi.mock('@/layers/features/docs', () => {
  const embeds = {
    note: {
      component: ({ attributes }: { attributes: Record<string, string> }) => (
        <p data-testid="note-embed">{attributes.text}</p>
      ),
    },
  };
  return {
    // Wiki links are tested in features/docs; here they stay off.
    useDocWikiLinks: () => undefined,
    useDocEmbeds: () => (docs.on ? embeds : undefined),
    SaveAsWebPageButton: ({ sourcePath }: { sourcePath: string }) =>
      docs.on ? <button type="button" aria-label={`Save ${sourcePath} as web page`} /> : null,
  };
});
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
  recovery: {
    identity: {},
    supported: false,
    current: () => false,
    discover: async () => ({ status: 'idle' }),
    recover: async () => ({ status: 'idle' }),
    inspectCurrent: async () => ({ status: 'idle' }),
  },
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
  docs.on = false;
  mockState.openDocuments = [{ id: 'doc-md', editing: false }];
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

  it('draws embeds through the real editor and offers Save as web page only with Docs on', async () => {
    readFileContent.mockResolvedValue({
      content: '# Notes\n\n::note{text="Drawn by the host"}\n',
      hash: 'h1',
      encoding: 'utf-8',
    });
    renderMarkdownFile();
    await waitFor(() => expect(editableSurface()).not.toBeNull(), { timeout: 4000 });
    // Off: Blintz still reads the directive (its grammar is always on) but has
    // no component for it, so it keeps its own placeholder; no save action.
    expect(screen.queryByTestId('note-embed')).not.toBeInTheDocument();
    expect(document.querySelector('[data-embed-name="note"]')).toHaveAttribute(
      'data-embed-state',
      'unknown'
    );
    expect(screen.queryByRole('button', { name: /as web page/ })).not.toBeInTheDocument();
    cleanup();

    docs.on = true;
    renderMarkdownFile();
    expect(await screen.findByTestId('note-embed', {}, { timeout: 4000 })).toHaveTextContent(
      'Drawn by the host'
    );
    expect(screen.getByRole('button', { name: 'Save notes.md as web page' })).toBeInTheDocument();
  });
});
