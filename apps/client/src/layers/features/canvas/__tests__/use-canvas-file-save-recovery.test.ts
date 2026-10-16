/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { FileSaveDiscovery } from '@dorkos/shared/file-save/recovery';
const port = { discover: vi.fn(), recover: vi.fn() };
const transport = createMockTransport({ originalFileSaveRecovery: port });
let currentTransport = transport;
vi.mock('@/layers/shared/model', () => ({ useTransport: () => currentTransport }));
import { useCanvasFileSave } from '../model/use-canvas-file-save';
const birth = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
const binding = { incarnation: birth, current: () => true };
const args = {
  cwd: '/work',
  sourcePath: 'notes.txt',
  loadedContent: 'base',
  documentId: 'doc-1',
  documentSaveBinding: binding,
  documentRecoveryBinding: binding,
};
const clear = (): FileSaveDiscovery => ({
  documentId: 'doc-1',
  incarnation: birth,
  entries: [],
  hasMore: false,
  window: 'latest_25_current_owner_birth',
  admission: 'not_observed_blocked',
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  currentTransport = transport;
  port.discover.mockReset().mockResolvedValue(clear());
  port.recover.mockReset();
  vi.mocked(transport.writeFile).mockReset();
  vi.mocked(transport.readFileContent).mockReset();
});
it('pending discovery fences ordinary save and the explicit retired final drain', async () => {
  const { result, unmount } = renderHook(() => useCanvasFileSave(args));
  const handle = result.current.prepareFinalSave('latest');
  await act(async () => {
    expect(await result.current.save('new')).toEqual({ status: 'error' });
  });
  unmount();
  expect(await handle!.flush()).toEqual({ status: 'error' });
  expect(transport.writeFile).not.toHaveBeenCalled();
});
it('discovery waits on the same tail after an already dispatched ordinary write', async () => {
  const wire = deferred<{ ok: true; hash: string; effect: 'changed' }>();
  vi.mocked(transport.writeFile).mockReturnValue(wire.promise);
  // A recovery-only binding still uses the original plain-save server contract.
  const { result } = renderHook(() =>
    useCanvasFileSave({ ...args, documentSaveBinding: undefined })
  );
  await act(async () => {
    await result.current.recovery.discover();
  });
  port.discover.mockClear();
  let saving!: ReturnType<typeof result.current.save>;
  act(() => {
    saving = result.current.save('first');
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(transport.writeFile).toHaveBeenCalledTimes(1);
  let discovering!: ReturnType<typeof result.current.recovery.discover>;
  act(() => {
    discovering = result.current.recovery.discover(true);
  });
  expect(port.discover).not.toHaveBeenCalled();
  await act(async () => {
    wire.resolve({ ok: true, hash: 'b'.repeat(64), effect: 'changed' });
    await saving;
    await discovering;
  });
  expect(port.discover).toHaveBeenCalledTimes(1);
  expect(result.current.getConfirmedBase().hash).toBe('b'.repeat(64));
});
it('mounted uncertainty refuses discovery recovery and preserves original retry UUID and body', async () => {
  vi.mocked(transport.writeFile)
    .mockRejectedValueOnce(new Error('response lost'))
    .mockImplementationOnce(async (_cwd, _path, _content, options) => ({
      ok: true,
      hash: 'b'.repeat(64),
      effect: 'no_op',
      documentReceipt: {
        ...options!.documentSave!,
        fileHash: 'b'.repeat(64),
        docSeq: 1,
        status: 'duplicate',
      },
    }));
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'latest',
    hash: 'b'.repeat(64),
    encoding: 'utf-8',
  });
  const { result } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    await result.current.recovery.discover();
    await result.current.save('latest');
  });
  expect(result.current.status).toBe('uncertain');
  const original = vi.mocked(transport.writeFile).mock.calls[0];
  await act(async () => {
    expect(await result.current.recovery.recover('10000000-0000-4000-8000-000000000001')).toEqual({
      status: 'local_uncertain',
    });
  });
  expect(port.recover).not.toHaveBeenCalled();
  await act(async () => {
    expect(await result.current.retryUnconfirmed()).toEqual({
      status: 'no_op',
      confirmed: { hash: 'b'.repeat(64), content: 'latest' },
    });
  });
  expect(vi.mocked(transport.writeFile).mock.calls[1]).toEqual(original);
  expect(transport.readFileContent).toHaveBeenCalledExactlyOnceWith('/work', 'notes.txt');
  expect(result.current.getConfirmedBase()).toEqual({ hash: 'b'.repeat(64), content: 'latest' });
  expect(result.current.documentReceipt).toMatchObject({
    documentId: 'doc-1',
    eventId: original[3]!.documentSave!.eventId,
    incarnation: birth,
    fileHash: 'b'.repeat(64),
    status: 'duplicate',
  });
  expect(result.current.status).toBe('saved');
});
it('late current-file inspection returns idle across a replacement transport and never adopts its bytes', async () => {
  const held = deferred<{ content: string; hash: string; encoding: 'utf-8' }>();
  vi.mocked(transport.readFileContent).mockReturnValue(held.promise);
  const { result, rerender } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    await result.current.recovery.discover();
  });
  let reading!: ReturnType<typeof result.current.recovery.inspectCurrent>;
  act(() => {
    reading = result.current.recovery.inspectCurrent();
  });
  await act(async () => {
    await Promise.resolve();
  });
  currentTransport = createMockTransport({
    originalFileSaveRecovery: { discover: vi.fn().mockResolvedValue(clear()), recover: vi.fn() },
  });
  rerender();
  await act(async () => {
    held.resolve({ content: 'old owner evidence', hash: 'b'.repeat(64), encoding: 'utf-8' });
    expect(await reading).toEqual({ status: 'idle' });
  });
  expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'base' });
  expect(currentTransport.writeFile).not.toHaveBeenCalled();
});
it('fresh inspection alone never advances the confirmed base', async () => {
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'later file',
    hash: 'c'.repeat(64),
    encoding: 'utf-8',
  });
  const { result } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    await result.current.recovery.discover();
    expect(await result.current.recovery.inspectCurrent()).toEqual({
      status: 'observed',
      value: { content: 'later file', hash: 'c'.repeat(64) },
    });
  });
  expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'base' });
  expect(transport.writeFile).not.toHaveBeenCalled();
});
it('a throwing current observation is safely idle and cannot unlock saving', async () => {
  const { result } = renderHook(() =>
    useCanvasFileSave({
      ...args,
      documentSaveBinding: undefined,
      documentRecoveryBinding: {
        incarnation: birth,
        current: () => {
          throw new Error('retired');
        },
      },
    })
  );
  expect(await result.current.recovery.discover()).toEqual({ status: 'idle' });
  await act(async () => {
    expect(await result.current.save('new')).toEqual({ status: 'error' });
  });
  expect(port.discover).not.toHaveBeenCalled();
  expect(transport.writeFile).not.toHaveBeenCalled();
});
it('a foreign-birth discovery response leaves the original lane unavailable', async () => {
  port.discover.mockResolvedValue({
    ...clear(),
    incarnation: { ...birth, generation: 'f'.repeat(64) },
  });
  const { result } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    expect(await result.current.recovery.discover()).toEqual({ status: 'unavailable' });
    expect(await result.current.save('new')).toEqual({ status: 'error' });
  });
  expect(transport.writeFile).not.toHaveBeenCalled();
});

it('a discovery fence blocks an actual conflict overwrite without changing its confirmed base', async () => {
  vi.mocked(transport.writeFile).mockResolvedValue({
    ok: false,
    conflict: { currentHash: 'c'.repeat(64), currentContent: 'other writer' },
  });
  const { result } = renderHook(() =>
    useCanvasFileSave({ ...args, documentSaveBinding: undefined })
  );
  await act(async () => {
    await result.current.recovery.discover();
    await result.current.save('mine');
  });
  expect(result.current.status).toBe('conflict');
  port.discover.mockResolvedValue({ ...clear(), admission: 'blocked' });
  await act(async () => {
    await result.current.recovery.discover(true);
    expect(await result.current.overwrite('mine')).toEqual({ status: 'error' });
  });
  expect(transport.writeFile).toHaveBeenCalledTimes(1);
  expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'base' });
});
