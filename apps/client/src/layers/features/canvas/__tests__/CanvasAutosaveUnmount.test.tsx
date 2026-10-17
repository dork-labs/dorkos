/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

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
const readFileContent = vi.fn(async () => ({ content: disk, hash: 'initial', encoding: 'utf-8' }));
const writeFile = vi.fn(
  async (
    _cwd: string,
    _path: string,
    content: string,
    expected: { expectedContent?: string; expectedHash?: string }
  ) => {
    if (
      expected.expectedContent !== disk &&
      !(expected.expectedHash === 'first-ack' && disk === 'first')
    )
      throw new Error('Incorrect conditional base');
    disk = content;
    return { ok: true, hash: 'written', effect: 'changed' };
  }
);
const transport = { readFileContent, writeFile };
// Docs is off, its default: reading the experiment needs a server config
// these tests don't serve (see ./docs-off).
vi.mock('@/layers/features/docs', () => import('./docs-off'));
vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (state: typeof mockState) => unknown) => selector(mockState);
  useAppStore.getState = () => mockState;
  return { useAppStore, useResolvedTheme: () => 'light', useTransport: () => transport };
});
vi.mock('../ui/CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string) => void;
  }) => (
    <input
      aria-label="file draft"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <input
      aria-label="markdown draft"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('../model/use-doc-channel', () => ({
  useDocChannel: () => ({ fileSaveBinding: undefined }),
}));
import { CanvasFileContent } from '../ui/CanvasFileContent';
import { CanvasMarkdownContent } from '../ui/CanvasMarkdownContent';

afterEach(cleanup);
beforeEach(() => {
  disk = 'original';
  vi.clearAllMocks();
  mockState.canvasSessionId = 'session-a';
  mockState.openDocuments = [{ id: 'doc-1', editing: false }];
});

describe('real editor unmount autosave', () => {
  it('sends the latest file draft to the write transport when closed before debounce', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <CanvasFileContent documentId="doc-1" content={{ type: 'file', sourcePath: 'notes.txt' }} />
      </QueryClientProvider>
    );
    await screen.findByLabelText('file draft');
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    fireEvent.change(screen.getByLabelText('file draft'), { target: { value: 'earlier' } });
    fireEvent.change(screen.getByLabelText('file draft'), { target: { value: 'latest' } });
    expect(writeFile).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(disk).toBe('latest'));
    expect(writeFile).toHaveBeenCalledExactlyOnceWith('/work', 'notes.txt', 'latest', {
      expectedContent: 'original',
    });
    client.clear();
  });

  it('drains the latest queued file draft after the prior write acknowledges during unmount', async () => {
    let acknowledge!: () => void;
    writeFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = () => {
            disk = 'first';
            resolve({ ok: true, hash: 'first-ack', effect: 'changed' });
          };
        })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <CanvasFileContent documentId="doc-1" content={{ type: 'file', sourcePath: 'notes.txt' }} />
      </QueryClientProvider>
    );
    await screen.findByLabelText('file draft');
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
    fireEvent.change(screen.getByLabelText('file draft'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
    await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('file draft'), { target: { value: 'latest queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
    expect(writeFile).toHaveBeenCalledTimes(1);
    view.unmount();
    acknowledge();
    await waitFor(() => expect(disk).toBe('latest queued'));
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenLastCalledWith('/work', 'notes.txt', 'latest queued', {
      expectedHash: 'first-ack',
    });
    client.clear();
  });

  it('sends a buffered markdown draft to the write transport on same-session close', async () => {
    const view = render(
      <CanvasMarkdownContent
        documentId="doc-1"
        content={{ type: 'markdown', content: 'original', sourcePath: 'notes.md' }}
        onContentChange={vi.fn()}
      />
    );
    await screen.findByLabelText('markdown draft');
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.change(screen.getByLabelText('markdown draft'), {
      target: { value: 'latest markdown' },
    });
    expect(writeFile).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(disk).toBe('latest markdown'));
    expect(writeFile).toHaveBeenCalledExactlyOnceWith('/work', 'notes.md', 'latest markdown', {
      expectedContent: 'original',
    });
  });

  it('does not drain a markdown draft into another session', async () => {
    const view = render(
      <CanvasMarkdownContent
        documentId="doc-1"
        content={{ type: 'markdown', content: 'original', sourcePath: 'notes.md' }}
        onContentChange={vi.fn()}
      />
    );
    await screen.findByLabelText('markdown draft');
    fireEvent.click(screen.getByRole('button', { name: 'Edit document' }));
    fireEvent.change(screen.getByLabelText('markdown draft'), { target: { value: 'abandoned' } });
    mockState.canvasSessionId = 'session-b';
    view.unmount();
    await Promise.resolve();
    expect(writeFile).not.toHaveBeenCalled();
    expect(disk).toBe('original');
  });
});
