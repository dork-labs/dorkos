/** @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpAppDocExtension, type McpAppDocHost } from '../model/doc-extension';
import type { PageEvent } from '@dorkos/shared/canvas-channel-schemas';
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
});
function event(index: number, payload: PageEvent['payload'] = { value: index }): PageEvent {
  return {
    v: 1,
    id: `33333333-3333-4333-8333-${index.toString(16).padStart(12, '0')}`,
    type: 'task.changed',
    payload,
  };
}
async function fixture() {
  const receipts = new Map<
    string,
    { receipt: { id: string; status: 'recorded'; docSeq: number }; deliveries: [] }
  >();
  let unavailable = false,
    unknown = false,
    seq = 0,
    live = true;
  const submit = vi.fn(async (value: PageEvent) => {
    if (unknown) throw undefined;
    const receipt = {
      receipt: { id: value.id, status: 'recorded' as const, docSeq: ++seq },
      deliveries: [] as [],
    };
    receipts.set(value.id, receipt);
    return receipt;
  });
  const inspect = vi.fn(async (value: PageEvent) => {
    if (unavailable) throw undefined;
    const receipt = receipts.get(value.id);
    if (!receipt) throw undefined;
    return receipt;
  });
  const capture = vi.fn((value: PageEvent) => ({
    id: value.id,
    bytes: JSON.stringify(value),
    current: () => live,
    submit: () => submit(value),
    inspect: () => inspect(value),
  }));
  const host: McpAppDocHost = {
    documentId: 'native-doc',
    generation: 'native-birth',
    owner: {},
    current: () => live,
    captureOriginal: capture,
    subscribe: () => () => {},
  };
  const iframe = Object.assign(new EventTarget(), {
    contentWindow: {},
    contentDocument: null,
  }) as unknown as HTMLIFrameElement;
  const extension = createMcpAppDocExtension(iframe, host, () => {});
  disposers.push(extension.dispose);
  iframe.dispatchEvent(new Event('load'));
  const permission = await extension.initialize({ extensions: { 'dorkos/app': { version: 1 } } });
  if (!permission) throw new Error('Expected original negotiated permission');
  const emit = (value: PageEvent) =>
    extension.emit({
      v: 1,
      documentId: host.documentId,
      generation: host.generation,
      bridgeGeneration: permission.bridgeGeneration,
      event: value,
    });
  return {
    emit,
    capture,
    submit,
    inspect,
    receipts,
    permission,
    expire: () => {
      unavailable = true;
    },
    unknown: () => {
      unknown = true;
    },
    retire: () => {
      live = false;
    },
  };
}
describe('bounded MCP original-operation retention', () => {
  it('supports more than 200 confirmed events, advertises finite history, and never resubmits an expired known ID', async () => {
    const own = await fixture();
    expect(own.permission.limits).toEqual({
      pendingOperations: 100,
      pendingBytes: 1048576,
      retainedIdentities: 1024,
      confirmedRetry: 'inspect-only',
      historyEviction: false,
    });
    for (let index = 1; index <= 1024; index++) {
      const result = await own.emit(event(index));
      expect(result.receipt.docSeq).toBe(index);
      if (index === 201) expect(own.submit).toHaveBeenCalledTimes(201);
    }
    await expect(own.emit(event(1025))).rejects.toThrow('MCP retained operation bound');
    expect(own.submit).toHaveBeenCalledTimes(1024);
    await expect(own.emit(event(1, { changed: true }))).rejects.toThrow(
      'MCP event identity differs'
    );
    expect(own.capture).toHaveBeenCalledTimes(1024);
    const retry = await own.emit(event(1));
    expect(retry).toEqual(own.receipts.get(event(1).id));
    expect(own.inspect).toHaveBeenCalledTimes(1);
    own.expire();
    await expect(own.emit(event(1))).rejects.toBeUndefined();
    await expect(own.emit(event(1))).rejects.toBeUndefined();
    expect(own.submit).toHaveBeenCalledTimes(1024);
    expect(own.inspect).toHaveBeenCalledTimes(3);
    own.retire();
    await expect(own.emit(event(1))).rejects.toThrow('MCP document permission unavailable');
    expect(own.inspect).toHaveBeenCalledTimes(3);
  });
  it('retains 100 unknown originals and refuses further captures without evicting or resubmitting them', async () => {
    const own = await fixture();
    own.unknown();
    for (let index = 1; index <= 100; index++)
      await expect(own.emit(event(index))).rejects.toBeUndefined();
    await expect(own.emit(event(101))).rejects.toThrow('MCP retained operation bound');
    expect(own.capture).toHaveBeenCalledTimes(100);
    await expect(own.emit(event(1))).rejects.toBeUndefined();
    expect(own.submit).toHaveBeenCalledTimes(100);
    expect(own.inspect).toHaveBeenCalledTimes(1);
  });
  it.each([
    { large: false, count: 100 },
    { large: true, count: 86 },
  ])(
    'reserves actual retained hash work before awaiting it (large=$large)',
    async ({ large, count }) => {
      const own = await fixture();
      const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
      const releases: Array<() => void> = [];
      const work: Promise<unknown>[] = [];
      const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(
        (...args) =>
          new Promise((resolve) => {
            releases.push(() => resolve(actualDigest(...args)));
          })
      );
      const payload: PageEvent['payload'] = large ? { text: 'é'.repeat(6000) } : { value: 1 };
      try {
        for (let index = 1; index <= count; index++) work.push(own.emit(event(index, payload)));
        for (const promise of work) void promise.catch(() => {});
        expect(digest).toHaveBeenCalledTimes(count);
        expect(own.capture).not.toHaveBeenCalled();
        await expect(own.emit(event(count + 1, payload))).rejects.toThrow(
          'MCP retained operation bound'
        );
        expect(digest).toHaveBeenCalledTimes(count);
        expect(own.capture).not.toHaveBeenCalled();
        for (const release of releases.splice(0)) release();
        const settled = await Promise.allSettled(work);
        expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
        expect(own.capture).toHaveBeenCalledTimes(count);
        expect(own.submit).toHaveBeenCalledTimes(count);
        digest.mockRestore();
        await own.emit(event(count + 1, payload));
        expect(own.submit).toHaveBeenCalledTimes(count + 1);
      } finally {
        for (const release of releases.splice(0)) release();
        await Promise.allSettled(work);
        digest.mockRestore();
      }
    }
  );
  it('enforces the UTF-8 pending byte budget independently of the pending count', async () => {
    const own = await fixture();
    own.unknown();
    const payload = { text: 'é'.repeat(6000) };
    let acceptedUnknown = 0;
    for (let index = 1; index <= 100; index++) {
      try {
        await own.emit(event(index, payload));
      } catch (cause) {
        if (cause === undefined) {
          acceptedUnknown++;
          continue;
        }
        expect(cause).toBeInstanceOf(Error);
        if (!(cause instanceof Error)) throw cause;
        expect(cause.message).toBe('MCP retained operation bound.');
        break;
      }
    }
    const envelopeBytes = new TextEncoder().encode(JSON.stringify(event(1, payload))).byteLength;
    expect(envelopeBytes).toBe(12095);
    expect(acceptedUnknown).toBe(86);
    expect(acceptedUnknown * envelopeBytes).toBeLessThanOrEqual(1048576);
    expect((acceptedUnknown + 1) * envelopeBytes).toBeGreaterThan(1048576);
    expect(own.capture).toHaveBeenCalledTimes(acceptedUnknown);
    expect(own.submit).toHaveBeenCalledTimes(acceptedUnknown);
  });
});
