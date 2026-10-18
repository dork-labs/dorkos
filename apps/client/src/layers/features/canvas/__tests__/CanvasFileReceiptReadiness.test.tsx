/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { WriteFileResult } from '@dorkos/shared/transport';
const transport = createMockTransport();
const birth = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
const replay = {
  incarnation: birth,
  routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'No routes' },
  events: [],
  state: {},
  stateRev: 0,
  highWatermark: 0,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  health: { status: 'ready' as const, reasons: [] },
  receipts: [],
};
const state = {
  selectedCwd: '/work',
  canvasSessionId: 'session-a',
  roomCanvasLiveRoomId: null as string | null,
  openDocuments: [{ id: 'doc-1', editing: false }],
  setDocumentEditing: (id: string, editing: boolean) => {
    state.openDocuments = state.openDocuments.map((doc) =>
      doc.id === id ? { ...doc, editing } : doc
    );
  },
};
// Wiki links belong to the Docs feature and are tested there (`features/docs`).
vi.mock('@/layers/features/docs', () => ({ useDocWikiLinks: () => undefined }));
vi.mock('@/layers/shared/model', () => {
  const useAppStore = (select: (value: typeof state) => unknown) => select(state);
  useAppStore.getState = () => state;
  return { useAppStore, useTransport: () => transport, useResolvedTheme: () => 'light' };
});
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
// Both useDocChannel/recovery and useCanvasFileSave remain real.
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
beforeEach(() => {
  state.roomCanvasLiveRoomId = null;
  state.openDocuments = [{ id: 'doc-1', editing: false }];
  vi.mocked(transport.getCanvasChannel).mockReset();
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'base',
    hash: 'a'.repeat(64),
    encoding: 'utf-8',
  });
  vi.mocked(transport.writeFile).mockReset();
  vi.mocked(transport.writeFile).mockImplementation(
    async (_cwd, _path, _content, options): Promise<WriteFileResult> => ({
      ok: true,
      hash: 'b'.repeat(64),
      effect: 'changed',
      ...(options?.documentSave
        ? {
            documentReceipt: {
              ...options.documentSave,
              fileHash: 'b'.repeat(64),
              docSeq: 1,
              status: 'accepted' as const,
            },
          }
        : {}),
    })
  );
});
afterEach(() => {
  cleanup();
  query.clear();
});

it('blocks an early edit attempt until the actual async observation commits, then sends the full birth', async () => {
  let release!: (value: typeof replay) => void;
  const held = new Promise<typeof replay>((done) => {
    release = done;
  });
  vi.mocked(transport.getCanvasChannel).mockImplementation(() => held);
  view();
  await screen.findByLabelText('draft');
  const edit = screen.getByRole('button', { name: 'Edit file' });
  expect(edit).toBeDisabled();
  expect(edit).toHaveAttribute('data-document-save-observation', 'pending');
  expect(screen.getByText('Checking document…')).toBeInTheDocument();
  fireEvent.click(edit);
  expect(state.openDocuments[0]?.editing).toBe(false);
  expect(screen.queryByRole('button', { name: 'Finish editing' })).not.toBeInTheDocument();
  expect(transport.writeFile).not.toHaveBeenCalled();
  await act(async () => {
    release(replay);
  });
  await waitFor(() => expect(edit).toHaveAttribute('data-document-save-observation', 'ready'));
  expect(edit).toBeEnabled();
  expect(screen.queryByText('Checking document…')).not.toBeInTheDocument();
  fireEvent.click(edit);
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'receipt draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(transport.writeFile).toHaveBeenCalledTimes(1));
  expect(transport.writeFile).toHaveBeenCalledWith('/work', 'notes.txt', 'receipt draft', {
    expectedContent: 'base',
    documentSave: { documentId: 'doc-1', incarnation: birth, eventId: expect.any(String) },
  });
});

it.each(['legacy', 'error'] as const)(
  'preserves honest plain-save fallback after the actual %s observation settles',
  async (mode) => {
    if (mode === 'error')
      vi.mocked(transport.getCanvasChannel).mockRejectedValue(
        new Error('Unsupported document channel')
      );
    else {
      const { incarnation: _incarnation, ...legacy } = replay;
      vi.mocked(transport.getCanvasChannel).mockResolvedValue(legacy);
    }
    view();
    await screen.findByLabelText('draft');
    const edit = screen.getByRole('button', { name: 'Edit file' });
    await waitFor(() =>
      expect(edit).toHaveAttribute('data-document-save-observation', 'unavailable')
    );
    expect(edit).toBeEnabled();
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'plain draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
    await waitFor(() => expect(transport.writeFile).toHaveBeenCalledTimes(1));
    expect(transport.writeFile).toHaveBeenCalledWith('/work', 'notes.txt', 'plain draft', {
      expectedContent: 'base',
    });
  }
);

it('does not put the Room/plain editor behind the session observation guard', async () => {
  state.roomCanvasLiveRoomId = 'room-1';
  view();
  await screen.findByLabelText('draft');
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled();
  expect(screen.queryByText('Checking document…')).not.toBeInTheDocument();
  expect(transport.getCanvasChannel).not.toHaveBeenCalled();
});
