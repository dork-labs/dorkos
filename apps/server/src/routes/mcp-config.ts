import { Router } from 'express';
import { z } from 'zod';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { readMcpJsonServers, summarizeMcpJsonServers } from '../services/mesh/mcp-json.js';
import { logger } from '../lib/logger.js';

const router = Router();

const QuerySchema = z.object({
  path: z.string().min(1),
  runtime: z.string().min(1).optional(),
});

router.get('/', async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Missing required query param: path' });
  }

  const runtimeParam = parsed.data.runtime;
  if (runtimeParam !== undefined && !runtimeRegistry.has(runtimeParam)) {
    return res.status(400).json({ error: `Unknown runtime: ${runtimeParam}` });
  }

  try {
    const validatedPath = await validateBoundary(parsed.data.path);

    // Resolve the SPECIFIC runtime the caller asked about — never the first
    // runtime that happens to have a cache for this cwd. A Codex session and a
    // Claude session can share a working directory; returning Claude's cached
    // servers for a Codex request (the old "first non-null across all runtimes"
    // loop) mislabels the Agent Profile.
    const runtime = runtimeParam ? runtimeRegistry.get(runtimeParam) : runtimeRegistry.getDefault();

    const liveStatus = runtime.getMcpStatus?.(validatedPath);
    if (liveStatus) {
      return res.json({ servers: liveStatus });
    }

    // The `.mcp.json` fallback is a Claude Code artifact — its format is
    // Claude-specific. Only fall back for the claude-code runtime; any other
    // runtime with no live status honestly reports no MCP servers.
    if (runtime.type !== 'claude-code') {
      return res.json({ servers: [] });
    }

    const mcpServers = await readMcpJsonServers(validatedPath);
    res.json({ servers: summarizeMcpJsonServers(mcpServers) });
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[mcp-config] GET / failed', { err, path: parsed.data.path });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
