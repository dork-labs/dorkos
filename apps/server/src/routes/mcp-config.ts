import { Router } from 'express';
import { readFile } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

const router = Router();

const QuerySchema = z.object({
  path: z.string().min(1),
});

router.get('/', async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Missing required query param: path' });
  }

  try {
    const validatedPath = await validateBoundary(parsed.data.path);

    // Check all runtimes for a live status cache — first non-null result wins.
    // Runtimes that don't support live status (no getMcpStatus method) are skipped.
    for (const runtime of runtimeRegistry.listRuntimes()) {
      const liveStatus = runtime.getMcpStatus?.(validatedPath);
      if (liveStatus) {
        return res.json({ servers: liveStatus });
      }
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
    throw err;
  }
});

export default router;
