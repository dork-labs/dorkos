/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { WriteFileResult } from '@dorkos/shared/transport';
import type { FileSaveDiscovery, FileSaveRecoverResult } from '@dorkos/shared/file-save/recovery';
const port = { discover: vi.fn(), recover: vi.fn() };
const transport = createMockTransport({ originalFileSaveRecovery: port });
let currentTransport = transport;
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
  return { useAppStore, useTransport: () => currentTransport, useResolvedTheme: () => 'light' };
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
const eventId = '10000000-0000-4000-8000-000000000001';
const now = '2026-10-15T00:00:00.000Z';
const clear = (): FileSaveDiscovery => ({
  documentId: birth.documentId,
  incarnation: birth,
  entries: [],
  hasMore: false,
  window: 'latest_25_current_owner_birth',
  admission: 'not_observed_blocked',
});
const review = (): FileSaveDiscovery => ({
  ...clear(),
  admission: 'blocked',
  entries: [
    { eventId, createdAt: now, updatedAt: now, state: 'review', reason: 'replacement_not_proven' },
  ],
});
const receipt = (): FileSaveRecoverResult => ({
  documentId: birth.documentId,
  incarnation: birth,
  entry: {
    eventId,
    createdAt: now,
    updatedAt: now,
    state: 'receipt',
    historical: true,
    currentFileMatch: 'same_saved_replacement',
    receipt: {
      documentId: birth.documentId,
      eventId,
      incarnation: birth,
      docSeq: 7,
      fileHash: 'b'.repeat(64),
      status: 'duplicate',
    },
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  currentTransport = transport;
  port.discover.mockReset().mockResolvedValue(clear());
  port.recover.mockReset().mockResolvedValue(receipt());
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay);
  state.roomCanvasLiveRoomId = null;
  state.openDocuments = [{ id: 'doc-1', editing: false }];
  vi.mocked(transport.getCanvasChannel).mockReset().mockResolvedValue(replay);
  vi.mocked(transport.readFileContent)
    .mockReset()
    .mockResolvedValue({
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

it('cold nonempty saved replay qualifies its current owner before original receipt discovery', async () => {
  const held = deferred<FileSaveDiscovery>();
  port.discover.mockReturnValue(held.promise);
  vi.mocked(transport.getCanvasChannel).mockResolvedValue({
    ...replay,
    highWatermark: 1,
    events: [
      {
        type: 'canvas_event',
        documentId: birth.documentId,
        scope: 'session:session-a',
        incarnation: birth,
        docSeq: 1,
        event: {
          id: eventId,
          type: 'doc.saved',
          payload: { previousFileHash: 'a'.repeat(64), fileHash: 'b'.repeat(64) },
          direction: 'system',
          receivedAt: now,
        },
      },
    ],
    receipts: [
      {
        receipt: { id: eventId, status: 'recorded', docSeq: 1 },
        deliveries: [],
        payloadAvailable: true,
      },
    ],
  });
  view();
  const edit = await screen.findByRole('button', { name: 'Edit file' });
  await waitFor(() => expect(edit).toHaveAttribute('data-document-save-observation', 'ready'));
  await waitFor(() => expect(port.discover).toHaveBeenCalledExactlyOnceWith('doc-1'));
  expect(screen.getByRole('region', { name: 'Previous file saves' })).toBeInTheDocument();
  expect(edit).toBeDisabled();
  await act(async () => held.resolve(clear()));
  await waitFor(() => expect(edit).toBeEnabled());
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
  expect(port.recover).not.toHaveBeenCalled();
});
it('blocks Edit until genuine asynchronous original-save discovery settles without auto recovery', async () => {
  const held = deferred<FileSaveDiscovery>();
  port.discover.mockReturnValue(held.promise);
  view();
  await screen.findByLabelText('draft');
  const edit = screen.getByRole('button', { name: 'Edit file' });
  await waitFor(() => expect(port.discover).toHaveBeenCalledWith('doc-1'));
  expect(edit).toBeDisabled();
  fireEvent.click(edit);
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(port.recover).not.toHaveBeenCalled();
  await act(async () => held.resolve(clear()));
  await waitFor(() => expect(edit).toBeEnabled());
});
it('after remount discovers the retained UUID and explicitly recovers only its original receipt', async () => {
  port.discover.mockResolvedValue(review());
  const mounted = view();
  await screen.findByRole('button', { name: 'Recover original receipt' });
  expect(port.recover).not.toHaveBeenCalled();
  mounted.unmount();
  query.clear();
  const next = view();
  await screen.findByRole('button', { name: 'Recover original receipt' });
  port.discover.mockResolvedValue({ ...clear(), entries: [receipt().entry] });
  fireEvent.click(screen.getByRole('button', { name: 'Recover original receipt' }));
  await screen.findByText('Previous save confirmed.', { exact: false });
  expect(port.recover).toHaveBeenCalledWith('doc-1', eventId, birth);
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(screen.getByLabelText('draft')).toHaveValue('base');
  next.unmount();
});
it('prepared evidence remains manual with no retry-write or recovery action', async () => {
  port.discover.mockResolvedValue({
    ...review(),
    entries: [
      {
        eventId,
        createdAt: now,
        updatedAt: now,
        state: 'review',
        reason: 'prepared_without_replacement',
      },
    ],
  });
  view();
  await screen.findByText('This save needs manual review.', { exact: false });
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Recover original receipt' })
  ).not.toBeInTheDocument();
  expect(port.recover).not.toHaveBeenCalled();
  expect(transport.writeFile).not.toHaveBeenCalled();
});
it('empty bounded history and truncation never override the authoritative blocked observation', async () => {
  port.discover.mockResolvedValue({ ...clear(), admission: 'blocked', hasMore: true });
  view();
  await screen.findByText('No matching recent saves.');
  expect(
    screen.getByText('Only the latest 25 matching saves are shown.', { exact: false })
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
});
it.each(['network', 'malformed'] as const)(
  'existing recovery port %s failure never silently falls back to plain saving',
  async (mode) => {
    if (mode === 'network') port.discover.mockRejectedValue(new Error('offline'));
    else port.discover.mockResolvedValue({} as FileSaveDiscovery);
    view();
    await screen.findByText('Previous save evidence is unavailable.', { exact: false });
    expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
    expect(transport.writeFile).not.toHaveBeenCalled();
  }
);
it('a failed explicit proof-only action stays blocked without replaying file content', async () => {
  port.discover.mockResolvedValue(review());
  port.recover.mockRejectedValue(new Error('lost proof response'));
  view();
  await screen.findByRole('button', { name: 'Recover original receipt' });
  fireEvent.click(screen.getByRole('button', { name: 'Recover original receipt' }));
  await screen.findByText('Previous save evidence is unavailable.', { exact: false });
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
  expect(port.recover).toHaveBeenCalledTimes(1);
  expect(transport.writeFile).not.toHaveBeenCalled();
});
it('historical receipt never replaces the current file until explicit fresh load', async () => {
  port.discover.mockResolvedValue({ ...clear(), entries: [receipt().entry] });
  view();
  await screen.findByText('Historical save recorded', { exact: false });
  expect(screen.getByLabelText('draft')).toHaveValue('base');
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'current later bytes',
    hash: 'c'.repeat(64),
    encoding: 'utf-8',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
  await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('current later bytes'));
  expect(transport.writeFile).not.toHaveBeenCalled();
});
it('inspection failure keeps visible editing blocked instead of adopting malformed file evidence', async () => {
  view();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'bad',
    hash: '',
    encoding: 'utf-8',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
  await screen.findByText('Previous save evidence is unavailable.', { exact: false });
  expect(screen.getByLabelText('draft')).toHaveValue('base');
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
});
it('a late old-owner discovery cannot unblock the replacement transport owner', async () => {
  const held = deferred<FileSaveDiscovery>();
  port.discover.mockReturnValue(held.promise);
  const mounted = view();
  await waitFor(() => expect(port.discover).toHaveBeenCalled());
  const replacementResponse = deferred<FileSaveDiscovery>();
  const replacementPort = {
    discover: vi.fn().mockReturnValue(replacementResponse.promise),
    recover: vi.fn(),
  };
  const replacement = createMockTransport({ originalFileSaveRecovery: replacementPort });
  vi.mocked(replacement.getCanvasChannel).mockResolvedValue(replay);
  vi.mocked(replacement.readFileContent).mockResolvedValue({
    content: 'replacement owner',
    hash: 'c'.repeat(64),
    encoding: 'utf-8',
  });
  currentTransport = replacement;
  mounted.rerender(
    <QueryClientProvider client={query}>
      <CanvasFileContent documentId="doc-1" content={{ type: 'file', sourcePath: 'notes.txt' }} />
    </QueryClientProvider>
  );
  await waitFor(() => expect(replacement.getCanvasChannel).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit file' })).toHaveAttribute(
      'data-document-save-observation',
      'ready'
    )
  );
  // The replacement uses the same dispatch tail, so its request waits for the old one.
  expect(replacementPort.discover).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
  await act(async () => held.resolve(clear()));
  await waitFor(() => expect(replacementPort.discover).toHaveBeenCalledTimes(1));
  // The old owner's clear response cannot enable editing while this owner's check is held.
  expect(screen.getByText('Checking previous saves…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
  await act(async () => replacementResponse.resolve({ ...clear(), admission: 'blocked' }));
  await screen.findByText('An unresolved original save blocks this file.', { exact: false });
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(replacement.writeFile).not.toHaveBeenCalled();
});
it('a late proof result from a disposed editor cannot publish history into a fresh mount', async () => {
  const held = deferred<FileSaveRecoverResult>();
  port.discover.mockResolvedValue(review());
  port.recover.mockReturnValue(held.promise);
  const mounted = view();
  await screen.findByRole('button', { name: 'Recover original receipt' });
  fireEvent.click(screen.getByRole('button', { name: 'Recover original receipt' }));
  await waitFor(() => expect(port.recover).toHaveBeenCalled());
  mounted.unmount();
  query.clear();
  view();
  await screen.findByRole('button', { name: 'Recover original receipt' });
  await act(async () => held.resolve(receipt()));
  expect(screen.queryByText('Previous save confirmed.', { exact: false })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit file' })).toBeDisabled();
  expect(transport.writeFile).not.toHaveBeenCalled();
});
it('a newer local draft and selection are untouched by the recovery panel while editing', async () => {
  port.discover.mockResolvedValue({ ...clear(), entries: [receipt().entry] });
  view();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  const input = screen.getByLabelText('draft') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'newer local draft' } });
  input.focus();
  input.setSelectionRange(3, 7);
  expect(screen.getByRole('button', { name: 'Load current file' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
  expect(input).toHaveValue('newer local draft');
  expect(input.selectionStart).toBe(3);
  expect(input.selectionEnd).toBe(7);
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(transport.writeFile).toHaveBeenCalledTimes(1));
});

it('an admitted fresh read cannot replace a draft entered before the pending render commits', async () => {
  view();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  const held = deferred<{ content: string; hash: string; encoding: 'utf-8' }>();
  vi.mocked(transport.readFileContent).mockReturnValue(held.promise);
  // Both actual clicks share one React batch: the edit callback is still the committed ready callback.
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  });
  await screen.findByRole('button', { name: 'Finish editing' });
  await waitFor(() => expect(transport.readFileContent).toHaveBeenCalledTimes(2));
  const input = screen.getByLabelText('draft') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'newer during inspection' } });
  input.focus();
  input.setSelectionRange(2, 8);
  await act(async () => {
    held.resolve({ content: 'historical read result', hash: 'c'.repeat(64), encoding: 'utf-8' });
  });
  expect(input).toHaveValue('newer during inspection');
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(8);
  expect(query.getQueryData(['canvas-file', '/work', 'notes.txt'])).toMatchObject({
    content: 'base',
    hash: 'a'.repeat(64),
  });
  expect(transport.writeFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(transport.writeFile).toHaveBeenCalledTimes(1));
  expect(vi.mocked(transport.writeFile).mock.calls[0]?.[3]).toMatchObject({
    expectedContent: 'base',
  });
});
it('a fresh-file read admitted by a disposed editor cannot alter a replacement view cache', async () => {
  const mounted = view();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  const held = deferred<{ content: string; hash: string; encoding: 'utf-8' }>();
  vi.mocked(transport.readFileContent).mockReturnValueOnce(held.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
  await waitFor(() => expect(transport.readFileContent).toHaveBeenCalledTimes(2));
  mounted.unmount();
  query.clear();
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'replacement visible bytes',
    hash: 'd'.repeat(64),
    encoding: 'utf-8',
  });
  view();
  await waitFor(() =>
    expect(screen.getByLabelText('draft')).toHaveValue('replacement visible bytes')
  );
  await act(async () =>
    held.resolve({ content: 'retired read result', hash: 'c'.repeat(64), encoding: 'utf-8' })
  );
  expect(screen.getByLabelText('draft')).toHaveValue('replacement visible bytes');
  expect(query.getQueryData(['canvas-file', '/work', 'notes.txt'])).toMatchObject({
    content: 'replacement visible bytes',
    hash: 'd'.repeat(64),
  });
  expect(transport.writeFile).not.toHaveBeenCalled();
});

it('a hidden old read stays held while reopened hash-changing Load settles discovery and permits a newer draft', async () => {
  const mounted = view();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  const oldRead = deferred<{ content: string; hash: string; encoding: 'utf-8' }>();
  vi.mocked(transport.readFileContent).mockReturnValueOnce(oldRead.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
  await waitFor(() => expect(transport.readFileContent).toHaveBeenCalledTimes(2));
  // Hide/unmount the real editor but retain the same query client and stale cached hash.
  mounted.rerender(<QueryClientProvider client={query}>{null}</QueryClientProvider>);
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'fresh reopened bytes',
    hash: 'd'.repeat(64),
    encoding: 'utf-8',
  });
  mounted.rerender(
    <QueryClientProvider client={query}>
      <CanvasFileContent documentId="doc-1" content={{ type: 'file', sourcePath: 'notes.txt' }} />
    </QueryClientProvider>
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  expect(screen.getByLabelText('draft')).toHaveValue('base');
  fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
  await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue('fresh reopened bytes'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  const input = screen.getByLabelText('draft') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'newer draft and selection' } });
  input.focus();
  input.setSelectionRange(2, 7);
  await act(async () =>
    oldRead.resolve({ content: 'retired held bytes', hash: 'c'.repeat(64), encoding: 'utf-8' })
  );
  expect(screen.getByLabelText('draft')).toBe(input);
  expect(input).toHaveValue('newer draft and selection');
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(7);
  expect(document.activeElement).toBe(input);
  expect(query.getQueryData(['canvas-file', '/work', 'notes.txt'])).toMatchObject({
    content: 'fresh reopened bytes',
    hash: 'd'.repeat(64),
  });
  // An ordinary 500ms autosave is legitimate at any point after typing, including on a busy runner.
  // Finish drains that same real save tail; never require the assertions to beat the debounce.
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  expect(transport.writeFile).toHaveBeenCalled();
  for (const [cwd, path, text, options] of vi.mocked(transport.writeFile).mock.calls) {
    expect({ cwd, path, text }).toEqual({
      cwd: '/work',
      path: 'notes.txt',
      text: 'newer draft and selection',
    });
    expect(options?.documentSave).toMatchObject({ documentId: 'doc-1', incarnation: birth });
  }
  expect(query.getQueryData(['canvas-file', '/work', 'notes.txt'])).toMatchObject({
    content: 'newer draft and selection',
  });
  expect(port.recover).not.toHaveBeenCalled();
});

it('a Suspense-hidden retained presenter rediscovers before its old current-file read is released', async () => {
  const oldRead = deferred<{ content: string; hash: string; encoding: 'utf-8' }>();
  const replacement = deferred<void>();
  let hidden = false;
  function Presenter() {
    if (hidden) throw replacement.promise;
    return (
      <CanvasFileContent documentId="doc-1" content={{ type: 'file', sourcePath: 'notes.txt' }} />
    );
  }
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={query}>
      <Suspense fallback={<p>Opening another view</p>}>
        <Presenter />
      </Suspense>
    </QueryClientProvider>
  );
  const rendered = render(tree());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeEnabled());
  const editorButton = screen.getByRole('button', { name: 'Edit file' });
  const discoveries = port.discover.mock.calls.length;
  vi.mocked(transport.readFileContent).mockReturnValueOnce(oldRead.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Load current file' }));
  await waitFor(() => expect(transport.readFileContent).toHaveBeenCalledTimes(2));
  hidden = true;
  rendered.rerender(tree());
  await screen.findByText('Opening another view');
  expect(screen.queryByRole('region', { name: 'Previous file saves' })).toBeNull();
  try {
    hidden = false;
    await act(async () => {
      replacement.resolve();
      rendered.rerender(tree());
    });
    // React hid this editor without destroying its hook refs; reveal requalifies the real channel.
    expect(screen.getByRole('button', { name: 'Edit file' })).toBe(editorButton);
    await waitFor(() => expect(port.discover.mock.calls.length).toBeGreaterThan(discoveries));
    await waitFor(() => expect(editorButton).toBeEnabled());
    expect(transport.writeFile).not.toHaveBeenCalled();
    expect(port.recover).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      oldRead.resolve({
        content: 'obsolete retained read',
        hash: 'c'.repeat(64),
        encoding: 'utf-8',
      });
      await oldRead.promise;
    });
  }
  await waitFor(() => expect(editorButton).toBeEnabled());
  expect(query.getQueryData(['canvas-file', '/work', 'notes.txt'])).toMatchObject({
    content: 'base',
    hash: 'a'.repeat(64),
  });
});
