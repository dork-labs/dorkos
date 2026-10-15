/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const writeFile = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useTransport: () => ({ writeFile }),
}));

import { useCanvasFileSave } from '../model/use-canvas-file-save';

const ARGS = { sourcePath: 'doc.md', cwd: '/work', loadedContent: 'orig\n' };

describe('useCanvasFileSave', () => {
  beforeEach(() => {
    // Reset (not just clear) so a prior test's default/once-queue can't leak.
    writeFile.mockReset();
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

it('advances ordinary autosave only from a separately confirmed native marker and refuses an outstanding save', async () => {
  writeFile.mockResolvedValue({ ok: true, hash: 'after-full-save', effect: 'changed' });
  const { result } = renderHook(() => useCanvasFileSave(ARGS));
  await act(async () => {
    expect(
      result.current.adoptConfirmedCheckbox('foreign', { content: 'native', hash: 'native-hash' })
    ).toBe(false);
    expect(
      result.current.adoptConfirmedCheckbox('orig\n', { content: 'native', hash: 'native-hash' })
    ).toBe(true);
  });
  await act(async () => {
    await result.current.save('ordinary draft');
  });
  expect(writeFile).toHaveBeenCalledWith('/work', 'doc.md', 'ordinary draft', {
    expectedHash: 'native-hash',
  });
  let release!: (value: unknown) => void;
  writeFile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  let held!: ReturnType<typeof result.current.save>;
  await act(async () => {
    held = result.current.save('held draft');
    await Promise.resolve();
  });
  expect(result.current.canWriteCheckbox('ordinary draft')).toBe(false);
  expect(
    result.current.adoptConfirmedCheckbox('ordinary draft', {
      content: 'another native',
      hash: 'another-hash',
    })
  ).toBe(false);
  await act(async () => {
    release({ ok: true, hash: 'held-hash', effect: 'changed' });
    await held;
  });
});
