/**
 * `POST /api/test/heartbeat/beat` — ask the real beat runner for one beat of
 * an agent, now, and answer once it has finished.
 *
 * **Why this seam exists.** A timed beat's first fire is one to five minutes
 * after the server starts, and the fastest pace an agent may ask for is five
 * minutes (`beat-scheduler.ts`), so a seeded install (the video team's demo
 * workspace, `apps/e2e/capture/demo/`) cannot wait for a run of beats.
 * Everything after the trigger is the production path: the runner reads the
 * agent's `HEARTBEAT.md`, gathers, triages, starts a turn on the agent's
 * runtime when there is work, records the beat and delivers its raises. Only
 * the clock is skipped, as the runner's own timer does when it fires.
 *
 * Hung under `/api/test` only in test mode (`startup/runtimes.ts`), through
 * `addTestControlGroup`, so the path does not exist in production.
 *
 * @module routes/test-heartbeat
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { validationFailureBody } from '../lib/route-utils.js';
import { runningHeartbeats } from '../services/heartbeats/heartbeats-wiring.js';

const BeatRequestSchema = z.object({ agentId: z.string().min(1) });

/**
 * Build the routes, mounted at `/api/test/heartbeat`.
 *
 * @returns The routes.
 */
export function createTestHeartbeatRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/beat', async (c) => {
    const parsed = BeatRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const heartbeats = runningHeartbeats();
    if (!heartbeats) {
      return c.json({ error: 'Heartbeats are not running on this server.' }, 503);
    }
    // The wake the runner's own timer sends. It answers when the beat,
    // including any turn, has finished; a paused agent, one whose runtime is
    // not registered, or one already beating gets no new beat.
    await heartbeats.runner.wake(parsed.data.agentId, { wake: 'timer' });
    return c.json({ ok: true });
  });
  return router;
}
