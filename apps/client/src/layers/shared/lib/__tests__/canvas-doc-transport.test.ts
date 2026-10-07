import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  CanvasChannelEventReceiptSchema,
  CanvasChannelReplayResponseSchema,
  type PageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { HttpTransport } from '../transport';
const input: PageEvent = {
  v: 1,
  id: '11111111-2222-4333-8444-555555555555',
  type: 'task.changed',
  payload: { done: true },
};
const condition = Object.freeze({ expectedGeneration: 'a'.repeat(64) });
const signal = new AbortController().signal;
const receipt = { receipt: { id: input.id, status: 'recorded', docSeq: 1 }, deliveries: [] };
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('document event Transport contract', () => {
  it('uses the mock port for acceptance, bounded replay and retained inspection', async () => {
    const transport: Transport = createMockTransport();
    expect(
      CanvasChannelEventReceiptSchema.safeParse(
        await transport.ingestCanvasEvent('doc', input, condition, signal)
      ).success
    ).toBe(true);
    expect(
      CanvasChannelEventReceiptSchema.safeParse(
        await transport.getCanvasEventReceipt('doc', input.id, condition, signal)
      ).success
    ).toBe(true);
    expect(
      CanvasChannelReplayResponseSchema.safeParse(
        await transport.getCanvasChannel('doc', { since: 0, limit: 1 })
      ).success
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('encodes opaque document IDs, sends only the envelope and returns acceptance separately', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(receipt), { status: 201 }));
    const transport: Transport = new HttpTransport('/api');
    expect(await transport.ingestCanvasEvent('a/b ?', input, condition, signal)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith(
      '/api/canvas/docs/a%2Fb%20%3F/events',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input), signal })
    );
  });
  it('preserves explicit zero cursors and limits without sending a caller or scope', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
    const transport: Transport = new HttpTransport('/api');
    await transport.getCanvasChannel('doc', { since: 0, limit: 1 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/canvas/docs/doc/channel?since=0&limit=1',
      expect.any(Object)
    );
    await transport.getCanvasChannel('doc');
    expect(fetch).toHaveBeenLastCalledWith('/api/canvas/docs/doc/channel', expect.any(Object));
  });
  it('inspects receipts without replay and preserves HTTP refusals as failures', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'The document is not available.',
            code: 'CANVAS_DOCUMENT_NOT_FOUND',
          }),
          { status: 404 }
        )
      );
    const transport: Transport = new HttpTransport('/api');
    await transport.getCanvasEventReceipt('doc', input.id, condition, signal);
    expect(fetch).toHaveBeenCalledWith(
      `/api/canvas/docs/doc/events/${input.id}`,
      expect.any(Object)
    );
    await expect(
      transport.getCanvasEventReceipt('missing', input.id, condition, signal)
    ).rejects.toMatchObject({
      status: 404,
    });
  });
  it('forwards the original generation header and exact signal on BOTH bound operations', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(receipt)));
    const transport: Transport = new HttpTransport('/api');
    const controller = new AbortController();
    const original = controller.signal;
    await transport.ingestCanvasEvent('doc', input, condition, original);
    await transport.getCanvasEventReceipt('doc', input.id, condition, original);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    for (const [, options] of vi.mocked(fetch).mock.calls) {
      expect(options?.signal).toBe(original);
      expect(new Headers(options?.headers).get('X-DorkOS-Doc-Generation')).toBe(
        condition.expectedGeneration
      );
      expect(options?.credentials).toBe('include');
    }
    controller.abort();
    for (const [, options] of vi.mocked(fetch).mock.calls)
      expect(options?.signal?.aborted).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify(input));
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBeUndefined();
  });
  it.each(['submit', 'inspect'] as const)(
    'keeps native aborted %s uncertainty as the original rejection',
    async (operation) => {
      const controller = new AbortController();
      const reason = new DOMException('Retired', 'AbortError');
      controller.abort(reason);
      vi.mocked(fetch).mockImplementation(async (_url, options) => {
        expect(options?.signal).toBe(controller.signal);
        options?.signal?.throwIfAborted();
        throw new Error('Aborted request reached success');
      });
      const transport: Transport = new HttpTransport('/api');
      const result =
        operation === 'submit'
          ? transport.ingestCanvasEvent('doc', input, condition, controller.signal)
          : transport.getCanvasEventReceipt('doc', input.id, condition, controller.signal);
      await expect(result).rejects.toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
});

// Numeric metadata controls: both operations use the actual shared HTTP error path.
describe('actual numeric Retry-After error metadata', () => {
  it.each(['submit', 'inspect'] as const)(
    'captures the real header for bound %s without changing signal/body/error',
    async (operation) => {
      const controller = new AbortController();
      const body = {
        error: 'The document has too many pending events. Try again later.',
        code: 'DOC_CHANNEL_RATE_LIMIT',
        retryAfterMs: 999,
      };
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(body), { status: 429, headers: { 'Retry-After': '2' } })
      );
      const transport: Transport = new HttpTransport('/api');
      const result =
        operation === 'submit'
          ? transport.ingestCanvasEvent('doc', input, condition, controller.signal)
          : transport.getCanvasEventReceipt('doc', input.id, condition, controller.signal);
      await expect(result).rejects.toMatchObject({
        message: body.error,
        code: body.code,
        status: 429,
        body,
        retryAfterMs: 2000,
      });
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
      expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(
        operation === 'submit' ? JSON.stringify(input) : undefined
      );
      expect(
        new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('X-DorkOS-Doc-Generation')
      ).toBe(condition.expectedGeneration);
      controller.abort();
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
  );
  it.each([
    null,
    '',
    '-1',
    'NaN',
    'Infinity',
    '1e3',
    'Wed, 21 Oct 2015 07:28:00 GMT',
    '9'.repeat(400),
  ])(
    'does not invent retry permission from invalid/missing header %s or a body field',
    async (header) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'busy', code: 'DOC_CHANNEL_RATE_LIMIT', retryAfterMs: 123 }),
          {
            status: 429,
            headers: header === null ? {} : { 'Retry-After': header },
          }
        )
      );
      const transport = new HttpTransport('/api');
      const error = await transport
        .ingestCanvasEvent('doc', input, condition, signal)
        .catch((value: unknown) => value);
      expect(error).toMatchObject({
        status: 429,
        code: 'DOC_CHANNEL_RATE_LIMIT',
        body: { retryAfterMs: 123 },
      });
      expect(Object.hasOwn(error as object, 'retryAfterMs')).toBe(false);
    }
  );
  it('does not attach retry metadata to a generic404 with the same header', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'The document is not available.',
          code: 'CANVAS_DOCUMENT_NOT_FOUND',
        }),
        {
          status: 404,
          headers: { 'Retry-After': '2' },
        }
      )
    );
    const error = await new HttpTransport('/api')
      .getCanvasEventReceipt('doc', input.id, condition, signal)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 404, code: 'CANVAS_DOCUMENT_NOT_FOUND' });
    expect(Object.hasOwn(error as object, 'retryAfterMs')).toBe(false);
  });
});

it.each(['0', '0.5', ' 3 '])(
  'retains finite nonnegative actual Retry-After %s seconds, including zero',
  async (header) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'busy' }), {
        status: 429,
        headers: { 'Retry-After': header },
      })
    );
    await expect(
      new HttpTransport('/api').ingestCanvasEvent('doc', input, condition, signal)
    ).rejects.toMatchObject({ status: 429, retryAfterMs: Number(header) * 1000 });
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(signal);
  }
);

it('does not assign backoff metadata to a503 even when its header is numeric', async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'unavailable', code: 'DOC_CHANNEL_UNAVAILABLE' }), {
      status: 503,
      headers: { 'Retry-After': '2' },
    })
  );
  const error = await new HttpTransport('/api')
    .ingestCanvasEvent('doc', input, condition, signal)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ status: 503, code: 'DOC_CHANNEL_UNAVAILABLE' });
  expect(Object.hasOwn(error as object, 'retryAfterMs')).toBe(false);
  expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify(input));
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(signal);
});

it('keeps operator token credentials in a POST response and rejects a mismatched issued scope', async () => {
  const request = {
    documentId: 'doc',
    allowedTypes: ['task.changed'],
    directions: ['upstream'] as const,
    permissions: ['ingest', 'replay'] as const,
    expiresAt: '2026-10-06T00:00:00.000Z',
  };
  const scope = {
    ...request,
    directions: [...request.directions],
    permissions: [...request.permissions],
  };
  const issued = {
    ...scope,
    tokenId: 'token',
    creatorId: 'owner',
    createdAt: '2026-10-05T00:00:00.000Z',
    token: 'dct_' + 'A'.repeat(43),
  };
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(issued), { status: 201 }));
  const transport = new HttpTransport('/api');
  expect(await transport.issueCanvasDocToken(scope, ['grant'])).toEqual(issued);
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/canvas/docs/doc/tokens',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ request: scope, approvedGrantIds: ['grant'] }),
    })
  );
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ ...issued, documentId: 'other' }), { status: 201 })
  );
  await expect(transport.issueCanvasDocToken(scope, ['grant'])).rejects.toThrow('does not match');
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ tokenId: 'foreign', revokedAt: '2026-10-05T00:00:00.000Z' }))
  );
  await expect(transport.revokeCanvasDocToken('doc', 'token')).rejects.toThrow('does not match');
});

describe('explicit operator document route controls', () => {
  it('retains the exact approval subject and its independent route ticket on retry', async () => {
    const request = Object.freeze({
      documentId: 'a/b',
      routeId: 'comments',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const ticket = {
      approvalId: 'approval',
      token: 'exact-route-token',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'approval_required', ticket })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ kind: 'granted', grantId: 'grant', revision: 1 }))
      );
    const transport = new HttpTransport('/api');
    expect(await transport.approveCanvasDocRoute(request)).toEqual({
      kind: 'approval_required',
      ticket,
    });
    expect(await transport.approveCanvasDocRoute(request, ticket.token)).toEqual({
      kind: 'granted',
      grantId: 'grant',
      revision: 1,
    });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe('/api/canvas/docs/a%2Fb/manage/approve');
    expect(calls[1][0]).toBe(calls[0][0]);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual(request);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
      ...request,
      routeApprovalToken: ticket.token,
    });
    expect(new Headers(calls[1][1]?.headers).get('X-DorkOS-Approval')).toBeNull();
    expect(calls[1][1]?.credentials).toBe('include');
  });
  it('rejects an approval-shaped result that carries an unrecognized authority field', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ kind: 'granted', grantId: 'grant', revision: 1, principal: {} })
      )
    );
    await expect(
      new HttpTransport('/api').approveCanvasDocRoute({
        documentId: 'doc',
        routeId: 'comments',
        expiresAt: '2099-01-01T00:00:00Z',
      })
    ).rejects.toThrow();
  });
});

// Explicit review is separate from ordinary input acceptance and passive replay.
describe('reviewed expired work Transport', () => {
  const request = Object.freeze({
    documentId: 'doc',
    expectedGeneration: 'a'.repeat(64),
    eventId: '11111111-2222-4333-8444-555555555555',
    batchId: '22222222-2222-4333-8444-555555555555',
    expectedBatchGeneration: '33333333-2222-4333-8444-555555555555',
    grantId: 'grant',
  });
  const result = {
    documentId: request.documentId,
    eventId: request.eventId,
    previousBatchId: request.batchId,
    batchId: '44444444-2222-4333-8444-555555555555',
    generation: '55555555-2222-4333-8444-555555555555',
    status: 'pending',
  };
  it('keeps the original explicit operation across an unknown response and retry', async () => {
    const raw = new Error('Lost response');
    vi.mocked(fetch)
      .mockRejectedValueOnce(raw)
      .mockResolvedValueOnce(new Response(JSON.stringify(result)));
    const transport = new HttpTransport('/api');
    await expect(transport.replayCanvasDocBatch(request)).rejects.toBe(raw);
    expect(await transport.replayCanvasDocBatch(request)).toEqual(result);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(url).toBe('/api/canvas/docs/doc/manage/replay');
      expect(options?.body).toBe(JSON.stringify(request));
      expect(options?.credentials).toBe('include');
    }
  });
  it('refuses a well-shaped response belonging to another original operation', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ...result, eventId: '66666666-2222-4333-8444-555555555555' }))
    );
    await expect(new HttpTransport('/api').replayCanvasDocBatch(request)).rejects.toThrow();
  });
  it('does not make a mock replay successful without an explicit configured owner', async () => {
    await expect(createMockTransport().replayCanvasDocBatch(request)).rejects.toThrow(
      'not configured'
    );
  });
});

// Host commands do not use the ordinary page submit envelope.
describe('original editor selection Transport', () => {
  const request = {
    documentId: 'doc',
    expectedGeneration: 'a'.repeat(64),
    eventId: '11111111-2222-4333-8444-555555555555',
    expectedFileHash: 'b'.repeat(64),
    sourceGeneration: 'editor-model',
    ranges: [{ start: 0, end: 1 }],
    selectedText: 'x',
  };
  it('sends the exact source-bound command and correlates the original acceptance ID', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          receipt: { id: request.eventId, status: 'recorded', docSeq: 1 },
          deliveries: [],
        })
      )
    );
    const transport = new HttpTransport('/api');
    expect((await transport.askCanvasDocSelection(request)).receipt.id).toBe(request.eventId);
    expect(fetch).toHaveBeenCalledWith(
      '/api/canvas/docs/doc/editor/selection',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
        credentials: 'include',
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          receipt: { id: '22222222-2222-4333-8444-555555555555', status: 'recorded', docSeq: 2 },
          deliveries: [],
        })
      )
    );
    await expect(transport.askCanvasDocSelection(request)).rejects.toThrow();
  });
  it('has no successful mock host command without its explicit owner', async () => {
    await expect(createMockTransport().askCanvasDocSelection(request)).rejects.toThrow(
      'not configured'
    );
  });
});
