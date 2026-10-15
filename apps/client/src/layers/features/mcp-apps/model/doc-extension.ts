/** Namespaced MCP App recording over a host-captured original document permission. */
import { z } from 'zod';
import {
  PageEventSchema,
  CanvasChannelEventReceiptSchema,
  CanvasChannelFrameSchema,
  CanvasChannelStateSchema,
  CANVAS_CHANNEL_ENVELOPE_BYTES,
  inspectCanvasChannelJson,
  type PageEvent,
  type CanvasChannelEventReceipt,
  type CanvasChannelFrame,
  type CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';

/** Same original request survives response loss; inspection never initiates another effect. */
export interface McpAppOriginalEvent {
  readonly id: string;
  readonly bytes: string;
  current(purpose: 'read' | 'submit'): boolean;
  submit(signal: AbortSignal): Promise<CanvasChannelEventReceipt>;
  inspect(signal: AbortSignal): Promise<CanvasChannelEventReceipt>;
}
/** Safe downstream DATA from the existing document replay reducer, without authority metadata. */
export type McpAppDocProjection = {
  readonly events: readonly CanvasChannelFrame[];
  readonly state: CanvasChannelReplayResponse['state'];
  readonly stateRev: number;
  readonly docSeq: number;
  readonly resetRequired: boolean;
  readonly receipts: readonly CanvasChannelEventReceipt[];
};
/** Host-only public composition contract. The App cannot install, replace, or select it. */
export interface McpAppDocHost {
  readonly documentId: string;
  readonly generation: string;
  readonly owner: object;
  current(): boolean;
  captureOriginal(event: PageEvent): McpAppOriginalEvent | null;
  subscribe(receive: (projection: McpAppDocProjection) => void): () => void;
}
const emission = z
  .object({
    v: z.literal(1),
    documentId: z.string().min(1).max(200),
    generation: z.string().min(1).max(200),
    bridgeGeneration: z.string().min(1).max(200),
    event: PageEventSchema,
  })
  .strict();
const negotiation = z.object({ version: z.literal(1) }).strict();
const DENIED = -32000;
// Per actual loaded bridge. Unknown requests and confirmed identity history are never evicted.
const MAX_PENDING = 100;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_IDENTITIES = 1024;
async function fingerprint(bytes: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    ''
  );
}

/** Bind one actual original resource load/window; replacement permanently retires its permission. */
export function createMcpAppDocExtension(
  iframe: HTMLIFrameElement,
  host: McpAppDocHost,
  post: (message: unknown) => void
) {
  const bridgeGeneration = crypto.randomUUID();
  const frame = iframe.contentWindow;
  if (!frame) throw new Error('Original MCP frame unavailable.');
  let live = true,
    loaded = false,
    negotiated = false;
  let ready: (() => void) | undefined;
  const loadReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let high = 0,
    revision = -1;
  const receiptBytes = new Map<string, string>();
  const operations = new Map<
    string,
    {
      original: McpAppOriginalEvent;
      controller: AbortController;
      work?: Promise<CanvasChannelEventReceipt>;
      fingerprint: string;
      byteLength: number;
    }
  >();
  const confirmed = new Map<string, { fingerprint: string; docSeq: number }>();
  let pendingBytes = 0,
    verifyingCount = 0,
    verifyingBytes = 0;
  const current = () => live && iframe.contentWindow === frame && host.current() === true;
  const permitted = () => loaded && negotiated && current();
  const send = (params: unknown) => {
    if (permitted())
      post({
        jsonrpc: '2.0',
        method: 'dorkos/app.event',
        params: {
          v: 1,
          documentId: host.documentId,
          generation: host.generation,
          bridgeGeneration,
          ...Object(params),
        },
      });
  };
  const publish = (view: McpAppDocProjection) => {
    if (!permitted()) return;
    for (const raw of view.events) {
      const event = CanvasChannelFrameSchema.parse(raw);
      if (event.documentId !== host.documentId || event.incarnation?.generation !== host.generation)
        throw new Error('MCP document projection differs.');
      if (event.docSeq > high) {
        send({
          kind: 'event',
          event: { id: event.event.id, type: event.event.type, payload: event.event.payload },
          docSeq: event.docSeq,
        });
        high = event.docSeq;
      }
    }
    if (view.stateRev > revision || view.resetRequired) {
      const state = CanvasChannelStateSchema.parse(view.state);
      send({
        kind: 'state',
        state,
        stateRev: view.stateRev,
        docSeq: view.docSeq,
        resetRequired: view.resetRequired,
      });
      revision = view.stateRev;
    }
    for (const raw of view.receipts) {
      const receipt = CanvasChannelEventReceiptSchema.parse(raw),
        bytes = JSON.stringify(receipt);
      if (receiptBytes.get(receipt.receipt.id) === bytes) continue;
      send({ kind: 'receipt', receipt });
      receiptBytes.set(receipt.receipt.id, bytes);
      if (receiptBytes.size > 400) {
        const oldest = receiptBytes.keys().next().value;
        if (oldest !== undefined) receiptBytes.delete(oldest);
      }
    }
  };
  let latest: McpAppDocProjection | undefined;
  const unsubscribe = host.subscribe((projection) => {
    if (!current()) return;
    latest = projection;
    try {
      publish(projection);
    } catch {
      dispose();
    }
  });
  function dispose() {
    if (!live) return;
    live = false;
    negotiated = false;
    ready?.();
    ready = undefined;
    iframe.removeEventListener('load', onLoad);
    unsubscribe();
    for (const operation of operations.values()) operation.controller.abort();
  }
  function onLoad() {
    // The initial inherited blank is readable by its host. The intended strict-sandbox
    // srcdoc is opaque; a queued blank load must not grant or consume its permission.
    const visible = iframe.contentDocument;
    if (visible?.URL === 'about:blank') {
      return;
    }
    if (visible !== null) {
      dispose();
      return;
    }
    if (loaded) {
      dispose();
      return;
    }
    loaded = true;
    ready?.();
    ready = undefined;
  }
  async function settle(row: NonNullable<ReturnType<typeof operations.get>>, id: string) {
    if (!row.work) {
      if (!row.original.current('read')) throw new Error('MCP document permission unavailable.');
      row.work = row.original.inspect(row.controller.signal);
      void row.work.catch(() => {});
    }
    const originalWork = row.work;
    try {
      const receipt = CanvasChannelEventReceiptSchema.parse(await originalWork);
      const history = confirmed.get(id);
      if (
        !permitted() ||
        !row.original.current('read') ||
        receipt.receipt.id !== id ||
        (history &&
          (history.fingerprint !== row.fingerprint || receipt.receipt.docSeq !== history.docSeq))
      )
        throw new Error('MCP document permission unavailable.');
      confirmed.set(id, { fingerprint: row.fingerprint, docSeq: receipt.receipt.docSeq });
      if (operations.get(id) === row) {
        operations.delete(id);
        pendingBytes -= row.byteLength;
      }
      return receipt;
    } finally {
      if (row.work === originalWork) row.work = undefined;
    }
  }
  iframe.addEventListener('load', onLoad);
  return Object.freeze({
    dispose,
    currentLoad: () => loaded && current(),
    async initialize(params: unknown) {
      if (
        !params ||
        typeof params !== 'object' ||
        !('extensions' in params) ||
        !params.extensions ||
        typeof params.extensions !== 'object' ||
        !('dorkos/app' in params.extensions) ||
        !negotiation.safeParse(params.extensions['dorkos/app']).success
      ) {
        return undefined;
      }
      await loadReady;
      const originalCurrent = current();
      if (!originalCurrent) return undefined;
      negotiated = true;
      return {
        version: 1,
        documentId: host.documentId,
        generation: host.generation,
        bridgeGeneration,
        emit: true,
        events: true,
        limits: {
          pendingOperations: MAX_PENDING,
          pendingBytes: MAX_PENDING_BYTES,
          retainedIdentities: MAX_IDENTITIES,
          confirmedRetry: 'inspect-only',
          historyEviction: false,
        },
      };
    },
    publishInitial() {
      if (latest && permitted()) {
        try {
          publish(latest);
        } catch {
          dispose();
        }
      }
    },
    async emit(params: unknown): Promise<CanvasChannelEventReceipt> {
      if (!permitted()) throw new Error('MCP document permission unavailable.');
      if (inspectCanvasChannelJson(params, CANVAS_CHANNEL_ENVELOPE_BYTES + 1024))
        throw new Error('MCP event bounds differ.');
      const input = emission.parse(params);
      if (
        input.documentId !== host.documentId ||
        input.generation !== host.generation ||
        input.bridgeGeneration !== bridgeGeneration ||
        !permitted()
      )
        throw new Error('MCP document permission unavailable.');
      const bytes = JSON.stringify(input.event);
      const previous = operations.get(input.event.id);
      if (previous) {
        if (previous.original.bytes !== bytes) throw new Error('MCP event identity differs.');
        if (previous.work) throw new Error('MCP original request is still pending.');
        return settle(previous, input.event.id);
      }
      const byteLength = new TextEncoder().encode(bytes).byteLength;
      // Reserve retained verification DATA before the first await, alongside original payloads.
      if (
        operations.size + verifyingCount >= MAX_PENDING ||
        pendingBytes + verifyingBytes + byteLength > MAX_PENDING_BYTES
      )
        throw new Error('MCP retained operation bound.');
      verifyingCount++;
      verifyingBytes += byteLength;
      let reserved = true;
      const releaseVerification = () => {
        if (!reserved) return;
        reserved = false;
        verifyingCount--;
        verifyingBytes -= byteLength;
      };
      try {
        const hash = await fingerprint(bytes);
        if (!permitted()) throw new Error('MCP document permission unavailable.');
        const history = confirmed.get(input.event.id);
        if (history && history.fingerprint !== hash) throw new Error('MCP event identity differs.');
        const concurrent = operations.get(input.event.id);
        if (concurrent) {
          if (concurrent.original.bytes !== bytes || concurrent.fingerprint !== hash)
            throw new Error('MCP event identity differs.');
          releaseVerification();
          if (concurrent.work) throw new Error('MCP original request is still pending.');
          return settle(concurrent, input.event.id);
        }
        if (
          !history &&
          confirmed.size +
            Array.from(operations.keys()).filter((id) => !confirmed.has(id)).length >=
            MAX_IDENTITIES
        )
          throw new Error('MCP retained operation bound.');
        const original = host.captureOriginal(input.event);
        if (
          !original ||
          !permitted() ||
          original.id !== input.event.id ||
          original.bytes !== bytes ||
          !original.current(history ? 'read' : 'submit')
        )
          throw new Error('MCP document permission unavailable.');
        const row: NonNullable<ReturnType<typeof operations.get>> = {
          original,
          controller: new AbortController(),
          fingerprint: hash,
          byteLength,
          work: undefined,
        };
        // Transfer this exact envelope reservation into the original retained operation,
        // without an await or callback between ledger insertion and accounting transfer.
        operations.set(input.event.id, row);
        pendingBytes += byteLength;
        releaseVerification();
        // Confirmed IDs can only inspect: native retention never makes them new effects.
        row.work = history
          ? original.inspect(row.controller.signal)
          : original.submit(row.controller.signal);
        void row.work.catch(() => {});
        return settle(row, input.event.id);
      } finally {
        releaseVerification();
      }
    },
    error: { code: DENIED, message: 'This document operation is unavailable.' },
  });
}
