import { z } from 'zod';
import {
  BrowserInputRequestSchema,
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
