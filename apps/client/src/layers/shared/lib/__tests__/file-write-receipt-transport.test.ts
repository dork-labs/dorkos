import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HttpTransport } from '../transport';
const incarnation = {
  v: 1,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
} as const;
const documentSave = {
  documentId: 'doc-1',
  eventId: '10000000-0000-4000-8000-000000000001',
  incarnation,
};
const documentReceipt = {
  ...documentSave,
  docSeq: 4,
  fileHash: 'b'.repeat(64),
  status: 'accepted',
} as const;
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());
it.each(['/api', 'http://localhost:54321/api'])(
  'preserves original receipt correlation through actual web/desktop HTTP base %s',
  async (baseUrl) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          hash: documentReceipt.fileHash,
          effect: 'changed',
          documentReceipt,
        })
      )
    );
    const transport = new HttpTransport(baseUrl);
    const result = await transport.writeFile('/work', 'doc.md', 'draft', {
      expectedContent: 'base',
      documentSave,
    });
    expect(result).toEqual({
      ok: true,
      hash: documentReceipt.fileHash,
      effect: 'changed',
      documentReceipt,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/files/content`,
      expect.objectContaining({
        credentials: 'include',
        method: 'PUT',
        body: JSON.stringify({
          cwd: '/work',
          path: 'doc.md',
          content: 'draft',
          expectedContent: 'base',
          documentSave,
        }),
      })
    );
  }
);
it('keeps plain/no-op saves receipt-free and preserves complete conflict metadata', async () => {
  const transport = new HttpTransport('/api');
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true, hash: 'base', effect: 'no_op' }))
  );
  expect(await transport.writeFile('/work', 'doc.md', 'base')).toEqual({
    ok: true,
    hash: 'base',
    effect: 'no_op',
  });
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ currentHash: 'other', currentContent: 'external' }), {
      status: 409,
    })
  );
  expect(await transport.writeFile('/work', 'doc.md', 'draft')).toEqual({
    ok: false,
    conflict: { currentHash: 'other', currentContent: 'external' },
  });
});
it('does not silently discard a malformed supplied receipt', async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        hash: 'b'.repeat(64),
        effect: 'changed',
        documentReceipt: { ...documentReceipt, docSeq: 0 },
      })
    )
  );
  await expect(new HttpTransport('/api').writeFile('/work', 'doc.md', 'draft')).rejects.toThrow();
});
