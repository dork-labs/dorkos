/**
 * @vitest-environment jsdom
 *
 * The canvas with the Docs experiment on and the real comments frame
 * (DOR-2983): a file-backed markdown doc hands the editor the comment plugin
 * and shows the panel, autosave and the unmount flush still write the latest
 * draft, an anchor moved in a draft is saved only once that draft is on disk,
 * and the file viewer names its doc to the frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UseBlintzCommentsOptions } from '@blintz/comments';

const mockState = {
  selectedCwd: '/work',
  canvasSessionId: 'session-a',
  openDocuments: [{ id: 'doc-1', editing: false }],
  setDocumentEditing: (id: string, editing: boolean) => {
    mockState.openDocuments = mockState.openDocuments.map((doc) =>
      doc.id === id ? { ...doc, editing } : doc
    );
  },
};
let disk = 'original';
const transport = {
  readFileContent: vi.fn(async () => ({ content: disk, hash: 'initial', encoding: 'utf-8' })),
  writeFile: vi.fn(async (_cwd: string, _path: string, content: string) => {
    disk = content;
    return { ok: true, hash: `h-${content}`, effect: 'changed' };
  }),
  // Wiki links read the space's docs; none here.
  getDocIndex: vi.fn(async () => ({ root: '/work', docs: [], truncated: false })),
  resolveDocLink: vi.fn(async () => ({ doc: null, complete: true })),
  listDocCommentThreads: vi.fn(async () => ({ threads: [] })),
  listDocCommentMentionable: vi.fn(async () => ({ people: [] })),
  updateDocCommentAnchors: vi.fn(async (body: { updates: unknown[] }) => ({
    updated: body.updates.length,
  })),
};
const editor = vi.hoisted(() => ({ plugins: [] as Array<unknown[] | undefined> }));
const comments = vi.hoisted(() => ({ options: undefined as UseBlintzCommentsOptions | undefined }));

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (state: typeof mockState) => unknown) => selector(mockState);
  useAppStore.getState = () => mockState;
  return {
    useAppStore,
    useResolvedTheme: () => 'light',
    useTheme: () => ({ theme: 'light', setTheme: () => undefined }),
    useTransport: () => transport,
    DOCS_EXPERIMENT: 'docs.enabled',
  };
});
vi.mock('@/layers/entities/config', () => ({
  useExperimentEnabledState: () => ({ enabled: true, isLoading: false }),
}));
vi.mock('@blintz/comments', () => ({
  useBlintzComments: (options: UseBlintzCommentsOptions) => {
    comments.options = options;
    return {
      plugin: () => undefined,
      anchorSelection: () => null,
      rangeOf: () => null,
      threadsAtSelection: () => [],
      reveal: () => false,
    };
  },
}));
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({
    value,
    onChange,
    plugins,
  }: {
    value: string;
    onChange?: (value: string) => void;
    plugins?: unknown[];
  }) => {
    editor.plugins.push(plugins);
    return (
      <input
        aria-label="markdown draft"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  },
}));
vi.mock('../model/use-doc-channel', () => ({
  useDocChannel: () => ({ fileSaveBinding: undefined }),
}));

import { CanvasFileContent } from '../ui/CanvasFileContent';
import { CanvasMarkdownContent } from '../ui/CanvasMarkdownContent';

const MOVED = { v: 1, quote: 'x', prefix: '', suffix: '', start: 1, end: 2 };

afterEach(cleanup);
beforeEach(() => {
  disk = 'original';
  vi.clearAllMocks();
  editor.plugins = [];
  comments.options = undefined;
  mockState.canvasSessionId = 'session-a';
  mockState.openDocuments = [{ id: 'doc-1', editing: false }];
});

function renderMarkdown() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onContentChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <CanvasMarkdownContent
        documentId="doc-1"
        content={{ type: 'markdown', content: 'original', sourcePath: 'plan.md' }}
        onContentChange={onContentChange}
      />
    </QueryClientProvider>
  );
  return { view, client };
}

describe('the canvas with Docs on', () => {
  it('hands a file-backed doc the comment plugin, and autosaves as before', async () => {
    const { client } = renderMarkdown();
    await screen.findByLabelText('markdown draft', {}, { timeout: 10_000 });
    expect(editor.plugins.at(-1)).toHaveLength(1);
    expect(await screen.findByRole('complementary', { name: 'Comments' })).toBeInTheDocument();
    expect(transport.listDocCommentThreads).toHaveBeenCalledWith({ cwd: '/work', path: 'plan.md' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.change(screen.getByLabelText('markdown draft'), { target: { value: 'edited' } });
    // The editor moves an anchor while the draft is not on disk yet: held.
    act(() => comments.options?.onAnchorsChange?.([{ id: 't1', anchor: MOVED as never }]));
    expect(transport.updateDocCommentAnchors).not.toHaveBeenCalled();

    await waitFor(() => expect(disk).toBe('edited'));
    await waitFor(() =>
      expect(transport.updateDocCommentAnchors).toHaveBeenCalledWith({
        cwd: '/work',
        path: 'plan.md',
        updates: [{ id: 't1', anchor: MOVED }],
      })
    );
    client.clear();
  });

  it('still writes the latest draft when the doc closes before the autosave', async () => {
    const { view, client } = renderMarkdown();
    await screen.findByLabelText('markdown draft', {}, { timeout: 10_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.change(screen.getByLabelText('markdown draft'), { target: { value: 'latest' } });
    view.unmount();
    await waitFor(() => expect(disk).toBe('latest'));
    client.clear();
  });

  it('names the file viewer’s markdown doc to the comments frame', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CanvasFileContent
          documentId="doc-1"
          content={{ type: 'file', sourcePath: 'notes/plan.md' }}
        />
      </QueryClientProvider>
    );
    await screen.findByLabelText('markdown draft', {}, { timeout: 10_000 });
    await waitFor(() =>
      expect(transport.listDocCommentThreads).toHaveBeenCalledWith({
        cwd: '/work',
        path: 'notes/plan.md',
      })
    );
    expect(editor.plugins.at(-1)).toHaveLength(1);
    client.clear();
  });
});
