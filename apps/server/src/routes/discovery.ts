/**
 * Discovery routes — SSE-streamed filesystem scanning for AI-configured projects.
 *
 * @module routes/discovery
 */
import { Router } from 'express';
import { z } from 'zod';
import { scanForAgents } from '../services/discovery/discovery-scanner.js';
import { parseBody } from '../lib/route-utils.js';
import { isWithinBoundary } from '../lib/boundary.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';

/** Zod schema for the POST /scan request body. */
const ScanRequestSchema = z.object({
  root: z.string().optional(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  timeout: z.number().int().min(1000).max(60000).optional(),
});

/**
 * Create the Discovery router with the SSE scan endpoint.
 */
export function createDiscoveryRouter(): Router {
  const router = Router();

  router.post('/scan', async (req, res) => {
    const data = parseBody(ScanRequestSchema, req.body, res);
    if (!data) return;

    // Validate root against directory boundary if provided
    if (data.root) {
      const withinBoundary = await isWithinBoundary(data.root);
      if (!withinBoundary) {
        return res.status(403).json({ error: 'Root path outside directory boundary' });
      }
    }

    // Set up SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      for await (const event of scanForAgents({
        root: data.root ?? DEFAULT_CWD,
        maxDepth: data.maxDepth,
        timeout: data.timeout,
      })) {
        if (res.writableEnded) break;
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
    } catch (err) {
      if (!res.writableEnded) {
        const message = err instanceof Error ? err.message : 'Scan failed';
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}
