/** @vitest-environment jsdom */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { WriteFileOptions } from '@dorkos/shared/transport';
const birth = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
let available = true;
const binding = { incarnation: birth, current: () => available };
const state = {
  selectedCwd: '/work',
  canvasSessionId: 'session-a',
  roomCanvasLiveRoomId: null,
  openDocuments: [{ id: 'doc-1', editing: false }],
  setDocumentEditing: (id: string, editing: boolean) => {
    state.openDocuments = state.openDocuments.map((doc) =>
      doc.id === id ? { ...doc, editing } : doc
    );
  },
};
const readFileContent = vi.fn(async () => ({
  content: 'base',
  hash: 'a'.repeat(64),
  encoding: 'utf-8',
}));
const writeFile = vi.fn();
const transport = { readFileContent, writeFile };
vi.mock('@/layers/shared/model', () => {
  const useAppStore = (select: (value: typeof state) => unknown) => select(state);
  useAppStore.getState = () => state;
  return { useAppStore, useTransport: () => transport, useResolvedTheme: () => 'light' };
});
// Replay ownership is separately tested; keep the actual save hook and editor wiring real here.
vi.mock('../model/use-doc-channel', () => ({
  useDocChannel: () => ({ fileSaveBinding: available ? binding : undefined }),
}));
vi.mock('../ui/CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string) => void;
  }) => (
    <input aria-label="draft" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));
import { CanvasFileContent } from '../ui/CanvasFileContent';
let query: QueryClient;
function view() {
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <CanvasFileContent documentId="doc-1" content={{ type: 'file', sourcePath: 'notes.txt' }} />
    </QueryClientProvider>
  );
}
function response(options?: WriteFileOptions) {
  return {
    ok: true,
    hash: 'b'.repeat(64),
    effect: 'changed',
    ...(options?.documentSave
      ? {
          documentReceipt: {
            ...options.documentSave,
            fileHash: 'b'.repeat(64),
            docSeq: 1,
            status: 'accepted',
          },
        }
      : {}),
  };
}
beforeEach(() => {
  available = true;
  state.openDocuments = [{ id: 'doc-1', editing: false }];
  writeFile.mockReset();
  writeFile.mockImplementation(async (_cwd, _path, _content, options) => response(options));
});
afterEach(() => {
  cleanup();
  query.clear();
});

it('the reachable session editor sends the observed full birth and shows only the server receipt as recorded', async () => {
  view();
  await screen.findByLabelText('draft');
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'receipt draft' } });
  await screen.findByText('Save recorded');
  expect(writeFile).toHaveBeenCalledExactlyOnceWith('/work', 'notes.txt', 'receipt draft', {
    expectedContent: 'base',
    documentSave: { documentId: 'doc-1', incarnation: birth, eventId: expect.any(String) },
  });
});

it('keeps the original identity through user retry and does not label a newer unsent draft as recorded', async () => {
  writeFile.mockRejectedValueOnce(new TypeError('response lost'));
  view();
  await screen.findByLabelText('draft');
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await screen.findByRole('button', { name: 'Retry original save' });
  const original = writeFile.mock.calls[0];
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'newer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Retry original save' }));
  await screen.findByText('Unsaved changes');
  expect(writeFile.mock.calls[1]).toEqual(original);
  expect(screen.getByLabelText('draft')).toHaveValue('newer');
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await screen.findByRole('button', { name: 'Edit file' });
  expect(writeFile).toHaveBeenCalledTimes(3);
  expect(writeFile.mock.calls[2]![2]).toBe('newer');
  expect(writeFile.mock.calls[2]![3].expectedHash).toBe('b'.repeat(64));
  expect(writeFile.mock.calls[2]![3].documentSave.eventId).not.toBe(
    original![3].documentSave.eventId
  );
});

it('metadata arriving after edit starts does not retire the draft or upgrade a plain save to a receipt', async () => {
  available = false;
  const rendered = view();
  await screen.findByLabelText('draft');
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'plain draft' } });
  available = true;
  rendered.rerender(
    <QueryClientProvider client={query}>
      <CanvasFileContent documentId="doc-1" content={{ type: 'file', sourcePath: 'notes.txt' }} />
    </QueryClientProvider>
  );
  await screen.findByText('Saved to file');
  expect(writeFile).toHaveBeenCalledExactlyOnceWith('/work', 'notes.txt', 'plain draft', {
    expectedContent: 'base',
  });
  expect(screen.queryByText('Save recorded')).not.toBeInTheDocument();
});
