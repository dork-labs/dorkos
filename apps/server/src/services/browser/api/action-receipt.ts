import { BrowserActionReceiptSchema, BrowserErrorSchema } from '@dorkos/shared/browser-schemas';

/** Preserve the original engine outcome while projecting its private action envelope
 * into the public receipt. In particular, uncertain side effects never become success. */
export function projectBrowserActionReceipt(value: unknown) {
  if (!value || typeof value !== 'object')
    throw new Error('Original input returned no action result.');
  const { kind, ...receipt } = value as Record<string, unknown>;
  if (kind !== 'action') throw new Error('Original input returned a non-action result.');
  if (receipt.outcome === 'completed') return BrowserActionReceiptSchema.parse(receipt);
  return BrowserActionReceiptSchema.parse({
    ...receipt,
    reason: BrowserErrorSchema.parse({ version: 1, reason: receipt.reason }),
  });
}
