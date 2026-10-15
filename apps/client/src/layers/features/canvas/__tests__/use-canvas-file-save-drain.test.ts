/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const writeFile = vi.fn();
const transport = { writeFile };
let currentTransport = transport;
vi.mock('@/layers/shared/model', () => ({ useTransport: () => currentTransport }));
import { useCanvasFileSave } from '../model/use-canvas-file-save';
const ARGS = { sourcePath: 'doc.md', cwd: '/work', loadedContent: 'orig\n' };

function pendingWrite() {
  let started!: () => void;
  const startedPromise = new Promise<void>((done) => {
    started = done;
  });
  let resolve!: (value: unknown) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    resolve,
    reject,
    started: startedPromise,
    start: () => {
      started();
      return promise;
    },
  };
}

describe('explicit buffered unmount drain', () => {
  beforeEach(() => {
    writeFile.mockReset();
    currentTransport = transport;
  });

  it('only drains the latest prepared draft once and keeps ordinary retired saves idle', async () => {
    writeFile.mockResolvedValue({ ok: true, hash: 'drained', effect: 'changed' });
    const { result, unmount } = renderHook(() => useCanvasFileSave(ARGS));
    const stale = result.current.prepareFinalSave('stale')!;
    const latest = result.current.prepareFinalSave('latest')!;
    const ordinary = result.current.save;
    unmount();
    expect(await stale.flush()).toEqual({ status: 'idle' });
    expect(await ordinary('not authorized')).toEqual({ status: 'idle' });
    expect((await latest.flush()).status).toBe('changed');
    expect(await latest.flush()).toEqual({ status: 'idle' });
    expect(writeFile).toHaveBeenCalledExactlyOnceWith('/work', 'doc.md', 'latest', {
      expectedContent: 'orig\n',
    });
  });

  it('uses a valid late ACK as the private drain base without publishing its retired outcome', async () => {
    const pending = pendingWrite();
    writeFile.mockImplementationOnce(pending.start);
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'last', effect: 'changed' });
    const { result, unmount } = renderHook(() => useCanvasFileSave(ARGS));
    let original!: ReturnType<typeof result.current.save>;
    await act(async () => {
      original = result.current.save('first');
      await pending.started;
    });
    const final = result.current.prepareFinalSave('latest')!;
    // A second ordinary request has entered the queue, but has not dispatched.
    const queued = result.current.save('latest');
    unmount();
    pending.resolve({ ok: true, hash: 'first-ack', effect: 'changed' });
    expect(await original).toEqual({ status: 'idle' });
    const drained = final.flush();
    expect(await queued).toEqual({ status: 'idle' });
    expect((await drained).status).toBe('changed');
    expect(writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'latest', {
      expectedHash: 'first-ack',
    });
  });

  it('does not let an older queued admission consume a newer buffered draft permit', async () => {
    const pending = pendingWrite();
    writeFile.mockImplementationOnce(pending.start);
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'latest', effect: 'changed' });
    const { result, unmount } = renderHook(() => useCanvasFileSave(ARGS));
    result.current.prepareFinalSave('first');
    const first = result.current.save('first');
    // Prepare the latest draft BEFORE the first queue microtask dispatches.
    const final = result.current.prepareFinalSave('latest')!;
    const queued = result.current.save('latest');
    await pending.started;
    unmount();
    const drain = final.flush();
    pending.resolve({ ok: true, hash: 'first-ack', effect: 'changed' });
    expect(await first).toEqual({ status: 'idle' });
    expect(await queued).toEqual({ status: 'idle' });
    expect((await drain).status).toBe('changed');
    expect(writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'latest', {
      expectedHash: 'first-ack',
    });
  });

  it('does not consume a different buffered draft when an older content save is admitted later', async () => {
    const pending = pendingWrite();
    writeFile.mockImplementationOnce(pending.start);
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'latest', effect: 'changed' });
    const { result, unmount } = renderHook(() => useCanvasFileSave(ARGS));
    const final = result.current.prepareFinalSave('latest')!;
    const older = result.current.save('older');
    await pending.started;
    unmount();
    const drain = final.flush();
    pending.resolve({ ok: true, hash: 'older-ack', effect: 'changed' });
    expect(await older).toEqual({ status: 'idle' });
    expect((await drain).status).toBe('changed');
    expect(writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'latest', {
      expectedHash: 'older-ack',
    });
  });

  it('refuses a prepared handle after owner replacement without changing the new base', async () => {
    const { result, rerender } = renderHook((args) => useCanvasFileSave(args), {
      initialProps: ARGS,
    });
    const final = result.current.prepareFinalSave('old draft')!;
    rerender({ ...ARGS, sourcePath: 'other.md', loadedContent: 'other base' });
    expect(await final.flush()).toEqual({ status: 'idle' });
    expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'other base' });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('cancellation and an already-dispatched normal save prevent a duplicate drain', async () => {
    writeFile.mockResolvedValue({ ok: true, hash: 'saved', effect: 'changed' });
    const { result, unmount } = renderHook(() => useCanvasFileSave(ARGS));
    const cancelled = result.current.prepareFinalSave('discarded')!;
    cancelled.cancel();
    const final = result.current.prepareFinalSave('normal')!;
    await act(async () => {
      await result.current.save('normal');
    });
    unmount();
    expect(await cancelled.flush()).toEqual({ status: 'idle' });
    expect(await final.flush()).toEqual({ status: 'idle' });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
