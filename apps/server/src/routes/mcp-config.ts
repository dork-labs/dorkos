import { Router } from 'express';
import { readFile } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
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

    const mcpJsonPath = path.join(validatedPath, '.mcp.json');

    try {
      const raw = await readFile(mcpJsonPath, 'utf-8');
      const json = JSON.parse(raw) as { mcpServers?: Record<string, { type?: string }> };
      const mcpServers = json.mcpServers ?? {};

      const servers = Object.entries(mcpServers).map(([name, cfg]) => ({
        name,
        type: (cfg.type ?? 'stdio') as 'stdio' | 'sse' | 'http',
      }));

      res.json({ servers });
    } catch {
      // Missing file or malformed JSON — treat as no MCP servers configured.
      res.json({ servers: [] });
    }
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    logger.error('[mcp-config] GET / failed', { err, path: parsed.data.path });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
