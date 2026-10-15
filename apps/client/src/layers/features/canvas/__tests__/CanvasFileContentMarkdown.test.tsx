/**
 * @vitest-environment jsdom
 *
 * Integration coverage for CanvasFileContent's MARKDOWN branch against the REAL
 * Blintz editor (unmocked). This branch shipped a regression — the pencil toggled
 * `editable` but Blintz captured it at construction, so `contenteditable` never
 * flipped — because it was never render-tested end to end. Blintz 0.4.0 makes
 * `editable` reactive; this proves the toggle live through the real editor.
 */
import { createHash, webcrypto } from 'node:crypto';
import type { MarkdownSourcePort } from 'blintz';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  renderHook,
  act,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

// jsdom has no layout and omits the Range geometry methods the actual
// ProseMirror cursor plugin calls. Keep the real editor/plugins/transactions;
// provide the same empty geometry its element APIs return in this environment.
if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: (): DOMRectList => {
      const rects: DOMRect[] = [];
      return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
    },
  });
}
if (!Range.prototype.getBoundingClientRect) {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
}

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
const toggleCanvasCheckbox = vi.fn();
const writeFile = vi.fn();

const DOC_ID = 'doc-md';
const getCanvasDocManagement = vi.fn().mockResolvedValue({
  documentId: DOC_ID,
  generation: 'a'.repeat(64),
  declaration: { routes: [] },
  routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Approval needed' },
  grants: [],
  grantsTruncated: false,
  tokens: [],
  tokensTruncated: false,
  reviews: [],
  reviewsTruncated: false,
});
// This mounted editor owns one actual transport; fresh render objects must not impersonate replacement ownership.
const fileTransport = { readFileContent, toggleCanvasCheckbox, writeFile, getCanvasDocManagement };

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  return {
    useAppStore,
    // The real BlintzCanvas (unmocked here) resolves its theme via this hook.
    useResolvedTheme: () => 'light' as const,
    useTransport: () => fileTransport,
  };
});

// The save hook is unit-tested separately; control it so the edit→save path is
// deterministic and off the real transport. `save` records what the autosave
// debounce flushes.
const mockFileSave = {
  pendingDocumentSave: false,
  canRetryDocumentSave: false,
  retryOriginalSave: vi.fn(),
  status: 'idle' as 'idle' | 'saving' | 'saved' | 'error' | 'conflict',
  conflict: null as { currentHash: string; currentContent: string } | null,
  canSave: true,
  save: vi.fn(),
  overwrite: vi.fn(),
  adoptDisk: vi.fn(),
  getConfirmedBase: vi.fn(),
  canWriteCheckbox: vi.fn(),
  adoptConfirmedCheckbox: vi.fn(),
};
vi.mock('../model/use-canvas-file-save', () => ({
  useCanvasFileSave: vi.fn(() => mockFileSave),
}));

let originalSourcePort: MarkdownSourcePort | undefined;
vi.mock('../ui/BlintzCanvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/BlintzCanvas')>();
  return {
    ...actual,
    BlintzCanvas: (props: Parameters<typeof actual.BlintzCanvas>[0]) => (
      <actual.BlintzCanvas
        {...props}
        onSourceReady={(port) => {
          originalSourcePort = port;
          props.onSourceReady?.(port);
        }}
      />
    ),
  };
});

import { CanvasFileContent } from '../ui/CanvasFileContent';
import { useCanvasFileSave } from '../model/use-canvas-file-save';

function renderMarkdownFile(sourcePath = 'notes.md') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <CanvasFileContent documentId={DOC_ID} content={{ type: 'file', sourcePath }} />
    </QueryClientProvider>
  );
  const view = render(tree());
  return Object.assign(view, { client, refresh: () => view.rerender(tree()) });
}

/** The ProseMirror editable surface Blintz mounts (query by the contenteditable attr). */
function editableSurface(): HTMLElement | null {
  return document.querySelector('[contenteditable]');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCanvasFileSave).mockImplementation(() => mockFileSave);
  originalSourcePort = undefined;
  vi.stubGlobal('crypto', webcrypto);
  mockFileSave.canWriteCheckbox.mockReturnValue(true);
  mockFileSave.adoptConfirmedCheckbox.mockReturnValue(true);
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

it('uses the native writer for a mapped task and applies acknowledged bytes in the same real editor', async () => {
  const before = '- [ ] original\r\n\r\nTail\r\n';
  const after = '- [x] original\r\n\r\nTail\r\n';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  readFileContent.mockResolvedValue({ content: before, hash: hash(before), encoding: 'utf-8' });
  mockFileSave.getConfirmedBase.mockReturnValue({ content: before, hash: hash(before) });
  let release!: () => void;
  const responseHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  toggleCanvasCheckbox.mockImplementation(async (request) => {
    await responseHeld;
    return {
      status: 'changed',
      fileVersion: hash(after),
      receipt: { id: request.eventId, docSeq: 1, status: 'recorded' },
    };
  });
  renderMarkdownFile();
  await waitFor(() => expect(editableSurface()).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  const task = await screen.findByRole('checkbox', { name: 'original' });
  const surface = editableSurface();
  surface!.focus();
  const focused = document.activeElement;
  surface!.scrollTop = 41;
  fireEvent.click(task);
  await waitFor(() => expect(toggleCanvasCheckbox).toHaveBeenCalledTimes(1));
  const pendingAnnouncement = screen.getByRole('status');
  expect(pendingAnnouncement).toHaveTextContent('Saving task…');
  expect(surface!.contains(pendingAnnouncement)).toBe(false);
  expect(screen.getByRole('checkbox', { name: 'original' })).toBe(task);
  expect(surface).toHaveAttribute('contenteditable', 'true');
  expect(document.activeElement).toBe(focused);
  fireEvent.click(task);
  expect(toggleCanvasCheckbox).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
    await responseHeld;
  });
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'original' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  );
  expect(toggleCanvasCheckbox).toHaveBeenCalledTimes(1);
  expect(toggleCanvasCheckbox).toHaveBeenCalledWith(
    expect.objectContaining({
      documentId: DOC_ID,
      line: 1,
      done: true,
      expectedFileVersion: hash(before),
      textHash: hash('- [ ] original'),
    })
  );
  expect(mockFileSave.adoptConfirmedCheckbox).toHaveBeenCalledWith(before, {
    content: after,
    hash: hash(after),
  });
  expect(screen.queryByText('Saving task…')).not.toBeInTheDocument();
  expect(editableSurface()).toBe(surface);
  expect(screen.getByRole('checkbox', { name: 'original' })).toBe(task);
  expect(document.activeElement).toBe(focused);
  expect(surface!.scrollTop).toBe(41);
  expect(mockFileSave.save).not.toHaveBeenCalled();
});

it('reserves before hashing and refuses native dispatch if an ordinary save starts during that await', async () => {
  const before = '- [ ] original\n';
  const hash = createHash('sha256').update(before).digest('hex');
  readFileContent.mockResolvedValue({ content: before, hash, encoding: 'utf-8' });
  mockFileSave.getConfirmedBase.mockReturnValue({ content: before, hash });
  const { useCanvasFileSave: originalFileSave } = await vi.importActual<
    typeof import('../model/use-canvas-file-save')
  >('../model/use-canvas-file-save');
  const actual = renderHook(() =>
    originalFileSave({ sourcePath: 'notes.md', cwd: '/work', loadedContent: before })
  );
  mockFileSave.canWriteCheckbox.mockImplementation((text) =>
    actual.result.current.canWriteCheckbox(text)
  );
  let releaseHash!: () => void;
  const heldHash = new Promise<ArrayBuffer>((resolve) => {
    releaseHash = () => {
      void webcrypto.subtle
        .digest('SHA-256', new TextEncoder().encode('- [ ] original'))
        .then(resolve);
    };
  });
  const digest = vi.fn(() => heldHash);
  vi.stubGlobal('crypto', { subtle: { digest }, randomUUID: () => webcrypto.randomUUID() });
  renderMarkdownFile();
  await waitFor(() => expect(editableSurface()).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  const task = await screen.findByRole('checkbox', { name: 'original' });
  act(() => {
    task.click();
    task.click();
  });
  expect(digest).toHaveBeenCalledTimes(1);
  let releaseSave!: (result: unknown) => void;
  let entered!: () => void;
  const saveEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  writeFile.mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => {
      releaseSave = resolve;
    });
  });
  let save!: ReturnType<typeof actual.result.current.save>;
  await act(async () => {
    save = actual.result.current.save('ordinary changed draft');
    await saveEntered;
  });
  await act(async () => {
    releaseHash();
    await heldHash;
  });
  await screen.findByText('Finish the current file save before changing a task.');
  expect(toggleCanvasCheckbox).not.toHaveBeenCalled();
  expect(writeFile).toHaveBeenCalledWith('/work', 'notes.md', 'ordinary changed draft', {
    expectedContent: before,
  });
  await act(async () => {
    releaseSave({ ok: true, effect: 'changed', hash: 'ordinary-hash' });
    await save;
  });
  expect(actual.result.current.getConfirmedBase()).toEqual({
    content: 'ordinary changed draft',
    hash: 'ordinary-hash',
  });
});

it('rebinds confirmed autosave bytes to the same edited Blintz model before a native task write', async () => {
  const before = '- [ ] original\n\nTail\n';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  readFileContent.mockResolvedValue({ content: before, hash: hash(before), encoding: 'utf-8' });
  mockFileSave.getConfirmedBase.mockReturnValue({ content: before, hash: hash(before) });
  let submitted = '',
    releaseSave!: () => void;
  const heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  mockFileSave.save.mockImplementation(async (text: string) => {
    submitted = text;
    mockFileSave.status = 'saving';
    await heldSave;
    mockFileSave.getConfirmedBase.mockReturnValue({ content: text, hash: hash(text) });
    mockFileSave.status = 'saved';
    return { status: 'changed', confirmed: { content: text, hash: hash(text) } };
  });
  toggleCanvasCheckbox.mockImplementation(async (request) => ({
    status: 'changed',
    fileVersion: hash(submitted.replace('[ ]', '[x]')),
    receipt: { id: request.eventId, docSeq: 1, status: 'recorded' },
  }));
  const view = renderMarkdownFile();
  await waitFor(() => expect(editableSurface()).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  await screen.findByRole('checkbox', { name: 'original' });
  const surface = editableSurface()!;
  if (!originalSourcePort) throw new Error('Original real Blintz source port unavailable');
  const binding = vi.spyOn(originalSourcePort, 'bindSource');
  const paragraph = Array.from(surface.querySelectorAll('p')).at(-1)!;
  // Exercise the real ProseMirror DOM observer, serializer and raw-mapping invalidation.
  act(() => {
    paragraph.textContent = 'A changed draft retained through its native save.';
    fireEvent.input(surface);
  });
  await waitFor(() => expect(mockFileSave.save).toHaveBeenCalledTimes(1));
  expect(submitted).toContain('A changed draft retained through its native save.');
  expect(screen.queryByRole('checkbox', { name: 'original' })).toBeNull();
  await act(async () => {
    releaseSave();
    await heldSave;
  });
  view.refresh();
  await waitFor(() => expect(binding).toHaveBeenCalled());
  expect(binding.mock.calls.at(-1)?.[0]).toBe(submitted);
  expect(binding.mock.results.at(-1)?.value).toMatchObject({ kind: 'mapped' });
  const task = await screen.findByRole('checkbox', { name: 'original' });
  expect(editableSurface()).toBe(surface);
  expect(surface).toHaveTextContent('A changed draft retained through its native save.');
  task.focus();
  fireEvent.click(task);
  await waitFor(() => expect(task).toHaveAttribute('aria-checked', 'true'));
  expect(toggleCanvasCheckbox).toHaveBeenCalledWith(
    expect.objectContaining({ expectedFileVersion: hash(submitted) })
  );
  expect(screen.getByRole('checkbox', { name: 'original' })).toBe(task);
  expect(document.activeElement).toBe(task);
  expect(mockFileSave.save).toHaveBeenCalledTimes(1);
});

it('retains a one-line LF task through the original save owner, query cache and acknowledged marker transaction', async () => {
  const before = '- [ ] Native browser task\n';
  const after = '- [x] Native browser task\n';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const { useCanvasFileSave: originalFileSave } = await vi.importActual<
    typeof import('../model/use-canvas-file-save')
  >('../model/use-canvas-file-save');
  vi.mocked(useCanvasFileSave).mockImplementation(originalFileSave);
  let disk = before;
  readFileContent.mockImplementation(async () => ({
    content: disk,
    hash: hash(disk),
    encoding: 'utf-8',
  }));
  writeFile.mockImplementation(async (_cwd, _path, text: string, expected) => {
    const currentHash = hash(disk);
    if (
      (expected.expectedHash !== undefined && expected.expectedHash !== currentHash) ||
      (expected.expectedContent !== undefined && expected.expectedContent !== disk)
    )
      return { ok: false, conflict: { currentHash, currentContent: disk } };
    const effect = text === disk ? 'no_op' : 'changed';
    disk = text;
    return { ok: true, effect, hash: hash(disk) };
  });
  let release!: () => void;
  const responseHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  toggleCanvasCheckbox.mockImplementation(async (request) => {
    expect(request.expectedFileVersion).toBe(hash(disk));
    disk = request.done ? after : before;
    await responseHeld;
    return {
      status: 'changed',
      fileVersion: hash(disk),
      receipt: { id: request.eventId, docSeq: request.done ? 1 : 2, status: 'recorded' },
    };
  });
  const view = renderMarkdownFile();
  await waitFor(() => expect(editableSurface()).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  const task = await screen.findByRole('checkbox', { name: 'Native browser task' });
  const surface = editableSurface();
  if (!originalSourcePort) throw new Error('Original real Blintz source port unavailable');
  // Default spy delegates to the original public method; it does not synthesize mapping.
  const applied = vi.spyOn(originalSourcePort, 'applyConfirmedTaskToggle');
  task.focus();
  fireEvent.click(task);
  await waitFor(() => expect(toggleCanvasCheckbox).toHaveBeenCalledTimes(1));
  expect(disk).toBe(after);
  expect(screen.getByRole('checkbox', { name: 'Native browser task' })).toBe(task);
  expect(applied).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  await act(async () => {
    release();
    await responseHeld;
  });
  await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
  const originalApply = applied.mock.results[0]?.value;
  if (originalApply?.kind !== 'mapped') {
    const current = originalSourcePort.snapshot();
    const owner = vi.mocked(useCanvasFileSave).mock.results.at(-1)?.value;
    // Bounded public DATA from this exact known one-line fixture, not a replacement result.
    console.error(
      'ORIGINAL_EDITOR_APPLY_RESULT',
      JSON.stringify({
        apply:
          originalApply?.kind === 'unavailable'
            ? { kind: originalApply.kind, reason: originalApply.reason }
            : { kind: originalApply?.kind },
        requestedGeneration: applied.mock.calls[0]?.[0].generation,
        currentGeneration: originalSourcePort.generation(),
        currentMapping: current.kind,
        snapshotGeneration: current.kind === 'mapped' ? current.generation : undefined,
        fileSaveStatus: owner?.status,
        confirmedHash: owner?.getConfirmedBase().hash,
        physicalHash: hash(disk),
        ordinaryWrites: writeFile.mock.calls.length,
      })
    );
  }
  expect(originalApply).toMatchObject({ kind: 'mapped' });
  await waitFor(() => expect(task).toHaveAttribute('aria-checked', 'true'));
  expect(view.client.getQueryData(['canvas-file', '/work', 'notes.md'])).toMatchObject({
    content: after,
    hash: hash(after),
  });
  expect(editableSurface()).toBe(surface);
  expect(document.activeElement).toBe(task);
  expect(
    screen.queryByText('This editor changed while the task was saved. Reload and review this task.')
  ).toBeNull();
  expect(writeFile).not.toHaveBeenCalled();
  fireEvent.click(task);
  await waitFor(() => expect(applied).toHaveBeenCalledTimes(2));
  expect(applied.mock.results[1]?.value).toMatchObject({ kind: 'mapped' });
  await waitFor(() => expect(task).toHaveAttribute('aria-checked', 'false'));
  expect(view.client.getQueryData(['canvas-file', '/work', 'notes.md'])).toMatchObject({
    content: before,
    hash: hash(before),
  });
  expect(editableSurface()).toBe(surface);
  expect(screen.getByRole('checkbox', { name: 'Native browser task' })).toBe(task);
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
  expect(writeFile).toHaveBeenCalledWith('/work', 'notes.md', before, {
    expectedHash: hash(before),
    documentSave: {
      documentId: DOC_ID,
      expectedGeneration: 'a'.repeat(64),
      eventId: expect.any(String),
      expectedFileHash: hash(before),
    },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit file' })).toBeVisible());
  expect(toggleCanvasCheckbox).toHaveBeenCalledTimes(2);
  expect(disk).toBe(before);
});

it('keeps a newer displayed draft visibly unsaved after original retry confirms older bytes and offers explicit current-draft save', async () => {
  const initial = '- [ ] original\n\nTail\n';
  readFileContent.mockResolvedValue({
    content: initial,
    hash: createHash('sha256').update(initial).digest('hex'),
    encoding: 'utf-8',
  });
  mockFileSave.getConfirmedBase.mockReturnValue({
    content: initial,
    hash: createHash('sha256').update(initial).digest('hex'),
  });
  const view = renderMarkdownFile();
  await waitFor(() => expect(editableSurface()).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
  await screen.findByRole('checkbox', { name: 'original' });
  const surface = editableSurface()!;
  await waitFor(() => expect(surface).toHaveAttribute('contenteditable', 'true'));
  // Mutate the actual existing model paragraph, not a derived empty trailing node.
  const paragraph = Array.from(surface.querySelectorAll('p')).find(
    (node) => node.textContent === 'Tail'
  );
  if (!paragraph) throw new Error('Original editable model paragraph unavailable');
  act(() => {
    paragraph.textContent = 'Newer local draft';
    fireEvent.input(surface);
  });
  await waitFor(() => expect(mockFileSave.save).toHaveBeenCalled());
  const newer = mockFileSave.save.mock.calls.at(-1)![0];
  mockFileSave.getConfirmedBase.mockReturnValue({
    content: 'Older confirmed draft\n',
    hash: 'c'.repeat(64),
  });
  mockFileSave.status = 'saved';
  view.refresh();
  expect(screen.getByText('Draft not saved')).toBeVisible();
  expect(surface).toHaveTextContent('Newer local draft');
  const before = mockFileSave.save.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Finish editing' }));
  await waitFor(() => expect(mockFileSave.save).toHaveBeenCalledTimes(before + 1));
  expect(mockFileSave.save.mock.calls.at(-1)![0]).toBe(newer);
});
