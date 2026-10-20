/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { WriteFileResult } from '@dorkos/shared/transport';
import type { FileSaveDiscovery } from '@dorkos/shared/file-save/recovery';
const port = { discover: vi.fn(), recover: vi.fn() };
const transport = createMockTransport({ originalFileSaveRecovery: port });
let currentTransport = transport;
vi.mock('@/layers/shared/model', () => ({ useTransport: () => currentTransport }));
import { useCanvasFileSave } from '../model/use-canvas-file-save';
import { useFileSaveRecovery } from '../model/file-save/use-file-save-recovery';
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
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

it('same-owner queued discovery losing currentness settles idle and a later ready observation rediscovers before enabling edit', async () => {
  let current = true;
  const observed = { incarnation: birth, current: () => current };
  let currentObservation = observed;
  const wire = deferred<WriteFileResult>();
  vi.mocked(transport.writeFile).mockReturnValue(wire.promise);
  const { result, rerender } = renderHook(
    ({
      recoveryReady,
      observation,
    }: {
      recoveryReady: boolean;
      observation: 'unavailable' | 'pending' | 'ready';
    }) => {
      const save = useCanvasFileSave({
        ...args,
        documentSaveBinding: observed,
        documentRecoveryBinding: recoveryReady ? currentObservation : undefined,
      });
      const recovery = useFileSaveRecovery(
        save.recovery,
        observation,
        recoveryReady ? currentObservation : undefined
      );
      return { save, recovery };
    },
    {
      initialProps: { recoveryReady: false, observation: 'unavailable' } as {
        recoveryReady: boolean;
        observation: 'unavailable' | 'pending' | 'ready';
      },
    }
  );
  const identity = result.current.save.recovery.identity;
  let saving!: ReturnType<typeof result.current.save.save>;
  act(() => {
    saving = result.current.save.save('already dispatched original');
  });
  await waitFor(() => expect(transport.writeFile).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(transport.writeFile).mock.calls[0]!;
  rerender({ recoveryReady: true, observation: 'ready' });
  expect(result.current.save.recovery.identity).toBe(identity);
  expect(result.current.recovery.editBlocked).toBe(true);
  current = false;
  await act(async () => {
    wire.resolve({
      ok: true,
      effect: 'changed',
      hash: 'b'.repeat(64),
      documentReceipt: {
        ...sent[3]!.documentSave!,
        fileHash: 'b'.repeat(64),
        docSeq: 1,
        status: 'accepted',
      },
    });
    await saving;
    await Promise.resolve();
  });
  expect(port.discover).not.toHaveBeenCalled();
  expect(result.current.recovery.editBlocked).toBe(true);
  current = true;
  currentObservation = { incarnation: { ...birth }, current: () => true };
  rerender({ recoveryReady: true, observation: 'ready' });
  await waitFor(() => expect(port.discover).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.recovery.editBlocked).toBe(false));
  expect(result.current.save.recovery.identity).toBe(identity);
  expect(result.current.recovery.discovery).toEqual(clear());
  expect(transport.writeFile).toHaveBeenCalledTimes(1);
  expect(port.recover).not.toHaveBeenCalled();
});

it('idle current-file inspection invalidates its exact old observed cache and a same-birth read binding triggers fresh discovery', async () => {
  let live = true;
  let observed = { incarnation: birth, current: () => live };
  const held = deferred<{ content: string; hash: string; encoding: 'utf-8' }>();
  vi.mocked(transport.readFileContent).mockReturnValue(held.promise);
  const { result, rerender } = renderHook(() => {
    const save = useCanvasFileSave({ ...args, documentRecoveryBinding: observed });
    const recovery = useFileSaveRecovery(save.recovery, 'ready', observed);
    return { save, recovery };
  });
  await waitFor(() => expect(result.current.recovery.editBlocked).toBe(false));
  const identity = result.current.save.recovery.identity;
  let reading!: ReturnType<typeof result.current.recovery.inspectCurrent>;
  act(() => {
    reading = result.current.recovery.inspectCurrent();
  });
  await waitFor(() => expect(transport.readFileContent).toHaveBeenCalledTimes(1));
  live = false;
  await act(async () => {
    held.resolve({ content: 'must not be adopted', hash: 'c'.repeat(64), encoding: 'utf-8' });
    expect(await reading).toEqual({ status: 'idle' });
  });
  expect(result.current.recovery.editBlocked).toBe(true);
  expect(result.current.recovery.busy).toBe(false);
  port.discover.mockResolvedValue({ ...clear(), admission: 'blocked' });
  observed = { incarnation: { ...birth }, current: () => true };
  rerender();
  await waitFor(() => expect(port.discover).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.recovery.discovery?.admission).toBe('blocked'));
  expect(result.current.recovery.editBlocked).toBe(true);
  expect(result.current.save.recovery.identity).toBe(identity);
  expect(result.current.save.getConfirmedBase().content).toBe('base');
  // Only another explicit fresh server observation may clear this genuine blocker.
  port.discover.mockResolvedValue(clear());
  await act(async () => {
    await result.current.recovery.refresh();
  });
  expect(port.discover).toHaveBeenCalledTimes(3);
  expect(result.current.recovery.editBlocked).toBe(false);
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(port.recover).not.toHaveBeenCalled();
});

/** A new verified observation arrives while the old observation's discovery is still pending. */
async function pendingObservationHandoff(oldReply: 'clear' | 'reject') {
  let oldCurrent = true;
  let observed = { incarnation: birth, current: () => oldCurrent };
  const first = deferred<FileSaveDiscovery>();
  const second = deferred<FileSaveDiscovery>();
  port.discover.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook(() => {
    const save = useCanvasFileSave({ ...args, documentRecoveryBinding: observed });
    const recovery = useFileSaveRecovery(save.recovery, 'ready', observed);
    return { save, recovery };
  });
  await waitFor(() => expect(port.discover).toHaveBeenCalledTimes(1));
  const owner = result.current.save.recovery.identity;
  const oldRequest = result.current.save.recovery.discover();
  oldCurrent = false;
  observed = { incarnation: { ...birth }, current: () => true };
  rerender();
  // The replacement effect has subscribed BEFORE the old request settles.
  const replacementRequest = result.current.save.recovery.discover();
  expect(result.current.save.recovery.identity).toBe(owner);
  expect(result.current.recovery.editBlocked).toBe(true);
  // Preserve the original dispatch tail: no replacement HTTP runs ahead of the old one.
  expect(port.discover).toHaveBeenCalledTimes(1);
  await act(async () => {
    if (oldReply === 'clear') first.resolve(clear());
    else first.reject(new Error('old observation reply failed'));
    expect(await oldRequest).toEqual({ status: 'idle' });
  });
  await waitFor(() => expect(port.discover).toHaveBeenCalledTimes(2));
  expect(result.current.recovery.editBlocked).toBe(true);
  // Old idle-cache eviction must not evict the replacement's still-pending request.
  expect(result.current.save.recovery.discover()).toBe(replacementRequest);
  const fresh = oldReply === 'clear' ? { ...clear(), admission: 'blocked' as const } : clear();
  await act(async () => {
    second.resolve(fresh);
    expect(await replacementRequest).toEqual({ status: 'observed', value: fresh });
  });
  await waitFor(() => expect(result.current.recovery.discovery).toEqual(fresh));
  expect(result.current.recovery.editBlocked).toBe(oldReply === 'clear');
  expect(result.current.recovery.busy).toBe(false);
  expect(result.current.save.getConfirmedBase()).toEqual({ hash: null, content: 'base' });
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(transport.readFileContent).not.toHaveBeenCalled();
  expect(port.recover).not.toHaveBeenCalled();
  expect(port.discover).toHaveBeenCalledTimes(2);
}
it('new observation before old clear settlement needs its own discovery', async () => {
  await pendingObservationHandoff('clear');
});
it('new observation before old rejection is not poisoned by the old reply', async () => {
  await pendingObservationHandoff('reject');
});

it('a replacement read observation can stay blocked after an obsolete held inspection settles', async () => {
  let oldCurrent = true;
  let observation = { incarnation: birth, current: () => oldCurrent };
  const held = deferred<{ content: string; hash: string; encoding: 'utf-8' }>();
  vi.mocked(transport.readFileContent).mockReturnValue(held.promise);
  const { result, rerender } = renderHook(() => {
    const save = useCanvasFileSave({ ...args, documentRecoveryBinding: observation });
    const recovery = useFileSaveRecovery(save.recovery, 'ready', observation);
    return { save, recovery };
  });
  await waitFor(() => expect(result.current.recovery.editBlocked).toBe(false));
  const identity = result.current.save.recovery.identity;
  let inspection!: ReturnType<typeof result.current.recovery.inspectCurrent>;
  act(() => {
    inspection = result.current.recovery.inspectCurrent();
  });
  await waitFor(() => expect(transport.readFileContent).toHaveBeenCalledTimes(1));
  oldCurrent = false;
  observation = { incarnation: { ...birth }, current: () => true };
  port.discover.mockResolvedValue({ ...clear(), admission: 'blocked' });
  rerender();
  try {
    await waitFor(() => expect(port.discover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.recovery.discovery?.admission).toBe('blocked'));
    expect(result.current.save.recovery.identity).toBe(identity);
  } finally {
    await act(async () => {
      held.resolve({ content: 'stale bytes', hash: 'c'.repeat(64), encoding: 'utf-8' });
      expect(await inspection).toEqual({ status: 'idle' });
    });
  }
  expect(result.current.recovery.discovery?.admission).toBe('blocked');
  expect(result.current.recovery.editBlocked).toBe(true);
  expect(result.current.recovery.phase).toBe('ready');
  expect(result.current.save.getConfirmedBase()).toEqual({ content: 'base', hash: null });
  expect(transport.writeFile).not.toHaveBeenCalled();
  expect(port.recover).not.toHaveBeenCalled();
});

it('read-only inspection still waits for the already dispatched conditional write', async () => {
  const wire = deferred<WriteFileResult>();
  vi.mocked(transport.writeFile).mockReturnValue(wire.promise);
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'first',
    hash: 'b'.repeat(64),
    encoding: 'utf-8',
  });
  const { result } = renderHook(() =>
    useCanvasFileSave({ ...args, documentSaveBinding: undefined })
  );
  await act(async () => {
    await result.current.recovery.discover();
  });
  let saving!: ReturnType<typeof result.current.save>;
  act(() => {
    saving = result.current.save('first');
  });
  await waitFor(() => expect(transport.writeFile).toHaveBeenCalledTimes(1));
  let inspecting!: ReturnType<typeof result.current.recovery.inspectCurrent>;
  act(() => {
    inspecting = result.current.recovery.inspectCurrent();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(transport.readFileContent).not.toHaveBeenCalled();
  await act(async () => {
    wire.resolve({ ok: true, hash: 'b'.repeat(64), effect: 'changed' });
    await saving;
    expect(await inspecting).toEqual({
      status: 'observed',
      value: { content: 'first', hash: 'b'.repeat(64) },
    });
  });
  expect(transport.readFileContent).toHaveBeenCalledExactlyOnceWith('/work', 'notes.txt');
  expect(transport.writeFile).toHaveBeenCalledTimes(1);
  expect(result.current.getConfirmedBase()).toEqual({ content: 'first', hash: 'b'.repeat(64) });
});
