/**
 * Discovery routes — SSE-streamed filesystem scanning for AI-configured projects.
 *
 * Delegates to `meshCore.discover()` (unified scanner) and streams results as SSE.
 *
 * @module routes/discovery
 */
import { Router } from 'express';
import { z } from 'zod';
import type { MeshCore } from '@dorkos/mesh';
import type { ExistingAgent } from '@dorkos/shared/mesh-schemas';
import { parseBody } from '../lib/route-utils.js';
import { isWithinBoundary, getBoundary } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

/** Zod schema for the POST /scan request body. */
const ScanRequestSchema = z.object({
  root: z.string().optional(),
  roots: z.array(z.string()).optional(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  timeout: z.number().int().min(1000).max(120000).optional(),
});

/**
 * Create the Discovery router with the SSE scan endpoint.
 *
 * @param meshCore - MeshCore instance for delegating discovery scans
 */
export function createDiscoveryRouter(meshCore: MeshCore): Router {
  const router = Router();

  router.post('/scan', async (req, res) => {
    const data = parseBody(ScanRequestSchema, req.body, res);
    if (!data) return;

    // Default to boundary (home dir) instead of DEFAULT_CWD
    const roots =
      data.roots && data.roots.length > 0 ? data.roots : data.root ? [data.root] : [getBoundary()];

    logger.info('[Discovery] Scan starting', {
      roots,
      maxDepth: data.maxDepth ?? 5,
      timeout: data.timeout ?? 30000,
    });

    // Validate each root against boundary
    for (const root of roots) {
      const withinBoundary = await isWithinBoundary(root);
      if (!withinBoundary) {
        logger.warn('[Discovery] Root rejected — outside boundary', { root });
        return res.status(403).json({ error: `Root path outside directory boundary` });
      }
    }

    // Set up SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const startMs = Date.now();
    let candidateCount = 0;
    let autoImportCount = 0;

    try {
      for await (const event of meshCore.discover(roots, {
        maxDepth: data.maxDepth,
        timeout: data.timeout,
      })) {
        if (res.writableEnded) break;

        if (event.type === 'auto-import') {
          // Surface auto-imported agents as 'existing-agent' events so onboarding
          // can display them. The client doesn't need the full manifest — just
          // enough to render a summary card.
          autoImportCount++;
          const { manifest, path: agentPath } = event.data;
          const existing: ExistingAgent = {
            path: agentPath,
            name: manifest.name,
            runtime: manifest.runtime,
            description: manifest.description ?? '',
          };
          logger.debug('[Discovery] Auto-imported agent surfaced as existing-agent', {
            path: agentPath,
            name: manifest.name,
          });
          res.write(`event: existing-agent\n`);
          res.write(`data: ${JSON.stringify(existing)}\n\n`);
          continue;
        }

        if (event.type === 'candidate') {
          candidateCount++;
          logger.debug('[Discovery] Candidate found', {
            path: event.data.path,
            strategy: event.data.strategy,
          });
        }

        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scan failed';
      logger.error('[Discovery] Scan error', { error: message });
      if (!res.writableEnded) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      }
    } finally {
      const elapsedMs = Date.now() - startMs;
      logger.info('[Discovery] Scan complete', {
        elapsedMs,
        candidateCount,
        autoImportCount,
        roots,
      });
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}
