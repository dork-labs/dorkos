/** @vitest-environment jsdom */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { WriteFileOptions } from '@dorkos/shared/transport';
import { useAppStore } from '@/layers/shared/model/app-store';
import { setSessionCanvasTransport } from '@/layers/shared/model/app-store/app-store-canvas';
const mocks = vi.hoisted(() => ({ writeFile: vi.fn(), readFileContent: vi.fn() }));
let id = '',
  disk = 'base',
  live = true,
  sequence = 0,
  generation = 'a';
let lastClose: void | Promise<void>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const birth = () => ({
  v: 1 as const,
  documentId: id,
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: generation.repeat(64),
});
let observedBinding: { incarnation: ReturnType<typeof birth>; current(): boolean };
const close = vi.fn(async () => {
  live = false;
});
const transport = {
  ...mocks,
  listSessionCanvas: vi.fn(async () => []),
  getSessionCanvasDocument: vi.fn(async () => null),
  openSessionCanvasDocument: vi.fn(),
  updateSessionCanvasDocument: vi.fn(),
  closeSessionCanvasDocument: close,
  setSessionCanvasEditing: vi.fn(async () => ({ editingBy: null, expiresAt: null })),
};
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
  useResolvedTheme: () => 'light',
}));
vi.mock('../model/use-doc-channel', () => ({
  useDocChannel: () => ({
    fileSaveBinding: observedBinding,
    fileSaveObservation: 'ready',
  }),
}));
vi.mock('../ui/CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string) => void;
  }) => (
    <input
      aria-label="receipt close draft"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { CanvasFileContent } from '../ui/CanvasFileContent';
let query: QueryClient;
function ack(content: string, options: WriteFileOptions, duplicate = false) {
  return {
    ok: true,
    hash: hash(content),
    effect: duplicate ? 'no_op' : 'changed',
    documentReceipt: {
      ...options.documentSave!,
      fileHash: hash(content),
      docSeq: 1,
      status: duplicate ? 'duplicate' : 'accepted',
    },
  };
}
function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
function hold() {
  const held = gate();
  mocks.writeFile.mockImplementationOnce(
    async (_cwd: string, _path: string, content: string, options: WriteFileOptions) => {
      await held.promise;
      if (!live)
        throw Object.assign(new Error('Original document already closed'), { status: 404 });
      disk = content;
      return ack(content, options);
    }
  );
  return held;
}
function Host() {
  const row = useAppStore((state) => state.openDocuments.find((item) => item.id === id));
  const active = useAppStore((state) => state.activeCanvasDocumentId === id);
  return (
    <>
      <button
        onClick={() => {
          lastClose = useAppStore.getState().closeCanvasDocument(id);
        }}
      >
        Close fixture
      </button>
      <button onClick={() => useAppStore.setState({ activeCanvasDocumentId: null })}>
        Hide fixture
      </button>
      <button onClick={() => useAppStore.setState({ activeCanvasDocumentId: id })}>
        Show fixture
      </button>
      {row && active ? (
        <CanvasFileContent documentId={id} content={{ type: 'file', sourcePath: 'notes.txt' }} />
      ) : (
        <p>Editor not mounted</p>
      )}
    </>
  );
}
async function edit(text: string) {
  await screen.findByLabelText('receipt close draft');
  fireEvent.click(screen.getByRole('button', { name: /^Edit file$/ }));
  fireEvent.change(screen.getByLabelText('receipt close draft'), { target: { value: text } });
}
beforeEach(() => {
  id = `receipt-close-${++sequence}`;
  disk = 'base';
  live = true;
  lastClose = undefined;
  generation = 'a';
  observedBinding = { incarnation: birth(), current: () => live };
  close.mockReset();
  close.mockImplementation(async () => {
    live = false;
  });
  vi.clearAllMocks();
  mocks.writeFile.mockReset();
  mocks.readFileContent.mockReset();
  mocks.readFileContent.mockImplementation(async () => ({
    content: disk,
    hash: hash(disk),
    encoding: 'utf-8',
  }));
  mocks.writeFile.mockImplementation(async (_cwd, _path, content, options) => {
    if (!live) throw Object.assign(new Error('Original document already closed'), { status: 404 });
    if (content === disk) return { ok: true, hash: hash(disk), effect: 'no_op' };
    disk = content;
    return ack(content, options);
  });
  useAppStore.getState().loadCanvasForSession(`reset-${id}`);
  useAppStore.getState().loadCanvasForSession('session-close');
  useAppStore.setState({ selectedCwd: '/work', roomCanvasLiveRoomId: null });
  useAppStore.getState().hydrateCanvasFromSnapshot('session-close', [
    {
      id,
      scope: 'session:session-close',
      roomId: null,
      content: { type: 'file', sourcePath: 'notes.txt' },
      title: 'Close fixture',
      contentType: 'file',
      authorId: 'owner',
      pinned: false,
      rev: 1,
      lastTouchedBy: 'owner',
      lastTouchedAt: '2026-10-15T00:00:00.000Z',
      openedAt: '2026-10-15T00:00:00.000Z',
      lastActiveAt: '2026-10-15T00:00:00.000Z',
    },
  ]);
  useAppStore.setState({ activeCanvasDocumentId: id });
  setSessionCanvasTransport(transport);
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <Host />
    </QueryClientProvider>
  );
});
afterEach(() => {
  cleanup();
  setSessionCanvasTransport(null);
  query.clear();
  vi.restoreAllMocks();
});

it('keeps the real receipt editor mounted and sends no DELETE until its before-debounce draft is acknowledged', async () => {
  const held = hold();
  await edit('latest buffered bytes');
  expect(mocks.writeFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('receipt close draft')).toHaveValue('latest buffered bytes');
  expect(useAppStore.getState().openDocuments.some((row) => row.id === id)).toBe(true);
  held.release();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(disk).toBe('latest buffered bytes');
  expect(mocks.writeFile.mock.calls[0]![3].documentSave).toMatchObject({
    documentId: id,
    incarnation: birth(),
  });
});
it('joins older A then saves latest B with A hash before closing', async () => {
  const a = hold(),
    b = hold();
  await edit('A');
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('receipt close draft'), { target: { value: 'B' } });
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  expect(close).not.toHaveBeenCalled();
  a.release();
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(2));
  expect(mocks.writeFile.mock.calls[1]![2]).toBe('B');
  expect(mocks.writeFile.mock.calls[1]![3].expectedHash).toBe(hash('A'));
  expect(close).not.toHaveBeenCalled();
  b.release();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(disk).toBe('B');
});
it('keeps uncertainty and original UUID mounted until explicit retry, with no DELETE', async () => {
  mocks.writeFile.mockImplementationOnce(async (_cwd, _path, content) => {
    disk = content;
    throw new TypeError('Committed response lost');
  });
  await edit('original uncertain bytes');
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await screen.findByRole('button', { name: 'Retry original save' });
  await act(async () => {
    await lastClose;
  });
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('receipt close draft')).toHaveValue('original uncertain bytes');
  const original = mocks.writeFile.mock.calls[0]!;
  mocks.writeFile.mockImplementationOnce(async (_cwd, _path, content, options) =>
    ack(content, options, true)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry original save' }));
  await screen.findByText('Save recorded');
  expect(mocks.writeFile.mock.calls[1]).toEqual(original);
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});
it('refuses an old close ACK after a newer draft arrives', async () => {
  const held = hold();
  await edit('A');
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('receipt close draft'), { target: { value: 'newer B' } });
  held.release();
  await screen.findByText('Unsaved changes');
  await act(async () => {
    await lastClose;
  });
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('receipt close draft')).toHaveValue('newer B');
});
it('deduplicates concurrent close clicks through one owner preparation', async () => {
  const held = hold();
  await edit('one save');
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  expect(close).not.toHaveBeenCalled();
  held.release();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(mocks.writeFile).toHaveBeenCalledTimes(1);
});
it('retains an inactive owner barrier until its already-authorized passive drain settles', async () => {
  const held = hold();
  await edit('inactive buffered bytes');
  fireEvent.click(screen.getByText('Hide fixture', { exact: true }));
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  expect(close).not.toHaveBeenCalled();
  held.release();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(disk).toBe('inactive buffered bytes');
});
it('does not retarget a held close into a changed cwd', async () => {
  const held = hold();
  await edit('old source bytes');
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  act(() => useAppStore.setState({ selectedCwd: '/other' }));
  held.release();
  await waitFor(() => expect(disk).toBe('old source bytes'));
  await act(async () => {
    await lastClose;
  });
  expect(close).not.toHaveBeenCalled();
  expect(useAppStore.getState().openDocuments.some((row) => row.id === id)).toBe(true);
});
it('refuses a held close if the current document revision changes before its save ACK', async () => {
  const held = hold();
  await edit('captured revision bytes');
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  act(() =>
    useAppStore.setState((state) => ({
      openDocuments: state.openDocuments.map((row) =>
        row.id === id ? { ...row, rev: row.rev + 1 } : row
      ),
    }))
  );
  held.release();
  await act(async () => {
    await lastClose;
  });
  expect(disk).toBe('captured revision bytes');
  expect(close).not.toHaveBeenCalled();
  expect(useAppStore.getState().openDocuments.find((row) => row.id === id)?.rev).toBe(2);
  expect(screen.getByLabelText('receipt close draft')).toHaveValue('captured revision bytes');
});
it('does not forget an unknown retired operation merely because its same document remounts', async () => {
  mocks.writeFile.mockRejectedValueOnce(new TypeError('Unknown retired outcome'));
  await edit('retired original');
  fireEvent.click(screen.getByText('Hide fixture', { exact: true }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Show fixture', { exact: true }));
  await screen.findByRole('button', { name: 'Edit file' });
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await act(async () => {
    await lastClose;
  });
  expect(useAppStore.getState().openDocuments.some((row) => row.id === id)).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(mocks.writeFile).toHaveBeenCalledTimes(1);
});

it('retains latest confirmed bytes if a mounted close DELETE fails and the real store restores its row', async () => {
  close.mockRejectedValueOnce(new TypeError('DELETE response lost'));
  await edit('confirmed before failed close');
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  await act(async () => {
    await lastClose;
  });
  await waitFor(() =>
    expect(useAppStore.getState().openDocuments.some((row) => row.id === id)).toBe(true)
  );
  await waitFor(() =>
    expect(screen.getByLabelText('receipt close draft')).toHaveValue(
      'confirmed before failed close'
    )
  );
  expect(disk).toBe('confirmed before failed close');
});
it('invalidates only the owned confirmed retired file so inactive close rollback refetches current bytes', async () => {
  close.mockRejectedValueOnce(new TypeError('Inactive DELETE response lost'));
  await edit('confirmed inactive bytes');
  fireEvent.click(screen.getByText('Hide fixture', { exact: true }));
  await waitFor(() => expect(disk).toBe('confirmed inactive bytes'));
  fireEvent.click(screen.getByText('Close fixture', { exact: true }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  await act(async () => {
    await lastClose;
  });
  await waitFor(() =>
    expect(useAppStore.getState().openDocuments.some((row) => row.id === id)).toBe(true)
  );
  fireEvent.click(screen.getByText('Show fixture', { exact: true }));
  await waitFor(() =>
    expect(screen.getByLabelText('receipt close draft')).toHaveValue('confirmed inactive bytes')
  );
});

it('a late retired A ACK never installs A bytes over a newer owner B cache/read', async () => {
  const held = gate();
  mocks.writeFile.mockImplementationOnce(async (_cwd, _path, content, options) => {
    disk = content; // The original server effect is committed before its response is held.
    await held.promise;
    return ack(content, options);
  });
  await edit('original committed A');
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Hide fixture', { exact: true }));
  disk = 'new owner current B';
  generation = 'b';
  observedBinding = { incarnation: birth(), current: () => live };
  const fileQueries = query.getQueryCache().getAll();
  expect(fileQueries).toHaveLength(1);
  const currentRead = await mocks.readFileContent('/work', 'notes.txt');
  act(() => query.setQueryData(fileQueries[0]!.queryKey, currentRead));
  fireEvent.click(screen.getByText('Show fixture', { exact: true }));
  await waitFor(() =>
    expect(screen.getByLabelText('receipt close draft')).toHaveValue('new owner current B')
  );
  const reads = mocks.readFileContent.mock.calls.length;
  held.release();
  await waitFor(() => expect(mocks.readFileContent.mock.calls.length).toBeGreaterThan(reads));
  expect(screen.getByLabelText('receipt close draft')).toHaveValue('new owner current B');
  expect(query.getQueryData(fileQueries[0]!.queryKey)).toMatchObject({
    content: 'new owner current B',
    hash: hash('new owner current B'),
  });
  expect(close).not.toHaveBeenCalled();
});
