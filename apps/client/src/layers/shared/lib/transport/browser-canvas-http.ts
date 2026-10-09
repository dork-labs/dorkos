import { z } from 'zod';
import { BrowserGrantSchema } from '@dorkos/shared/browser-schemas';
import {
  BrowserCanvasPresentSchema,
  BrowserCanvasShareSchema,
  BrowserCanvasDeliverySchema,
  BrowserCanvasDetachSchema,
  BrowserCanvasDeliveryReceiptSchema,
  BrowserCanvasPresentReceiptSchema,
} from '@dorkos/shared/browser-canvas-schemas';
import type { BrowserCanvasTransport } from '@dorkos/shared/transport';
import { createBrowserViewerHttp, type BrowserViewerHttpContextReader } from '../browser-frame';
import { fetchJSON } from './http-client';
/** Actual authenticated HTTP commands. No canvas reference is interpreted as a grant. */
export function createBrowserCanvasHttp(
  baseUrl: string,
  readContext: BrowserViewerHttpContextReader = () => ({})
): BrowserCanvasTransport {
  const post = (kind: string, value: unknown, signal: AbortSignal) =>
    fetchJSON<unknown>(baseUrl, `/browser/canvas/${kind}`, {
      method: 'POST',
      body: JSON.stringify(value),
      signal,
    });
  const originalContext = readContext.bind(undefined);
  const transport: BrowserCanvasTransport = {
    createCanvasViewerDelivery(receipt) {
      const captured = BrowserCanvasDeliveryReceiptSchema.parse(receipt);
      return createBrowserViewerHttp(baseUrl, () => {
        const original = originalContext();
        return {
          ...(original.localTicket ? { localTicket: original.localTicket } : {}),
          ...(captured.grant ? { grant: captured.grant } : {}),
        };
      });
    },
    async presentBrowserCanvas(value, signal) {
      return BrowserCanvasPresentReceiptSchema.parse(
        await post('present', BrowserCanvasPresentSchema.parse(value), signal)
      );
    },
    async shareBrowserCanvas(value, signal) {
      return BrowserGrantSchema.parse(
        await post('share', BrowserCanvasShareSchema.parse(value), signal)
      );
    },
    async resolveBrowserCanvas(value, signal) {
      return BrowserCanvasDeliveryReceiptSchema.parse(
        await post('delivery', BrowserCanvasDeliverySchema.parse(value), signal)
      );
    },
    async detachBrowserCanvas(attachmentId, signal) {
      z.object({})
        .strict()
        .parse(await post('detach', BrowserCanvasDetachSchema.parse({ attachmentId }), signal));
    },
  };
  return Object.freeze(transport);
}
