import { beforeEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { WriteFileOptions, WriteFileResult } from '@dorkos/shared/transport';
import {
  FileReceiptOperation,
  RetiredFileSaveError,
  UnconfirmedFileSaveError,
} from '../model/file-save/receipt-operation';
const birth = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
const binding = { incarnation: birth, current: () => true };
const hash = 'b'.repeat(64);
function response(options: WriteFileOptions, status: 'accepted' | 'duplicate' = 'accepted') {
  return {
    ok: true as const,
    hash,
    effect: status === 'accepted' ? ('changed' as const) : ('no_op' as const),
    documentReceipt: { ...options.documentSave!, fileHash: hash, docSeq: 4, status },
  };
}
let transport: ReturnType<typeof createMockTransport>;
beforeEach(() => {
  transport = createMockTransport();
});

it('retains the exact original UUID, body, base and birth through unknown response and explicit retry', async () => {
  const lane = new FileReceiptOperation();
  vi.mocked(transport.writeFile).mockRejectedValueOnce(new TypeError('connection lost'));
  await expect(
    lane.write(transport, '/work', 'a.md', 'original draft', { expectedContent: 'base' }, binding)
  ).rejects.toThrow();
  const original = vi.mocked(transport.writeFile).mock.calls[0]!;
  expect(original[3]!.documentSave).toMatchObject({ documentId: 'doc-1', incarnation: birth });
  expect(original[3]!.documentSave!.eventId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
  );
  await expect(
    lane.write(transport, '/work', 'a.md', 'newer draft', { expectedHash: 'different' }, binding)
  ).rejects.toBeInstanceOf(UnconfirmedFileSaveError);
  vi.mocked(transport.writeFile).mockImplementationOnce(async (_cwd, _path, _content, options) =>
    response(options!, 'duplicate')
  );
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'original draft',
    hash,
    encoding: 'utf-8',
  });
  expect((await lane.retry(transport, binding)).content).toBe('original draft');
  expect(vi.mocked(transport.writeFile).mock.calls[1]).toEqual(original);
  expect(lane.pending).toBe(false);
  expect(lane.receipt?.status).toBe('duplicate');
});

it('does not present a historical duplicate as the current file after another writer changed it', async () => {
  const lane = new FileReceiptOperation();
  vi.mocked(transport.writeFile).mockImplementation(async (_cwd, _path, _content, options) =>
    response(options!, 'duplicate')
  );
  vi.mocked(transport.readFileContent).mockResolvedValue({
    content: 'external bytes',
    hash: 'c'.repeat(64),
    encoding: 'utf-8',
  });
  expect(
    await lane.write(transport, '/work', 'a.md', 'draft', { expectedContent: 'base' }, binding)
  ).toEqual({
    ok: false,
    conflict: { currentHash: 'c'.repeat(64), currentContent: 'external bytes' },
  });
  expect(lane.pending).toBe(false);
  expect(lane.receipt?.status).toBe('duplicate');
});

it.each(['document', 'event', 'birth', 'hash', 'sequence', 'effect'])(
  'rejects mismatched %s receipt evidence without releasing uncertainty',
  async (field) => {
    const lane = new FileReceiptOperation();
    vi.mocked(transport.writeFile).mockImplementation(async (_cwd, _path, _content, options) => {
      const result = response(options!);
      if (field === 'document') result.documentReceipt.documentId = 'foreign';
      if (field === 'event')
        result.documentReceipt.eventId = '10000000-0000-4000-8000-000000000001';
      if (field === 'birth')
        result.documentReceipt.incarnation = { ...birth, generation: 'c'.repeat(64) };
      if (field === 'hash') result.documentReceipt.fileHash = 'c'.repeat(64);
      if (field === 'sequence') result.documentReceipt.docSeq = 0;
      if (field === 'effect') result.effect = 'no_op';
      return result;
    });
    await expect(
      lane.write(transport, '/work', 'a.md', 'draft', { expectedContent: 'base' }, binding)
    ).rejects.toThrow();
    expect(lane.pending).toBe(true);
  }
);

it('keeps a generic 404 uncertain because server currentness checks may follow the file effect', async () => {
  const lane = new FileReceiptOperation();
  vi.mocked(transport.writeFile).mockRejectedValue(
    Object.assign(new Error('closed after rename'), {
      status: 404,
      code: 'CANVAS_DOCUMENT_NOT_FOUND',
    })
  );
  await expect(
    lane.write(transport, '/work', 'a.md', 'draft', { expectedContent: 'base' }, binding)
  ).rejects.toThrow();
  expect(lane.pending).toBe(true);
});

it('clears an explicit durable pre-effect failure and never claims its receipt', async () => {
  const lane = new FileReceiptOperation();
  vi.mocked(transport.writeFile).mockRejectedValue(
    Object.assign(new Error('failed before effect'), { status: 412, code: 'DOC_SAVE_FAILED' })
  );
  await expect(
    lane.write(transport, '/work', 'a.md', 'draft', { expectedContent: 'base' }, binding)
  ).rejects.toThrow();
  expect(lane.pending).toBe(false);
  expect(lane.receipt).toBeUndefined();
});

it('a storage no-op has no document receipt', async () => {
  const lane = new FileReceiptOperation();
  vi.mocked(transport.writeFile).mockResolvedValue({ ok: true, hash, effect: 'no_op' });
  await lane.write(transport, '/work', 'a.md', 'base', { expectedContent: 'base' }, binding);
  expect(lane.pending).toBe(false);
  expect(lane.receipt).toBeUndefined();
});

it('ordinary requests cannot start from a retired binding', async () => {
  const lane = new FileReceiptOperation();
  await expect(
    lane.write(
      transport,
      '/work',
      'a.md',
      'draft',
      { expectedContent: 'base' },
      { ...binding, current: () => false }
    )
  ).rejects.toBeInstanceOf(RetiredFileSaveError);
  expect(transport.writeFile).not.toHaveBeenCalled();
});

it.each([
  undefined,
  null,
  {},
  { ok: false },
  { ok: false, conflict: {} },
  { ok: false, conflict: { currentHash: '', currentContent: 'external' } },
  { ok: true, hash, effect: 'changed' },
  { ok: true, hash, effect: 'no_op', documentReceipt: null },
])(
  'keeps missing, malformed or unsupported transport acknowledgement uncertain: %j',
  async (answer) => {
    const lane = new FileReceiptOperation();
    vi.mocked(transport.writeFile).mockResolvedValue(answer as WriteFileResult);
    await expect(
      lane.write(transport, '/work', 'a.md', 'draft', { expectedContent: 'base' }, binding)
    ).rejects.toThrow();
    expect(lane.pending).toBe(true);
    expect(lane.receipt).toBeUndefined();
    await expect(
      lane.write(transport, '/work', 'a.md', 'newer', { expectedContent: 'base' }, binding)
    ).rejects.toBeInstanceOf(UnconfirmedFileSaveError);
    expect(transport.writeFile).toHaveBeenCalledTimes(1);
  }
);

it('mints original operation IDs without secure-context randomUUID or subtle APIs', async () => {
  const originalCrypto = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
  try {
    const lane = new FileReceiptOperation();
    vi.mocked(transport.writeFile).mockImplementation(async (_cwd, _path, _content, options) =>
      response(options!)
    );
    await lane.write(transport, '/work', 'a.md', 'draft', { expectedContent: 'base' }, binding);
    expect(vi.mocked(transport.writeFile).mock.calls[0]![3]!.documentSave!.eventId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
    );
    expect(lane.pending).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([undefined, null, {}, { content: 'draft', hash: '' }, { content: 123, hash }])(
  'keeps a duplicate uncertain when current-file read metadata is malformed: %j',
  async (answer) => {
    const lane = new FileReceiptOperation();
    vi.mocked(transport.writeFile).mockImplementation(async (_cwd, _path, _content, options) =>
      response(options!, 'duplicate')
    );
    vi.mocked(transport.readFileContent).mockResolvedValue(
      answer as Awaited<ReturnType<typeof transport.readFileContent>>
    );
    await expect(
      lane.write(transport, '/work', 'a.md', 'draft', { expectedContent: 'base' }, binding)
    ).rejects.toThrow();
    expect(lane.pending).toBe(true);
    expect(lane.receipt).toBeUndefined();
  }
);
