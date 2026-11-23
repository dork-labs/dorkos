import { Hono } from 'hono';
import { CreateTerminalRequestSchema } from '@dorkos/shared/terminal-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { registerWithSignIn } from '../http/raw-node-stream.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { boundaryProblem } from '../http/problems/boundary-refusal.js';
import { BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { TerminalLimitError, type TerminalManager } from '../services/terminal/index.js';

/**
 * Embedded-terminal REST routes (spec right-panel-workbench, Chunk E). Thin
 * handlers over {@link TerminalManager}: create a PTY and tear one down. The
 * bidirectional byte stream itself rides the WebSocket at
 * `GET /api/terminal/:id/socket`, wired separately in `terminal-websocket.ts`.
 *
 * @module routes/terminal
 */

/**
 * Build the terminal routes bound to a manager, mounted at `/api/terminal`.
 *
 * @param manager - The terminal manager owning PTY lifecycles.
 */
export function createTerminalRoutes(manager: TerminalManager): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // POST /api/terminal — spawn a PTY in a boundary-confined cwd.
  router.post('/', async (c) => {
    const parsed = CreateTerminalRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error);
    }
    try {
      // The socket attaches by this id alone, so ending the sign-in that made
      // the terminal must end it (DOR-2969); a terminal torn down first says so.
      let unregister = (): void => {};
      const id = await manager.create(parsed.data, { onDestroyed: () => unregister() });
      unregister = registerWithSignIn(c, () => manager.destroy(id), 'terminal');
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryProblem(c, err);
      if (err instanceof TerminalLimitError) {
        return problem(c, 'terminal_limit', {
          detail: 'Too many terminals are open. Close one, then try again.',
        });
      }
      logger.error('[terminal] POST / failed', { err });
      return problem(c, 'internal_error');
    }
  });

  // DELETE /api/terminal/:id — teardown (idempotent). The explicit destroy:
  // the web client calls it when a user closes a terminal tab
  // (Transport.closeTerminal, DOR-226), while unmount/refresh only detaches so
  // the PTY stays re-attachable (DOR-225). Also serves external API consumers.
  router.delete('/:id', (c) => {
    manager.destroy(c.req.param('id'));
    return c.body(null, 204);
  });

  return router;
}
