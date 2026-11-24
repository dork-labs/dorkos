/**
 * The MCP servers an agent folder has (`GET /api/mcp-config`), as its runtime
 * reports them live, or from its `.mcp.json` for Claude Code.
 *
 * @module routes/mcp-config
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readQuery } from '../http/request-query.js';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { readMcpJsonServers, summarizeMcpJsonServers } from '../services/mesh/mcp-json.js';
import { logger } from '../lib/logger.js';
import { problem, validationProblem } from '@dorkos/http-kit';

const router = new Hono<ApiEnv>();

const QuerySchema = z.object({
  path: z.string().min(1),
  runtime: z.string().min(1).optional(),
});

router.get('/', async (c) => {
  const parsed = QuerySchema.safeParse(readQuery(c));
  if (!parsed.success) {
    return validationProblem(c, parsed.error, { detail: 'Send the folder as `path`.' });
  }

  const runtimeParam = parsed.data.runtime;
  if (runtimeParam !== undefined && !runtimeRegistry.has(runtimeParam)) {
    return problem(c, 'invalid_request', { detail: 'There is no runtime by that name.' });
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
      return c.json({ servers: liveStatus });
    }

    // The `.mcp.json` fallback is a Claude Code artifact — its format is
    // Claude-specific. Only fall back for the claude-code runtime; any other
    // runtime with no live status honestly reports no MCP servers.
    if (runtime.type !== 'claude-code') {
      return c.json({ servers: [] });
    }

    const mcpServers = await readMcpJsonServers(validatedPath);
    return c.json({ servers: summarizeMcpJsonServers(mcpServers) });
  } catch (err) {
    if (err instanceof BoundaryError) {
      if (err.code === 'OUTSIDE_BOUNDARY') {
        return problem(c, 'outside_boundary', { detail: 'Pick a folder DorkOS may use.' });
      }
      if (err.code === 'NULL_BYTE') {
        return problem(c, 'invalid_request', {
          detail: 'That path has a character paths can’t hold.',
        });
      }
      return problem(c, 'forbidden', { detail: "DorkOS can't read that folder." });
    }
    logger.error('[mcp-config] GET / failed', { err, path: parsed.data.path });
    return problem(c, 'internal_error', { detail: "Couldn't read this folder's MCP servers." });
  }
});

export default router;
