/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createElement,
  StrictMode,
  Suspense,
  startTransition,
  useLayoutEffect,
  useState,
} from 'react';
import { render, screen, renderHook, act } from '@testing-library/react';

const writeFile = vi.fn();
const transport = { writeFile };
let currentTransport = transport;
vi.mock('@/layers/shared/model', () => ({
  useTransport: () => currentTransport,
}));

import { useCanvasFileSave } from '../model/use-canvas-file-save';

const ARGS = { sourcePath: 'doc.md', cwd: '/work', loadedContent: 'orig\n' };

describe('useCanvasFileSave', () => {
  beforeEach(() => {
    // Reset (not just clear) so a prior test's default/once-queue can't leak.
    writeFile.mockReset();
    currentTransport = transport;
  });

  it('is not savable without a sourcePath or a cwd', () => {
    const a = renderHook(() => useCanvasFileSave({ ...ARGS, sourcePath: undefined }));
    expect(a.result.current.canSave).toBe(false);
    const b = renderHook(() => useCanvasFileSave({ ...ARGS, cwd: null }));
    expect(b.result.current.canSave).toBe(false);
  });

  it('conditions the first save on the baseline content (server hashes it, no client crypto)', async () => {
    writeFile.mockResolvedValue({ ok: true, hash: 'server1', effect: 'changed' });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));

    await act(async () => {
      expect(await result.current.save('new body\n')).toEqual({
        status: 'changed',
        confirmed: { hash: 'server1', content: 'new body\n' },
      });
    });

    expect(writeFile).toHaveBeenCalledWith('/work', 'doc.md', 'new body\n', {
      expectedContent: 'orig\n',
    });
    expect(result.current.status).toBe('saved');
  });

  it('conditions later saves on the server-confirmed hash', async () => {
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server1', effect: 'changed' });
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server2', effect: 'changed' });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));

    await act(async () => {
      await result.current.save('first\n');
    });
    await act(async () => {
      await result.current.save('second\n');
    });

    expect(writeFile).toHaveBeenLastCalledWith('/work', 'doc.md', 'second\n', {
      expectedHash: 'server1',
    });
  });

  it('serializes overlapping saves so the second sees the first’s confirmed hash', async () => {
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server1', effect: 'changed' });
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server2', effect: 'changed' });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));

    await act(async () => {
      // Fired back-to-back without awaiting the first.
      await Promise.all([result.current.save('first\n'), result.current.save('second\n')]);
    });

    // If they raced, the second would still send expectedContent. Serialized, it
    // sends the hash the first save confirmed — proving the in-flight chain.
    expect(writeFile).toHaveBeenNthCalledWith(1, '/work', 'doc.md', 'first\n', {
      expectedContent: 'orig\n',
    });
    expect(writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'second\n', {
      expectedHash: 'server1',
    });
  });

  it('asks the server to confirm unchanged content and returns its no-op hash', async () => {
    writeFile.mockResolvedValue({ ok: true, hash: 'current', effect: 'no_op' });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));
    expect(result.current.getConfirmedBase().hash).toBeNull();
    await act(async () => {
      expect(await result.current.save('orig\n')).toEqual({
        status: 'no_op',
        confirmed: { hash: 'current', content: 'orig\n' },
      });
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith('/work', 'doc.md', 'orig\n', {
      expectedContent: 'orig\n',
    });
    expect(result.current.getConfirmedBase()).toEqual({ hash: 'current', content: 'orig\n' });
    expect(result.current.status).toBe('saved');
  });

  it('surfaces a conflict and lets the caller overwrite or adopt the disk version', async () => {
    writeFile.mockResolvedValueOnce({
      ok: false,
      conflict: { currentHash: 'h9', currentContent: 'disk\n' },
    });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));

    await act(async () => {
      await result.current.save('mine\n');
    });
    expect(result.current.status).toBe('conflict');
    expect(result.current.conflict).toEqual({ currentHash: 'h9', currentContent: 'disk\n' });

    // Overwrite re-sends conditioned on the conflict's current hash.
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'h10', effect: 'changed' });
    await act(async () => {
      expect(await result.current.overwrite('mine\n')).toEqual({
        status: 'changed',
        confirmed: { hash: 'h10', content: 'mine\n' },
      });
    });
    expect(writeFile).toHaveBeenLastCalledWith('/work', 'doc.md', 'mine\n', { expectedHash: 'h9' });
    expect(result.current.status).toBe('saved');
  });

  it('adoptDisk returns the disk content and clears the conflict', async () => {
    writeFile.mockResolvedValueOnce({
      ok: false,
      conflict: { currentHash: 'h9', currentContent: 'disk\n' },
    });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));
    await act(async () => {
      await result.current.save('mine\n');
    });

    let adopted: string | null = null;
    act(() => {
      adopted = result.current.adoptDisk();
    });
    expect(adopted).toBe('disk\n');
    expect(result.current.conflict).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('reports an error status when the write throws', async () => {
    writeFile.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useCanvasFileSave(ARGS));
    await act(async () => {
      expect(await result.current.save('boom\n')).toEqual({ status: 'error' });
    });
    expect(result.current.status).toBe('error');
  });

  it('does not hide an external conflict behind equal local bytes', async () => {
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'old', effect: 'no_op' });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));
    await act(async () => {
      await result.current.save('orig\n');
    });
    writeFile.mockResolvedValueOnce({
      ok: false,
      conflict: { currentHash: 'new', currentContent: 'external' },
    });
    await act(async () => {
      expect(await result.current.save('orig\n')).toEqual({ status: 'conflict' });
    });
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenLastCalledWith('/work', 'doc.md', 'orig\n', {
      expectedHash: 'old',
    });
    expect(result.current.getConfirmedBase()).toEqual({ hash: 'old', content: 'orig\n' });
  });

  it('sends both equal queued saves and conditions the second on the first acknowledgement', async () => {
    let acknowledge!: (value: { ok: true; hash: string; effect: 'no_op' }) => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    writeFile.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    });
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'second-hash', effect: 'no_op' });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));
    await act(async () => {
      const first = result.current.save('orig\n');
      const second = result.current.save('orig\n');
      await firstStarted;
      expect(writeFile).toHaveBeenCalledTimes(1);
      acknowledge({ ok: true, hash: 'first-hash', effect: 'no_op' });
      expect(await first).toEqual({
        status: 'no_op',
        confirmed: { hash: 'first-hash', content: 'orig\n' },
      });
      expect(await second).toEqual({
        status: 'no_op',
        confirmed: { hash: 'second-hash', content: 'orig\n' },
      });
    });
    expect(writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'orig\n', {
      expectedHash: 'first-hash',
    });
  });

  it.each(['error', 'conflict'] as const)(
    'continues after a queued %s without advancing the base',
    async (failure) => {
      if (failure === 'error') writeFile.mockRejectedValueOnce(new Error('lost acknowledgement'));
      else
        writeFile.mockResolvedValueOnce({
          ok: false,
          conflict: { currentHash: 'disk', currentContent: 'external' },
        });
      writeFile.mockResolvedValueOnce({ ok: true, hash: 'next', effect: 'changed' });
      const { result } = renderHook(() => useCanvasFileSave(ARGS));
      await act(async () => {
        const first = result.current.save('first');
        const second = result.current.save('second');
        expect(await first).toEqual({ status: failure });
        expect(await second).toEqual({
          status: 'changed',
          confirmed: { hash: 'next', content: 'second' },
        });
      });
      expect(writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'second', {
        expectedContent: 'orig\n',
      });
    }
  );

  it('returns idle without requests for non-savable saves and overwrites without conflict', async () => {
    const missing = renderHook(() => useCanvasFileSave({ ...ARGS, cwd: null }));
    const noPath = renderHook(() => useCanvasFileSave({ ...ARGS, sourcePath: undefined }));
    const normal = renderHook(() => useCanvasFileSave(ARGS));
    await act(async () => {
      expect(await missing.result.current.save('body')).toEqual({ status: 'idle' });
      expect(await missing.result.current.overwrite('body')).toEqual({ status: 'idle' });
      expect(await noPath.result.current.save('body')).toEqual({ status: 'idle' });
      expect(await noPath.result.current.overwrite('body')).toEqual({ status: 'idle' });
      expect(await normal.result.current.overwrite('body')).toEqual({ status: 'idle' });
    });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each(['changed', 'no_op', 'conflict', 'error'] as const)(
    'returns an overwrite %s settlement using the conflict hash',
    async (outcome) => {
      writeFile.mockResolvedValueOnce({
        ok: false,
        conflict: { currentHash: 'conflict-hash', currentContent: 'disk' },
      });
      const { result } = renderHook(() => useCanvasFileSave(ARGS));
      await act(async () => {
        await result.current.save('mine');
      });
      if (outcome === 'error') writeFile.mockRejectedValueOnce(new Error('lost response'));
      else if (outcome === 'conflict')
        writeFile.mockResolvedValueOnce({
          ok: false,
          conflict: { currentHash: 'newer', currentContent: 'newer disk' },
        });
      else writeFile.mockResolvedValueOnce({ ok: true, hash: 'ack-hash', effect: outcome });
      await act(async () => {
        expect(await result.current.overwrite('mine')).toEqual(
          outcome === 'changed' || outcome === 'no_op'
            ? { status: outcome, confirmed: { hash: 'ack-hash', content: 'mine' } }
            : { status: outcome }
        );
      });
      expect(writeFile).toHaveBeenLastCalledWith('/work', 'doc.md', 'mine', {
        expectedHash: 'conflict-hash',
      });
      expect(result.current.getConfirmedBase()).toEqual(
        outcome === 'changed' || outcome === 'no_op'
          ? { hash: 'ack-hash', content: 'mine' }
          : { hash: null, content: 'orig\n' }
      );
    }
  );

  it.each([
    { ok: true, hash: '', effect: 'changed' },
    { ok: true, hash: 'invalid', effect: 'saved' },
  ])('does not advance the base on invalid acknowledgement %j', async (ack) => {
    writeFile.mockResolvedValueOnce(ack);
    const { result } = renderHook(() => useCanvasFileSave(ARGS));
    await act(async () => {
      expect(await result.current.save('mine')).toEqual({ status: 'error' });
    });
    expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'orig\n' });
  });
});

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

describe('save ownership across document lifecycles', () => {
  beforeEach(() => {
    writeFile.mockReset();
    currentTransport = transport;
  });

  it.each([
    { sourcePath: 'other.md' },
    { cwd: '/other-work' },
    { documentId: 'next-incarnation' },
  ] as Array<Partial<typeof ARGS & { documentId: string }>>)(
    'retires queued and inflight work when ownership changes by %j',
    async (changed) => {
      const pending = pendingWrite();
      writeFile.mockImplementationOnce(pending.start);
      writeFile.mockResolvedValueOnce({ ok: true, hash: 'new-owner', effect: 'changed' });
      const original = { ...ARGS, documentId: 'original-incarnation' };
      const { result, rerender } = renderHook((props) => useCanvasFileSave(props), {
        initialProps: original,
      });
      const oldSave = result.current.save;
      let first!: ReturnType<typeof oldSave>;
      let queued!: ReturnType<typeof oldSave>;
      await act(async () => {
        first = oldSave('old inflight');
        queued = oldSave('old queued');
        await pending.started;
      });
      expect(writeFile).toHaveBeenCalledTimes(1);
      rerender({ ...original, ...changed, loadedContent: 'new base' });
      expect(result.current.status).toBe('idle');
      expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'new base' });
      await act(async () => {
        const newSave = result.current.save('new draft');
        await Promise.resolve();
        expect(writeFile).toHaveBeenCalledTimes(1);
        pending.resolve({ ok: true, hash: 'old-owner', effect: 'changed' });
        expect(await first).toEqual({ status: 'idle' });
        expect(await queued).toEqual({ status: 'idle' });
        expect(await newSave).toEqual({
          status: 'changed',
          confirmed: { hash: 'new-owner', content: 'new draft' },
        });
        expect(await oldSave('stale callback')).toEqual({ status: 'idle' });
      });
      expect(writeFile).toHaveBeenCalledTimes(2);
      expect(writeFile).toHaveBeenLastCalledWith(
        changed.cwd ?? original.cwd,
        changed.sourcePath ?? original.sourcePath,
        'new draft',
        { expectedContent: 'new base' }
      );
      expect(result.current.status).toBe('saved');
      expect(result.current.getConfirmedBase()).toEqual({
        hash: 'new-owner',
        content: 'new draft',
      });
    }
  );

  it.each(['changed', 'no_op', 'conflict', 'error'] as const)(
    'ignores a retired owner late %s result without changing the current base or status',
    async (outcome) => {
      const pending = pendingWrite();
      writeFile.mockImplementationOnce(pending.start);
      const { result, rerender } = renderHook((props) => useCanvasFileSave(props), {
        initialProps: { ...ARGS, documentId: 'first' },
      });
      let saving!: ReturnType<typeof result.current.save>;
      await act(async () => {
        saving = result.current.save('old draft');
        await pending.started;
      });
      expect(writeFile).toHaveBeenCalledTimes(1);
      rerender({ ...ARGS, documentId: 'second', loadedContent: 'second base' });
      await act(async () => {
        if (outcome === 'error') pending.reject(new Error('late failure'));
        else if (outcome === 'conflict')
          pending.resolve({
            ok: false,
            conflict: { currentHash: 'external', currentContent: 'external bytes' },
          });
        else pending.resolve({ ok: true, hash: 'old-hash', effect: outcome });
        expect(await saving).toEqual({ status: 'idle' });
      });
      expect(result.current.status).toBe('idle');
      expect(result.current.conflict).toBeNull();
      expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'second base' });
    }
  );

  it('does not resurrect an old incarnation when the same document identity returns', async () => {
    const pending = pendingWrite();
    writeFile.mockImplementationOnce(pending.start);
    const first = { ...ARGS, documentId: 'same-id' };
    const { result, rerender } = renderHook((props) => useCanvasFileSave(props), {
      initialProps: first,
    });
    let saving!: ReturnType<typeof result.current.save>;
    await act(async () => {
      saving = result.current.save('old draft');
      await pending.started;
    });
    rerender({ ...first, documentId: 'intervening' });
    rerender({ ...first, loadedContent: 'reopened base' });
    await act(async () => {
      pending.resolve({ ok: true, hash: 'retired', effect: 'changed' });
      expect(await saving).toEqual({ status: 'idle' });
    });
    expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'reopened base' });
    expect(result.current.status).toBe('idle');
  });

  it('does not send queued work after unmount or publish an inflight completion', async () => {
    const pending = pendingWrite();
    writeFile.mockImplementationOnce(pending.start);
    const { result, unmount } = renderHook(() => useCanvasFileSave(ARGS));
    const save = result.current.save;
    let first!: ReturnType<typeof save>;
    let queued!: ReturnType<typeof save>;
    await act(async () => {
      first = save('inflight');
      queued = save('queued');
      await pending.started;
    });
    unmount();
    pending.resolve({ ok: true, hash: 'late', effect: 'changed' });
    expect(await first).toEqual({ status: 'idle' });
    expect(await queued).toEqual({ status: 'idle' });
    expect(await save('after unmount')).toEqual({ status: 'idle' });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmed base when only display content changes for the same owner', async () => {
    writeFile.mockResolvedValue({ ok: true, hash: 'confirmed', effect: 'changed' });
    const { result, rerender } = renderHook((props) => useCanvasFileSave(props), {
      initialProps: ARGS,
    });
    await act(async () => {
      await result.current.save('confirmed bytes');
    });
    rerender({ ...ARGS, loadedContent: 'unrelated display update' });
    expect(result.current.getConfirmedBase()).toEqual({
      hash: 'confirmed',
      content: 'confirmed bytes',
    });
    expect(result.current.status).toBe('saved');
  });
});

it('keeps the committed owner alive when a transition to another document suspends and is abandoned', async () => {
  writeFile.mockReset();
  currentTransport = transport;
  let attemptedSwitch = false;
  const pending = pendingWrite();
  writeFile.mockImplementationOnce(pending.start);
  writeFile.mockResolvedValueOnce({ ok: true, hash: 'second-confirmed', effect: 'changed' });
  const suspended = new Promise<void>(() => {});
  let setDocument!: (id: string) => void;
  let committed!: ReturnType<typeof useCanvasFileSave>;
  function Editor({ id }: { id: string }) {
    const save = useCanvasFileSave({ ...ARGS, documentId: id });
    useLayoutEffect(() => {
      committed = save;
    });
    if (id === 'suspended') {
      attemptedSwitch = true;
      throw suspended;
    }
    return createElement('div', { 'data-testid': 'visible-document' }, id);
  }
  function Host() {
    const [id, setId] = useState('original');
    setDocument = setId;
    return createElement(Suspense, { fallback: 'loading' }, createElement(Editor, { id }));
  }
  render(createElement(Host));
  let first!: ReturnType<typeof committed.save>;
  let queued!: ReturnType<typeof committed.save>;
  await act(async () => {
    first = committed.save('first');
    queued = committed.save('second');
    await pending.started;
  });
  act(() => {
    startTransition(() => setDocument('suspended'));
  });
  expect(attemptedSwitch).toBe(true);
  expect(screen.getByTestId('visible-document').textContent).toBe('original');
  await act(async () => {
    pending.resolve({ ok: true, hash: 'first-confirmed', effect: 'changed' });
    expect(await first).toEqual({
      status: 'changed',
      confirmed: { hash: 'first-confirmed', content: 'first' },
    });
    expect(await queued).toEqual({
      status: 'changed',
      confirmed: { hash: 'second-confirmed', content: 'second' },
    });
  });
  act(() => {
    setDocument('original');
  });
  expect(committed.getConfirmedBase()).toEqual({ hash: 'second-confirmed', content: 'second' });
  expect(writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'second', {
    expectedHash: 'first-confirmed',
  });
});

it('retires the old transport but waits for its inflight request before sending through the replacement', async () => {
  writeFile.mockReset();
  currentTransport = transport;
  const pending = pendingWrite();
  writeFile.mockImplementationOnce(pending.start);
  const replacementWrite = vi
    .fn()
    .mockResolvedValue({ ok: true, hash: 'replacement', effect: 'changed' });
  const { result, rerender } = renderHook((props) => useCanvasFileSave(props), {
    initialProps: ARGS,
  });
  let original!: ReturnType<typeof result.current.save>;
  await act(async () => {
    original = result.current.save('old request');
    await pending.started;
  });
  currentTransport = { writeFile: replacementWrite };
  rerender({ ...ARGS, loadedContent: 'replacement base' });
  await act(async () => {
    const next = result.current.save('replacement draft');
    await Promise.resolve();
    expect(replacementWrite).not.toHaveBeenCalled();
    pending.resolve({ ok: true, hash: 'old', effect: 'changed' });
    expect(await original).toEqual({ status: 'idle' });
    expect(await next).toEqual({
      status: 'changed',
      confirmed: { hash: 'replacement', content: 'replacement draft' },
    });
  });
  expect(replacementWrite).toHaveBeenCalledWith('/work', 'doc.md', 'replacement draft', {
    expectedContent: 'replacement base',
  });
  expect(result.current.getConfirmedBase()).toEqual({
    hash: 'replacement',
    content: 'replacement draft',
  });
  currentTransport = transport;
});

it('reactivates its committed owner after StrictMode effect replay and retires it on unmount', async () => {
  writeFile.mockReset();
  currentTransport = transport;
  writeFile.mockResolvedValue({ ok: true, hash: 'strict', effect: 'changed' });
  const { result, unmount } = renderHook(() => useCanvasFileSave(ARGS), { wrapper: StrictMode });
  const save = result.current.save;
  await act(async () => {
    expect(await save('strict draft')).toEqual({
      status: 'changed',
      confirmed: { hash: 'strict', content: 'strict draft' },
    });
  });
  expect(result.current.status).toBe('saved');
  unmount();
  expect(await save('retired')).toEqual({ status: 'idle' });
  expect(writeFile).toHaveBeenCalledTimes(1);
});
