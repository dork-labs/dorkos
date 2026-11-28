/**
 * Discovery routes — `POST /api/discovery/scans`, the one folder scan for
 * agents (DOR-4982), documented in `services/core/openapi/discovery-scan-openapi.ts`.
 *
 * Delegates to `meshCore.discover()` (unified scanner) and streams results as SSE,
 * written to the raw Node response (`http/raw-node-stream.ts`) so each event
 * leaves as it is found.
 *
 * @module routes/discovery
 */
import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import type { z } from 'zod';
import type { MeshCore } from '@dorkos/mesh';
import type { ExistingAgent } from '@dorkos/shared/mesh-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import { isWithinBoundary, getBoundary } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { createScanBrowserWarner } from '../services/browser/agent-browser-lint.js';
import { DiscoveryScanRequestSchema as ScanRequestSchema } from '../services/core/openapi/discovery-scan-openapi.js';

/**
 * Create the Discovery routes with the SSE scan endpoint.
 *
 * @param meshCore - MeshCore instance for delegating discovery scans
 * @returns The routes, to mount at `/api/discovery`.
 */
export function createDiscoveryRoutes(meshCore: MeshCore): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/scans', async (c) => {
    const parsed = ScanRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return validationProblem(c, parsed.error);
    const data = parsed.data;

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
        return problem(c, 'outside_boundary', {
          detail: 'Pick a folder inside the ones DorkOS may use.',
        });
      }
    }

    return streamToNodeResponse(c, (res, { signal }) =>
      streamScan(meshCore, res, signal, roots, data)
    );
  });

  return router;
}

/** Write one scan to `res` as an event stream, and end it. */
async function streamScan(
  meshCore: MeshCore,
  res: ServerResponse,
  signal: AbortSignal,
  roots: string[],
  data: z.infer<typeof ScanRequestSchema>
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const startMs = Date.now();
  let candidateCount = 0;
  let autoImportCount = 0;
  // A folder the scan finds may hold a browser server outside DorkOS's guard (DOR-3957).
  const warnBrowsers = createScanBrowserWarner(logger);

  try {
    for await (const event of meshCore.discover(roots, {
      maxDepth: data.maxDepth,
      timeout: data.timeout,
    })) {
      // Nobody is reading any more: stop walking the disk for them.
      if (res.writableEnded || signal.aborted) break;

      if (event.type === 'auto-import') {
        // Surface auto-imported agents as 'existing-agent' events so onboarding
        // can display them. The client doesn't need the full manifest — just
        // enough to render a summary card.
        autoImportCount++;
        const { manifest, path: agentPath } = event.data;
        warnBrowsers(agentPath);
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
        warnBrowsers(event.data.path);
        logger.debug('[Discovery] Candidate found', {
          path: event.data.path,
          strategy: event.data.strategy,
        });
      }

      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    }
  } catch (err) {
    logger.error('[Discovery] Scan error', { err });
    if (!res.writableEnded) {
      // A fixed sentence: the error's own text stays in the log.
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: 'The scan stopped early. Try again.' })}\n\n`);
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
}
