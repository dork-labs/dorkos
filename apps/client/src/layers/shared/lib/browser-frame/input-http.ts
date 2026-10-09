import { z } from 'zod';
import {
  BrowserInputRequestSchema,
  type BrowserCopySelectionRequest,
  BrowserCopySelectionRequestSchema,
  BrowserCopySelectionReceiptSchema,
  BrowserActionReceiptSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
  type BrowserInputRequest,
  type BrowserBinding,
} from '@dorkos/shared/browser-schemas';
import type { BrowserInputTransport } from '@dorkos/shared/transport';
import { fetchResponse } from '../transport/http-client';
const contextSchema = z
  .object({
    localTicket: z
      .string()
      .regex(/^[A-Za-z0-9_-]{22,128}$/u)
      .optional(),
    grant: z
      .object({ grantId: BrowserReferenceSchema, revision: BrowserCounterSchema })
      .strict()
      .optional(),
  })
  .strict();
/** Captured original local admission references only, never a fabricated controller or permission. */
export type BrowserInputHttpContextReader = () => z.infer<typeof contextSchema>;
const same = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);
/** Private POST-only semantic input capability; original signal/cookie/auth path is retained. */
export function createBrowserInputHttp(
  baseUrl: string,
  readContext: BrowserInputHttpContextReader = () => ({})
): BrowserInputTransport {
  const originalContext = readContext.bind(undefined);
  return Object.freeze({
    async copyBrowserSelection(
      value: BrowserCopySelectionRequest,
      controllerIdValue: string,
      signal: AbortSignal
    ) {
      const command = BrowserCopySelectionRequestSchema.parse(value),
        controllerId = BrowserReferenceSchema.parse(controllerIdValue),
        context = contextSchema.parse(originalContext());
      signal.throwIfAborted();
      const response = await fetchResponse(baseUrl, '/browser/copy-selection', {
        method: 'POST',
        body: JSON.stringify({ command, controllerId, ...context }),
        signal,
        timeout: null,
      });
      const stream = response.body;
      if (!stream) throw new Error('Selected browser text is unavailable.');
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let count = 0;
      let first: { value: unknown } | undefined;
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          count += next.value.byteLength;
          if (count > 16384) throw new Error('Selected browser text is too large.');
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(count);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const receipt = BrowserCopySelectionReceiptSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        );
        signal.throwIfAborted();
        if (receipt.requestId !== command.requestId || !same(receipt.binding, command.binding))
          throw new Error('Selected browser text changed.');
        return Object.freeze({ ...receipt, binding: Object.freeze({ ...receipt.binding }) });
      } catch (value) {
        first = { value };
      } finally {
        if (first) {
          try {
            await reader.cancel(first.value);
          } catch {
            /* Original failure retains precedence. */
          }
        }
        try {
          reader.releaseLock();
        } catch (value) {
          first ??= { value };
        }
      }
      if (first) throw first.value;
      throw new Error('Selected browser text is unavailable.');
    },
    async inputBrowser(value: BrowserInputRequest, controllerIdValue: string, signal: AbortSignal) {
      const command = BrowserInputRequestSchema.parse(value);
      const controllerId = BrowserReferenceSchema.parse(controllerIdValue);
      const context = contextSchema.parse(originalContext());
      signal.throwIfAborted();
      const response = await fetchResponse(baseUrl, '/browser/input', {
        method: 'POST',
        body: JSON.stringify({ command, controllerId, ...context }),
        signal,
        timeout: null,
      });
      if (signal.aborted) {
        // The original response can arrive after cancellation. Retain its untouched body until
        // original cancellation settles; an abort observation alone does not return byte custody.
        let reason: unknown;
        try {
          signal.throwIfAborted();
        } catch (cause) {
          reason = cause;
        }
        try {
          const body = response.body;
          if (body) {
            const cancel = body.cancel.bind(body);
            await cancel(reason);
          }
        } catch {
          // Cleanup refusal cannot replace the first original abort, including a falsy cause.
        }
        throw reason;
      }
      const original: unknown = await response.json();
      signal.throwIfAborted();
      const receipt = BrowserActionReceiptSchema.parse(original);
      if (receipt.requestId !== command.requestId || !same(receipt.binding, command.binding))
        throw new Error('Browser input response did not match the requested action.');
      return Object.freeze({ ...receipt, binding: Object.freeze({ ...receipt.binding }) });
    },
  });
}
