import { z } from 'zod';
import {
  BrowserBindingSchema,
  BrowserCounterSchema,
  BrowserReferenceSchema,
  BrowserRenderReceiptSchema,
  BrowserViewerSchema,
  type BrowserBinding,
  type BrowserRenderReceipt,
} from '@dorkos/shared/browser-schemas';
import type { BrowserViewerTransport } from '@dorkos/shared/transport';
import { fetchJSON, fetchResponse } from '../transport/http-client';

export const BROWSER_FRAME_CONTENT_TYPE = 'application/vnd.dorkos.browser-frame';
const ticket = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const contextSchema = z
  .object({
    localTicket: ticket.optional(),
    grant: z
      .object({
        grantId: BrowserReferenceSchema,
        revision: BrowserCounterSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
const admissionSchema = z.object({ viewer: BrowserViewerSchema, ticket }).strict();
const disconnectedSchema = z.object({}).strict();
/** Request references only. The server verifies the original actor/consent on every operation. */
export type BrowserViewerHttpContext = z.infer<typeof contextSchema>;
export type BrowserViewerHttpContextReader = () => BrowserViewerHttpContext;
const sameBinding = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);

/** Private delivery capability; its presence proves no route mount, experiment or native readiness. */
export function createBrowserViewerHttp(
  baseUrl: string,
  readContext: BrowserViewerHttpContextReader = () => ({})
): BrowserViewerTransport {
  const captureContext = readContext.bind(undefined);
  // Bounded custody, not a query cache: never evict a viewer before original cleanup settles.
  const issued = new Map<string, Readonly<{ localTicket?: string }>>();
  let outstanding = 0;
  const local = (token: string) => {
    const original = issued.get(token);
    if (!original)
      throw new Error('Browser viewer ticket was not issued by this delivery instance.');
    return original;
  };
  const disconnect = async (token: string) => {
    const original = local(token);
    disconnectedSchema.parse(
      await fetchJSON<unknown>(baseUrl, '/browser/viewers/disconnect', {
        method: 'POST',
        body: JSON.stringify({ ticket: token, ...original }),
      })
    );
    // A failed or ambiguous cleanup retains its original context and occupied slot.
    if (issued.get(token) === original) {
      issued.delete(token);
      outstanding -= 1;
    }
  };
  return Object.freeze({
    async issueBrowserViewer(bindingValue: BrowserBinding, signal: AbortSignal) {
      const binding = BrowserBindingSchema.parse(bindingValue);
      const context = contextSchema.parse(captureContext());
      if (outstanding >= 64) throw new Error('Browser viewer delivery capacity is exhausted.');
      outstanding += 1;
      let owned: string | undefined;
      try {
        const response = await fetchResponse(baseUrl, '/browser/viewers/issue', {
          method: 'POST',
          body: JSON.stringify({ binding, ...context }),
          signal,
          timeout: null,
        });
        const admitted = admissionSchema.parse(await response.json());
        if (issued.has(admitted.ticket))
          throw new Error('Browser viewer response reused an outstanding ticket.');
        owned = admitted.ticket;
        issued.set(
          owned,
          Object.freeze(
            context.localTicket === undefined ? {} : { localTicket: context.localTicket }
          )
        );
        signal.throwIfAborted();
        if (!sameBinding(binding, admitted.viewer.binding))
          throw new Error('Browser viewer response did not match the requested binding.');
        return Object.freeze({
          ticket: admitted.ticket,
          viewer: Object.freeze({
            ...admitted.viewer,
            binding: Object.freeze({ ...admitted.viewer.binding }),
          }),
        });
      } catch (first) {
        if (owned !== undefined) {
          try {
            await disconnect(owned);
          } catch {
            /* Preserve first failure; retain unresolved original cleanup custody. */
          }
        } else outstanding -= 1;
        throw first;
      }
    },
    async nextBrowserViewerFrame(
      ticketValue: string,
      receiptValue: BrowserRenderReceipt | undefined,
      signal: AbortSignal,
      observeCleanupFailure?: (reason: unknown) => void
    ) {
      const cleanupObserver = observeCleanupFailure?.bind(undefined);
      const token = ticket.parse(ticketValue);
      const receipt =
        receiptValue === undefined ? undefined : BrowserRenderReceiptSchema.parse(receiptValue);
      const response = await fetchResponse(baseUrl, '/browser/viewers/next', {
        method: 'POST',
        body: JSON.stringify({ ticket: token, receipt, ...local(token) }),
        headers: { Accept: BROWSER_FRAME_CONTENT_TYPE },
        signal,
        timeout: null,
      });
      const body = response.body;
      try {
        signal.throwIfAborted();
        if (
          response.headers.get('Content-Type')?.trim().toLowerCase() !==
            BROWSER_FRAME_CONTENT_TYPE ||
          !body
        )
          throw new Error('Browser viewer response did not contain a binary frame body.');
        // The pump owns the sole bounded reader, EOF, frame correlation and render ACK.
        return body;
      } catch (first) {
        if (body) {
          const cancel = body.cancel.bind(body);
          try {
            await cancel(first);
          } catch (cleanupFailure) {
            // Preserve the first request failure, independently reporting actual original cleanup.
            try {
              cleanupObserver?.(cleanupFailure);
            } catch {
              /* Original primary remains first. */
            }
            /* Preserve original admission/abort failure. */
          }
        }
        throw first;
      }
    },
    async disconnectBrowserViewer(ticketValue: string) {
      const token = ticket.parse(ticketValue);
      await disconnect(token);
    },
  });
}
