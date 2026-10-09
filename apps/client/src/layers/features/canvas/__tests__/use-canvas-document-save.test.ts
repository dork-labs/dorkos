/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CanvasChannelManagementSnapshot } from '@dorkos/shared/canvas-channel-schemas';
const current = vi.hoisted(() => ({ transport: null as unknown }));
vi.mock('@/layers/shared/model', () => ({ useTransport: () => current.transport }));
import { useCanvasFileSave } from '../model/use-canvas-file-save';
afterEach(cleanup);
const metadata: CanvasChannelManagementSnapshot = {
  documentId: 'doc-a',
  generation: 'a'.repeat(64),
  declaration: { routes: [] },
  routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Approval needed' },
  grants: [],
  grantsTruncated: false,
  tokens: [],
  tokensTruncated: false,
  reviews: [],
  reviewsTruncated: false,
};
const args = {
  documentId: 'doc-a',
  sourcePath: 'source.md',
  cwd: '/work',
  loadedContent: 'original\n',
  initialHash: 'b'.repeat(64),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function received(id: string, status: 'recorded' | 'duplicate' = 'recorded') {
  return { receipt: { id, status, docSeq: 1 }, deliveries: [] };
}
it('captures native management before any write and freezes the exact source/generation operation', async () => {
  const held = deferred<CanvasChannelManagementSnapshot>();
  const transport = createMockTransport({
    getCanvasDocManagement: vi.fn(() => held.promise),
    writeFile: vi.fn(async (_cwd, _path, _content, options) => ({
      ok: true as const,
      effect: 'changed' as const,
      hash: 'c'.repeat(64),
      documentReceipt: received(options!.documentSave!.eventId),
    })),
  });
  current.transport = transport;
  const view = renderHook(() => useCanvasFileSave(args));
  let saved: ReturnType<typeof view.result.current.save>;
  await act(async () => {
    saved = view.result.current.save('changed\n');
    await Promise.resolve();
  });
  expect(transport.writeFile).not.toHaveBeenCalled();
  await act(async () => {
    held.resolve(metadata);
    await saved!;
  });
  const options = vi.mocked(transport.writeFile).mock.calls[0]![3]!;
  expect(options).toMatchObject({
    expectedContent: args.loadedContent,
    documentSave: {
      documentId: args.documentId,
      expectedGeneration: metadata.generation,
      expectedFileHash: args.initialHash,
    },
  });
  expect(Object.isFrozen(options)).toBe(true);
  expect(Object.isFrozen(options.documentSave)).toBe(true);
  expect(view.result.current.getConfirmedBase()).toEqual({
    content: 'changed\n',
    hash: 'c'.repeat(64),
  });
});
it('keeps one unknown operation across queued newer drafts and explicit identical retry without advancing the base', async () => {
  const transport = createMockTransport({
    getCanvasDocManagement: vi.fn().mockResolvedValue(metadata),
    writeFile: vi.fn().mockRejectedValueOnce(undefined),
  });
  current.transport = transport;
  const view = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    expect(
      await Promise.all([view.result.current.save('first\n'), view.result.current.save('newer\n')])
    ).toEqual([{ status: 'error' }, { status: 'error' }]);
  });
  expect(transport.writeFile).toHaveBeenCalledOnce();
  expect(view.result.current.getConfirmedBase()).toEqual({
    content: args.loadedContent,
    hash: null,
  });
  expect(view.result.current.canWriteCheckbox(args.loadedContent)).toBe(false);
  const original = vi.mocked(transport.writeFile).mock.calls[0]![3]!;
  vi.mocked(transport.writeFile).mockImplementationOnce(async (_cwd, _path, _content, options) => {
    expect(options).toBe(original);
    return {
      ok: true,
      effect: 'no_op',
      hash: 'c'.repeat(64),
      documentReceipt: received(options!.documentSave!.eventId, 'duplicate'),
    };
  });
  await act(async () => {
    expect((await view.result.current.retryOriginalSave()).status).toBe('no_op');
  });
  expect(transport.getCanvasDocManagement).toHaveBeenCalledOnce();
  expect(view.result.current.pendingDocumentSave).toBe(false);
  expect(view.result.current.getConfirmedBase()).toEqual({
    content: 'first\n',
    hash: 'c'.repeat(64),
  });
});
it('does not confirm changed bytes from a missing native receipt', async () => {
  const transport = createMockTransport({
    getCanvasDocManagement: vi.fn().mockResolvedValue(metadata),
    writeFile: vi.fn().mockResolvedValue({ ok: true, hash: 'c'.repeat(64), effect: 'changed' }),
  });
  current.transport = transport;
  const view = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    expect(await view.result.current.save('changed\n')).toEqual({ status: 'error' });
  });
  expect(view.result.current.pendingDocumentSave).toBe(true);
  expect(view.result.current.getConfirmedBase()).toEqual({
    content: args.loadedContent,
    hash: null,
  });
});
it('retires an old source completion before it can publish into the replacement document', async () => {
  const held = deferred<Awaited<ReturnType<ReturnType<typeof createMockTransport>['writeFile']>>>();
  const transport = createMockTransport({
    getCanvasDocManagement: vi.fn().mockResolvedValue(metadata),
    writeFile: vi.fn(() => held.promise),
  });
  current.transport = transport;
  const view = renderHook((props) => useCanvasFileSave(props), { initialProps: args });
  let pending: ReturnType<typeof view.result.current.save>;
  await act(async () => {
    pending = view.result.current.save('old changed\n');
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(transport.writeFile).toHaveBeenCalledOnce());
  const oldOptions = vi.mocked(transport.writeFile).mock.calls[0]![3]!;
  const retiredSaver = view.result.current;
  const replacement = {
    ...args,
    documentId: 'doc-b',
    sourcePath: 'other.md',
    loadedContent: 'replacement\n',
    initialHash: 'd'.repeat(64),
  };
  view.rerender(replacement);
  await act(async () => {
    expect(await retiredSaver.save('retired request\n')).toEqual({ status: 'idle' });
  });
  await act(async () => {
    held.resolve({
      ok: true,
      effect: 'changed',
      hash: 'c'.repeat(64),
      documentReceipt: received(oldOptions.documentSave!.eventId),
    });
    expect(await pending!).toEqual({ status: 'idle' });
  });
  expect(view.result.current.status).toBe('idle');
  expect(view.result.current.pendingDocumentSave).toBe(false);
  expect(view.result.current.getConfirmedBase()).toEqual({
    content: replacement.loadedContent,
    hash: null,
  });
  expect(view.result.current.canWriteCheckbox(replacement.loadedContent)).toBe(true);
});

it.each(['hash', 'effect', 'changed-duplicate', 'no-op-recorded'] as const)(
  'retains the original uncertain operation after malformed %s acknowledgement and later conflict',
  async (kind) => {
    const write = vi.fn(
      async (
        _cwd: string,
        _path: string,
        _content: string,
        options: Parameters<ReturnType<typeof createMockTransport>['writeFile']>[3]
      ) => {
        const response = {
          ok: true as const,
          hash: kind === 'hash' ? 'invalid' : 'c'.repeat(64),
          effect: kind === 'no-op-recorded' ? ('no_op' as const) : ('changed' as const),
          documentReceipt: received(
            options!.documentSave!.eventId,
            kind === 'changed-duplicate' ? 'duplicate' : 'recorded'
          ),
        };
        if (kind === 'effect') Reflect.set(response, 'effect', 'invalid');
        return response;
      }
    );
    // An alternate Transport can return malformed data; the hook must retain uncertainty itself.
    const transport = createMockTransport({
      getCanvasDocManagement: vi.fn().mockResolvedValue(metadata),
    });
    vi.mocked(transport.writeFile).mockImplementation(write);
    current.transport = transport;
    const view = renderHook(() => useCanvasFileSave(args));
    await act(async () => {
      expect(await view.result.current.save('changed\n')).toEqual({ status: 'error' });
    });
    const original = vi.mocked(transport.writeFile).mock.calls[0]![3]!;
    vi.mocked(transport.writeFile).mockResolvedValueOnce({
      ok: false,
      conflict: { currentHash: 'd'.repeat(64), currentContent: 'physical changed\n' },
    });
    await act(async () => {
      expect(await view.result.current.retryOriginalSave()).toEqual({ status: 'conflict' });
    });
    expect(vi.mocked(transport.writeFile).mock.calls[1]![3]).toBe(original);
    expect(view.result.current.pendingDocumentSave).toBe(true);
    expect(view.result.current.canWriteCheckbox(args.loadedContent)).toBe(false);
    expect(view.result.current.getConfirmedBase()).toEqual({
      content: args.loadedContent,
      hash: null,
    });
    await act(async () => {
      expect(await view.result.current.save('newer\n')).toEqual({ status: 'error' });
    });
    expect(transport.writeFile).toHaveBeenCalledTimes(2);
  }
);
