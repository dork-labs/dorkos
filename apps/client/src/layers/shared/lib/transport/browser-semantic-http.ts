import { z } from 'zod';
import { BrowserBindingSchema, BrowserReferenceSchema } from '@dorkos/shared/browser-schemas';
import {
  SemanticSnapshotV1Schema,
  SemanticReceiptV1Schema,
  SemanticActionV1Schema,
  SemanticEventV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import type { BrowserSemanticTransport, BrowserSemanticScope } from '@dorkos/shared/transport';
const scopeSchema = z
  .object({
    binding: BrowserBindingSchema,
    grant: z
      .object({
        grantId: BrowserReferenceSchema,
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Original same-origin cookie wire; bounds precede JSON allocation and imply no availability. */
export function createBrowserSemanticHttp(baseUrl: string): BrowserSemanticTransport {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const post = async (kind: string, value: unknown, signal: AbortSignal, owner = false) => {
    signal.throwIfAborted();
    const response = await originalFetch(
      `${baseUrl}/browser/semantic/${owner ? 'owner/' : ''}${kind}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
        signal,
      }
    );
    if (!response.body) throw new Error('SEMANTIC_RESPONSE_MISSING');
    const reader = response.body.getReader();
    let first: Readonly<{ value: unknown }> | undefined, result: unknown;
    try {
      if (!response.ok) throw new Error('SEMANTIC_HTTP_REFUSED');
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 256 * 1024) throw new Error('SEMANTIC_RESPONSE_BOUND');
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (value) {
      first = { value };
    }
    try {
      await reader.cancel();
    } catch (value) {
      first ??= { value };
    }
    try {
      reader.releaseLock();
    } catch (value) {
      first ??= { value };
    }
    if (first) throw first.value;
    return result;
  };
  return Object.freeze({
    async readBrowserSemantic(scope: BrowserSemanticScope, signal: AbortSignal) {
      const actual = scopeSchema.parse(scope);
      const value = SemanticSnapshotV1Schema.parse(
        await post('read', actual, signal, !actual.grant)
      );
      for (const key of Object.keys(actual.binding) as (keyof typeof actual.binding)[])
        if (actual.binding[key] !== value[key]) throw new Error('SEMANTIC_BINDING_MISMATCH');
      return value;
    },
    async openBrowserSemanticStream(
      scope: BrowserSemanticScope,
      leaseId: string,
      signal: AbortSignal
    ) {
      const actual = scopeSchema.parse(scope),
        lease = BrowserReferenceSchema.parse(leaseId),
        birth = z
          .object({ eventStreamId: BrowserReferenceSchema })
          .strict()
          .parse(await post('stream', { ...actual, leaseId: lease }, signal, !actual.grant));
      let closed = false,
        closing: Promise<void> | undefined,
        pending: Promise<unknown> | undefined;
      return Object.freeze({
        eventStreamId: birth.eventStreamId,
        next(signal: AbortSignal) {
          if (closed || pending) return Promise.reject(new Error('SEMANTIC_STREAM_CLOSED'));
          const original = Promise.resolve().then(async () => {
            if (closed) throw new Error('SEMANTIC_STREAM_CLOSED');
            const value = SemanticEventV1Schema.nullable().parse(
              await post(
                'next',
                { ...actual, leaseId: lease, streamId: birth.eventStreamId },
                signal,
                !actual.grant
              )
            );
            if (value && value.eventStreamId !== birth.eventStreamId)
              throw new Error('SEMANTIC_STREAM_MISMATCH');
            if (value)
              for (const key of Object.keys(actual.binding) as (keyof typeof actual.binding)[])
                if (actual.binding[key] !== value.identity[key])
                  throw new Error('SEMANTIC_BINDING_MISMATCH');
            return value;
          });
          pending = original;
          void original.then(
            () => {
              if (pending === original) pending = undefined;
            },
            () => {
              if (pending === original) pending = undefined;
            }
          );
          return original;
        },
        close() {
          if (closing) return closing;
          closed = true;
          const original = pending;
          closing = Promise.resolve().then(async () => {
            const remote = post(
              'close',
              { ...actual, leaseId: lease, streamId: birth.eventStreamId },
              new AbortController().signal,
              !actual.grant
            );
            void remote.catch(() => {});
            let first: Readonly<{ value: unknown }> | undefined;
            if (original)
              try {
                await original;
              } catch (value) {
                first = { value };
              }
            try {
              z.object({ closed: z.literal(true) })
                .strict()
                .parse(await remote);
            } catch (value) {
              first ??= { value };
            }
            if (first) throw first.value;
          });
          return closing;
        },
      });
    },
    async actionBrowserSemantic(
      scope: BrowserSemanticScope,
      controllerId: string,
      request: import('@dorkos/shared/browser-semantic-schemas').SemanticActionV1,
      signal: AbortSignal
    ) {
      const actual = scopeSchema.parse(scope),
        command = SemanticActionV1Schema.parse(request),
        controller = BrowserReferenceSchema.parse(controllerId),
        receipt = SemanticReceiptV1Schema.parse(
          await post(
            'action',
            {
              ...actual,
              controllerId: controller,
              request: command,
              ...(command.action.kind === 'writeSecret' ? { confirmSecret: true } : {}),
            },
            signal,
            !actual.grant
          )
        );
      if (receipt.requestId !== command.requestId) throw new Error('SEMANTIC_REQUEST_MISMATCH');
      for (const key of Object.keys(actual.binding) as (keyof typeof actual.binding)[])
        if (actual.binding[key] !== receipt.identity[key])
          throw new Error('SEMANTIC_BINDING_MISMATCH');
      return receipt;
    },
  });
}
