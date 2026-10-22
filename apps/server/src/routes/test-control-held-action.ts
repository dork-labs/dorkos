/**
 * `POST /api/test/held-action/start` — put one held connected-app action in
 * the Inbox, waiting with its Cancel, for the demo workspace's screenshots
 * (`apps/e2e/capture/demo/seed.ts`).
 *
 * The hold is a real one, on the server's own {@link DestructiveHoldService}:
 * the same `held` line, the same waiting row and phone push, and the real
 * Cancel route ends it. What it never has is an action behind it. No
 * connected app is called and no tool call waits on it, so its ending sends
 * nothing: a cancel records that it was cancelled, and a window that runs out
 * is refused (`refuse`), never released. Its window is long (an hour by
 * default) so the row stays for a whole recording.
 *
 * Test mode only: registered with `addTestControlGroup` on a test-mode server,
 * so the path is the `/api` 404 everywhere else. The requester must be an
 * agent registered here, named the way the registry names it, the same check
 * `/api/test/agent-token` makes.
 *
 * @module routes/test-control-held-action
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { validationFailureBody } from '../lib/route-utils.js';
import type { DestructiveHoldService } from '../services/connectors/execution/destructive-hold.js';
import { addTestControlGroup } from './test-control.js';

/** The longest window a demo hold may ask for: six hours, well inside a timer's range. */
const MAX_DEMO_HOLD_MS = 6 * 60 * 60 * 1000;

/** A demo hold's default window: an hour, longer than any recording. */
const DEFAULT_DEMO_HOLD_MS = 60 * 60 * 1000;

const StartSchema = z
  .object({
    agentPath: z.string().min(1),
    sessionId: z.string().min(1).max(200),
    actionName: z.string().min(1).max(200),
    serviceName: z.string().min(1).max(100),
    holdMs: z.number().int().positive().max(MAX_DEMO_HOLD_MS).optional(),
  })
  .strict();

/** What the demo hold route reads from the running server. */
export interface TestHeldActionDeps {
  /** The server's one hold service, so the real Cancel route reaches the hold. */
  holds: Pick<DestructiveHoldService, 'start' | 'refuse'>;
  /** The registered agent at a folder, with its Mesh id and name. */
  agentAt: (agentPath: string) => { id?: string; name: string; displayName?: string } | undefined;
}

/**
 * Build the test-only demo hold route.
 *
 * @param deps - The hold service and the agent registry.
 */
export function createTestHeldActionRoutes(deps: TestHeldActionDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/start', async (c) => {
    const parsed = StartSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const { agentPath, sessionId, actionName, serviceName, holdMs } = parsed.data;
    const agent = deps.agentAt(agentPath);
    if (!agent) return c.json({ error: `No agent is registered at ${agentPath}.` }, 404);
    const started = await deps.holds.start({
      requester: {
        agentPath,
        ...(agent.id ? { agentId: agent.id } : {}),
        name: agent.displayName || agent.name,
        sessionId,
      },
      action: { actionName, serviceName },
      holdMs: holdMs ?? DEFAULT_DEMO_HOLD_MS,
    });
    if (!started) return c.json({ error: 'The hold could not be recorded or announced.' }, 503);
    // Nothing waits to run it. A window that runs out ends unexecuted.
    void started.ended.then((end) => {
      if (end.outcome === 'elapsed') deps.holds.refuse(started.holdId);
    });
    return c.json({ holdId: started.holdId }, 201);
  });
  return router;
}

/**
 * Hang the demo hold route under `/api/test/held-action`, on a test-mode
 * server only. Anywhere else it adds nothing, and `/api/test` is not mounted
 * at all (`http/hono-api.ts`), so the path is the `/api` 404.
 *
 * @param testRuntime - Whether this server runs in test mode (`DORKOS_TEST_RUNTIME`).
 * @param deps - The hold service and the agent registry.
 * @returns Whether the route was added.
 */
export function registerTestHeldActionGroup(
  testRuntime: boolean,
  deps: TestHeldActionDeps
): boolean {
  if (!testRuntime) return false;
  addTestControlGroup('/held-action', createTestHeldActionRoutes(deps));
  return true;
}
