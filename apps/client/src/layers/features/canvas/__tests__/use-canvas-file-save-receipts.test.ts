/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import type { WriteFileOptions, WriteFileResult } from '@dorkos/shared/transport';
const transport = createMockTransport();
let activeTransport = transport;
vi.mock('@/layers/shared/model', () => ({ useTransport: () => activeTransport }));
import { useCanvasFileSave } from '../model/use-canvas-file-save';
const birth = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
let current = true;
const binding = { incarnation: birth, current: () => current };
const args = {
  documentId: 'doc-1',
  sourcePath: 'doc.md',
  cwd: '/work',
  loadedContent: 'base',
  documentSaveBinding: binding,
};
function accepted(options: WriteFileOptions, hash = 'b'.repeat(64)): WriteFileResult {
  return {
    ok: true,
    hash,
    effect: 'changed',
    documentReceipt: { ...options.documentSave!, fileHash: hash, docSeq: 1, status: 'accepted' },
  };
}
beforeEach(() => {
  vi.mocked(transport.writeFile).mockReset();
  vi.mocked(transport.readFileContent).mockReset();
  current = true;
  activeTransport = transport;
});

it('exposes only a matching server receipt separately from the file acknowledgement', async () => {
  vi.mocked(transport.writeFile).mockImplementation(async (_cwd, _path, _content, options) =>
    accepted(options!)
  );
  const { result } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    expect((await result.current.save('draft')).status).toBe('changed');
  });
  expect(result.current.documentReceipt).toMatchObject({
    documentId: 'doc-1',
    incarnation: birth,
    status: 'accepted',
  });
  expect(result.current.getConfirmedBase()).toEqual({ hash: 'b'.repeat(64), content: 'draft' });
});

it('blocks newer drafts after a lost response and retries the exact original operation', async () => {
  vi.mocked(transport.writeFile).mockRejectedValueOnce(new TypeError('lost response'));
  const { result } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    expect(await result.current.save('first')).toEqual({ status: 'uncertain' });
  });
  const original = vi.mocked(transport.writeFile).mock.calls[0]!;
  await act(async () => {
    expect(await result.current.save('newer')).toEqual({ status: 'uncertain' });
  });
  expect(transport.writeFile).toHaveBeenCalledTimes(1);
  vi.mocked(transport.writeFile).mockImplementationOnce(async (_cwd, _path, _content, options) =>
    accepted(options!)
  );
  await act(async () => {
    expect((await result.current.retryUnconfirmed()).status).toBe('changed');
  });
  expect(vi.mocked(transport.writeFile).mock.calls[1]).toEqual(original);
  expect(result.current.getConfirmedBase().content).toBe('first');
});

it('keeps the base and draft unconfirmed when a duplicate receipt is historical', async () => {
  vi.mocked(transport.writeFile).mockImplementation(async (_cwd, _path, _content, options) => {
    const response = accepted(options!);
    if (!response.ok) throw new Error('fixture');
    return {
      ...response,
      effect: 'no_op',
      documentReceipt: { ...response.documentReceipt!, status: 'duplicate' },
    };
  });
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'external',
    hash: 'c'.repeat(64),
    encoding: 'utf-8',
  });
  const { result } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    expect(await result.current.save('draft')).toEqual({ status: 'conflict' });
  });
  expect(result.current.status).toBe('conflict');
  expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'base' });
  expect(result.current.documentReceipt).toBeUndefined();
});

it('keeps a late receipt attached to its retired owner rather than a replacement incarnation', async () => {
  let resolve!: (result: WriteFileResult) => void;
  let options!: WriteFileOptions;
  let started!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  vi.mocked(transport.writeFile).mockImplementationOnce(async (_cwd, _path, _content, original) => {
    options = original!;
    started();
    return new Promise((done) => {
      resolve = done;
    });
  });
  const { result, rerender } = renderHook((value) => useCanvasFileSave(value), {
    initialProps: args,
  });
  let pending!: ReturnType<typeof result.current.save>;
  await act(async () => {
    pending = result.current.save('old');
    await began;
  });
  rerender({
    ...args,
    loadedContent: 'new base',
    documentSaveBinding: {
      incarnation: { ...birth, generation: 'c'.repeat(64) },
      current: () => true,
    },
  });
  await act(async () => {
    resolve(accepted(options));
    expect(await pending).toEqual({ status: 'idle' });
  });
  expect(result.current.documentReceipt).toBeUndefined();
  expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'new base' });
});

it('the prepared unmount drain retains its birth and uses the prior private ACK as baseline', async () => {
  let resolve!: (result: WriteFileResult) => void;
  let first!: WriteFileOptions;
  let started!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  vi.mocked(transport.writeFile)
    .mockImplementationOnce(async (_cwd, _path, _content, options) => {
      first = options!;
      started();
      return new Promise((done) => {
        resolve = done;
      });
    })
    .mockImplementationOnce(async (_cwd, _path, _content, options) =>
      accepted(options!, 'c'.repeat(64))
    );
  const { result, unmount } = renderHook(() => useCanvasFileSave(args));
  let original!: ReturnType<typeof result.current.save>;
  await act(async () => {
    original = result.current.save('first');
    await began;
  });
  const final = result.current.prepareFinalSave('final')!;
  current = false;
  unmount();
  const drain = final.flush();
  resolve(accepted(first));
  expect(await original).toEqual({ status: 'idle' });
  expect((await drain).status).toBe('changed');
  expect(transport.writeFile).toHaveBeenNthCalledWith(2, '/work', 'doc.md', 'final', {
    expectedHash: 'b'.repeat(64),
    documentSave: { documentId: 'doc-1', incarnation: birth, eventId: expect.any(String) },
  });
  expect(vi.mocked(transport.writeFile).mock.calls[1]![3]!.documentSave!.eventId).not.toBe(
    first.documentSave!.eventId
  );
});

it('an unconfirmed old request prevents final drain from minting a newer operation', async () => {
  vi.mocked(transport.writeFile).mockRejectedValue(new TypeError('lost response'));
  const { result, unmount } = renderHook(() => useCanvasFileSave(args));
  await act(async () => {
    await result.current.save('first');
  });
  const final = result.current.prepareFinalSave('newer')!;
  current = false;
  unmount();
  expect(await final.flush()).toEqual({ status: 'error' });
  expect(transport.writeFile).toHaveBeenCalledTimes(1);
});

it('a duplicate current-file read cannot publish after the live document observation retires', async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  vi.mocked(transport.writeFile).mockImplementation(async (_cwd, _path, _content, options) => {
    const response = accepted(options!);
    if (!response.ok) throw new Error('fixture');
    return {
      ...response,
      effect: 'no_op',
      documentReceipt: { ...response.documentReceipt!, status: 'duplicate' },
    };
  });
  vi.mocked(transport.readFileContent).mockImplementation(() => {
    started();
    return new Promise((done) => {
      release = () => done({ content: 'draft', hash: 'b'.repeat(64), encoding: 'utf-8' });
    });
  });
  const { result } = renderHook(() => useCanvasFileSave(args));
  let pending!: ReturnType<typeof result.current.save>;
  await act(async () => {
    pending = result.current.save('draft');
    await began;
  });
  current = false;
  await act(async () => {
    release();
    expect(await pending).toEqual({ status: 'idle' });
  });
  expect(result.current.documentReceipt).toBeUndefined();
});

it.each(['transport', 'path', 'cwd'] as const)(
  'does not retry an old same-birth request under a replacement %s owner',
  async (changed) => {
    vi.mocked(transport.writeFile).mockRejectedValueOnce(new TypeError('lost response'));
    const replacement = createMockTransport();
    const { result, rerender } = renderHook((value) => useCanvasFileSave(value), {
      initialProps: args,
    });
    await act(async () => {
      expect(await result.current.save('old draft')).toEqual({ status: 'uncertain' });
    });
    if (changed === 'transport') activeTransport = replacement;
    rerender({
      ...args,
      loadedContent: 'replacement base',
      ...(changed === 'path' ? { sourcePath: 'other.md' } : {}),
      ...(changed === 'cwd' ? { cwd: '/other' } : {}),
    });
    await act(async () => {
      expect(await result.current.retryUnconfirmed()).toEqual({ status: 'idle' });
    });
    await act(async () => {
      expect(await result.current.save('new draft')).toEqual({ status: 'uncertain' });
    });
    expect(transport.writeFile).toHaveBeenCalledTimes(1);
    expect(replacement.writeFile).not.toHaveBeenCalled();
    expect(result.current.getConfirmedBase()).toEqual({ hash: null, content: 'replacement base' });
    expect(result.current.documentReceipt).toBeUndefined();
  }
);
