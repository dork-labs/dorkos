import type { Hono } from 'hono';
import { z } from 'zod';
import { DeliveryReceiptGate } from '../delivery-receipt-gate.js';

const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('arm'), channelId: z.string().uuid() }),
  z.strictObject({ action: z.literal('release') }),
  z.strictObject({ action: z.literal('reset') }),
]);

/** Register test-runtime-only controls. This router is never mounted in production. */
export function registerCommunityTestControlRoutes(app: Hono, gate: DeliveryReceiptGate): void {
  app.get('/api/test/delivery-receipt-gate', (c) => c.json(gate.observation()));
  app.post('/api/test/delivery-receipt-gate', async (c) => {
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Use a valid delivery gate action.' }, 400);
    try {
      const state =
        parsed.data.action === 'arm'
          ? gate.arm(parsed.data.channelId)
          : parsed.data.action === 'release'
            ? gate.release()
            : gate.reset();
      return c.json(state);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Delivery gate unavailable.' },
        409
      );
    }
  });
}
