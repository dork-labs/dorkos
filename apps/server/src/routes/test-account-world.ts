/**
 * `PUT /api/test/account-world` and `DELETE /api/test/account-world`: set or
 * clear the forced-limit seam's fake account world (DOR-3143), so a browser
 * suite can make one named account run out and watch a room seat move.
 *
 * Mounted only when the server runs the test runtime (`DORKOS_TEST_RUNTIME`),
 * beside the other test-control routes, and the world itself refuses to be set
 * outside it. While a world is set, test-runtime seats count as Claude Code
 * ones, so agents seeded the usual way move.
 *
 * Body for `PUT`:
 * `{ accounts: [{ id, label?, fiveHourPct?, limited? }], startAccount, force?: { accountId, at: 'turn-start' | 'after-post', resetsAt? } }`.
 * `POST /api/test/reset` clears it too.
 *
 * @module routes/test-account-world
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { env } from '../env.js';
import { setTestAccountWorld } from '../services/rooms/reseat/test-account-world.js';

const WorldSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().optional(),
        fiveHourPct: z.number().min(0).max(100).optional(),
        limited: z.boolean().optional(),
      })
    )
    .min(1),
  startAccount: z.string().min(1),
  force: z
    .object({
      accountId: z.string().min(1),
      at: z.enum(['turn-start', 'after-post']),
      resetsAt: z.string().optional(),
    })
    .optional(),
});

/**
 * The test account world routes.
 *
 * @param testMode - Whether the server runs the test runtime; the env flag unless a test says.
 */
export function createTestAccountWorldRoutes(
  testMode: boolean = env.DORKOS_TEST_RUNTIME
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.put('/', (c) => {
    // Refused before anything is read: outside the test runtime there is no world to set.
    if (!testMode) {
      return c.json(
        { error: 'The test account world is only available to the test runtime.' },
        403
      );
    }
    const parsed = WorldSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json({ error: 'Invalid account world' }, 400);
    const { force, ...rest } = parsed.data;
    try {
      setTestAccountWorld({ ...rest, ...(force ? { force } : {}) }, testMode);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 403);
    }
    return c.json({ ok: true });
  });
  router.delete('/', (c) => {
    setTestAccountWorld(null, testMode);
    return c.json({ ok: true });
  });
  return router;
}
