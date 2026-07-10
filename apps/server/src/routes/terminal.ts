import { Router } from 'express';
import { z } from 'zod';
import { CreateTerminalRequestSchema } from '@dorkos/shared/terminal-schemas';
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
 * Build the terminal router bound to a manager.
 *
 * @param manager - The terminal manager owning PTY lifecycles.
 */
export function createTerminalRouter(manager: TerminalManager): Router {
  const router = Router();

  // POST /api/terminal — spawn a PTY in a boundary-confined cwd.
  router.post('/', async (req, res) => {
    const parsed = CreateTerminalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(parsed.error) });
    }
    try {
      const id = await manager.create(parsed.data);
      res.status(201).json({ id });
    } catch (err) {
      if (err instanceof BoundaryError) {
        const status = err.code === 'NULL_BYTE' ? 400 : 403;
        return res.status(status).json({ error: err.message, code: err.code });
      }
      if (err instanceof TerminalLimitError) {
        return res.status(429).json({ error: err.message, code: 'TERMINAL_LIMIT' });
      }
      logger.error('[terminal] POST / failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/terminal/:id — teardown (idempotent). The explicit destroy:
  // the web client calls it when a user closes a terminal tab
  // (Transport.closeTerminal, DOR-226), while unmount/refresh only detaches so
  // the PTY stays re-attachable (DOR-225). Also serves external API consumers.
  router.delete('/:id', (req, res) => {
    manager.destroy(req.params.id);
    res.status(204).end();
  });

  return router;
}
