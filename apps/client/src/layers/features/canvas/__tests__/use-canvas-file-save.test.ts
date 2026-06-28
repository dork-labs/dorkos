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
    writeFile.mockResolvedValue({ ok: true, hash: 'server1' });
    const { result } = renderHook(() => useCanvasFileSave(ARGS));

    await act(async () => {
      await result.current.save('new body\n');
    });

    expect(writeFile).toHaveBeenCalledWith('/work', 'doc.md', 'new body\n', {
      expectedContent: 'orig\n',
    });
    expect(result.current.status).toBe('saved');
  });

  it('conditions later saves on the server-confirmed hash', async () => {
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server1' });
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server2' });
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

  it("serializes overlapping saves so the second sees the first's confirmed hash", async () => {
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server1' });
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'server2' });
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

  it('skips the write when content is unchanged from the base', async () => {
    const { result } = renderHook(() => useCanvasFileSave(ARGS));
    await act(async () => {
      await result.current.save('orig\n');
    });
    expect(writeFile).not.toHaveBeenCalled();
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
    writeFile.mockResolvedValueOnce({ ok: true, hash: 'h10' });
    await act(async () => {
      await result.current.overwrite('mine\n');
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
      await result.current.save('boom\n');
    });
    expect(result.current.status).toBe('error');
  });
});
