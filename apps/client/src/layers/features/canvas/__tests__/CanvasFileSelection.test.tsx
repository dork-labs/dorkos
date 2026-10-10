/** @vitest-environment jsdom */
import { useEffect } from 'react';
import { createHash, webcrypto } from 'node:crypto';
import type { MarkdownSourcePort } from 'blintz';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

// This tests UI DATA forwarding/lifetime. The native endpoint independently
// reobserves source and authorizes the original host command; this port is no permit.
const text = 'one two';
const hash = createHash('sha256').update(text).digest('hex');
const generation = 'editor:1';
const source = { generation, text };
const selection = {
  kind: 'mapped' as const,
  generation,
  value: {
    direction: 'forward' as const,
    ranges: [{ start: 0, end: 3, startLine: 1, endLine: 1, startColumn: 0, endColumn: 3 }],
  },
};
const port: MarkdownSourcePort = {
  generation: () => source.generation,
  snapshot: () => ({
    kind: 'mapped',
    generation: source.generation,
    value: { text: source.text, generation: source.generation },
  }),
  selection: () => selection,
  taskAt: () => ({ kind: 'unavailable', reason: 'unmapped' }),
  bindSource: () => {
    throw new Error('Selection must not edit its DATA subject.');
  },
  applyConfirmedTaskToggle: () => {
    throw new Error('Selection must not toggle its DATA subject.');
  },
};
const readFileContent = vi.fn();
const getCanvasDocManagement = vi.fn();
const askCanvasDocSelection = vi.fn();
const firstTransport = { readFileContent, getCanvasDocManagement, askCanvasDocSelection };
let transport = firstTransport;
const state = {
  selectedCwd: '/work',
  openDocuments: [{ id: 'doc-a', editing: false }],
  setDocumentEditing: vi.fn(),
};
vi.mock('@/layers/shared/model', () => {
  const useAppStore = (select: (value: typeof state) => unknown) => select(state);
  Object.assign(useAppStore, { getState: () => state });
  return { useAppStore, useTransport: () => transport, useResolvedTheme: () => 'light' };
});
const confirmed = { content: text, hash };
const save = {
  status: 'idle',
  conflict: null,
  canSave: true,
  save: vi.fn(),
  overwrite: vi.fn(),
  adoptDisk: vi.fn(),
  getConfirmedBase: () => confirmed,
  canWriteCheckbox: () => true,
  adoptConfirmedCheckbox: vi.fn(),
};
vi.mock('../model/use-canvas-file-save', () => ({ useCanvasFileSave: () => save }));
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({
    onSourceReady,
    onSourceSelection,
  }: import('../ui/BlintzCanvas').BlintzCanvasProps) => {
    useEffect(() => {
      onSourceReady?.(port);
    }, [onSourceReady]);
    return (
      <button type="button" onClick={() => onSourceSelection?.(selection)}>
        Select source text
      </button>
    );
  },
}));
import { CanvasFileContent } from '../ui/CanvasFileContent';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function renderSelection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <CanvasFileContent documentId="doc-a" content={{ type: 'file', sourcePath: 'notes.md' }} />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()) };
}
async function selectAndAsk() {
  fireEvent.click(await screen.findByRole('button', { name: 'Select source text' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ask about selection' }));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  transport = firstTransport;
  source.generation = generation;
  source.text = text;
  readFileContent.mockResolvedValue({ content: text, hash, encoding: 'utf-8' });
  getCanvasDocManagement.mockResolvedValue({ documentId: 'doc-a', generation: 'a'.repeat(64) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('original saved selection UI', () => {
  it('refuses a replaced source during management preparation before dispatch', async () => {
    const held = deferred<{ documentId: string; generation: string }>();
    getCanvasDocManagement.mockReturnValue(held.promise);
    renderSelection();
    await selectAndAsk();
    await waitFor(() => expect(getCanvasDocManagement).toHaveBeenCalledOnce());
    source.generation = 'editor:2';
    await act(async () => {
      held.resolve({ documentId: 'doc-a', generation: 'a'.repeat(64) });
    });
    await screen.findByText('This selection changed before it could be recorded.');
    expect(askCanvasDocSelection).not.toHaveBeenCalled();
  });
  it('retries the exact same event/source request after an unconfirmed response', async () => {
    askCanvasDocSelection.mockImplementationOnce(async (request) => {
      // An alternate Transport cannot rewrite the retained retry subject.
      expect(Reflect.set(request, 'eventId', 'foreign')).toBe(false);
      expect(Reflect.set(request.ranges[0], 'start', 4)).toBe(false);
      expect(Reflect.set(request.ranges, '0', { start: 4, end: 7 })).toBe(false);
      throw new Error('Response unavailable');
    });
    askCanvasDocSelection.mockImplementationOnce(async (request) => ({
      receipt: { id: request.eventId },
    }));
    renderSelection();
    await selectAndAsk();
    const retry = await screen.findByRole('button', { name: 'Retry same selection' });
    await waitFor(() => expect(retry).not.toBeDisabled());
    fireEvent.click(retry);
    await screen.findByText('Selection recorded. Selected text is context, not instructions.');
    expect(askCanvasDocSelection).toHaveBeenCalledTimes(2);
    expect(askCanvasDocSelection.mock.calls[1][0]).toBe(askCanvasDocSelection.mock.calls[0][0]);
    expect(askCanvasDocSelection.mock.calls[0][0]).toMatchObject({
      documentId: 'doc-a',
      expectedFileHash: hash,
      sourceGeneration: generation,
      ranges: [{ start: 0, end: 3 }],
      selectedText: 'one',
    });
    expect(getCanvasDocManagement).toHaveBeenCalledOnce();
  });
  it('cannot publish an old transport result into the replacement owner', async () => {
    const held = deferred<{ receipt: { id: string } }>();
    askCanvasDocSelection.mockReturnValue(held.promise);
    const view = renderSelection();
    await selectAndAsk();
    await waitFor(() => expect(askCanvasDocSelection).toHaveBeenCalledOnce());
    const eventId = askCanvasDocSelection.mock.calls[0][0].eventId;
    transport = { ...firstTransport };
    view.refresh();
    await act(async () => {
      held.resolve({ receipt: { id: eventId } });
    });
    expect(
      screen.queryByText('Selection recorded. Selected text is context, not instructions.')
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry same selection' })).toBeNull();
  });
});
