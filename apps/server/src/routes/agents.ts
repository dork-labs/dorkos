/**
 * Agent identity routes -- always available, independent of Mesh.
 *
 * Provides CRUD for `.dork/agent.json` files via the shared manifest module.
 * All path parameters are boundary-validated.
 *
 * ADR-0043: when MeshCore is provided, POST and PATCH handlers call
 * `meshCore.syncFromDisk()` after writing the manifest to keep the
 * Mesh DB cache in sync without waiting for the 5-min reconciler.
 *
 * @module routes/agents
 */
import { Router } from 'express';
import path from 'path';
import { ulid } from 'ulidx';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import {
  ResolveAgentsRequestSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
} from '@dorkos/shared/mesh-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';

/** Minimal MeshCore interface for sync-on-write. */
interface MeshCoreLike {
  syncFromDisk(projectPath: string): Promise<boolean>;
}

/**
 * Create the agents router for agent identity CRUD.
 *
 * @param meshCore - Optional MeshCore instance for DB sync after writes
 * @returns Express Router with agent identity endpoints
 */
export function createAgentsRouter(meshCore?: MeshCoreLike): Router {
  const router = Router();

  // GET /api/agents/current?path=/path/to/project
  // Returns the agent manifest for the given directory, or 404
  router.get('/current', async (req, res) => {
    try {
      const agentPath = req.query.path as string;
      if (!agentPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      await validateBoundary(agentPath);
      const manifest = await readManifest(agentPath);
      if (!manifest) {
        return res.status(404).json({ error: 'No agent registered at this path' });
      }
      return res.json(manifest);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] GET /current failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents/resolve
  // Batch resolve agents for multiple paths (avoids N+1 in DirectoryPicker)
  router.post('/resolve', async (req, res) => {
    try {
      const result = ResolveAgentsRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }
      const agents: Record<string, AgentManifest | null> = {};
      await Promise.all(
        result.data.paths.map(async (p) => {
          try {
            await validateBoundary(p);
            agents[p] = await readManifest(p);
          } catch {
            agents[p] = null;
          }
        }),
      );
      return res.json({ agents });
    } catch (err) {
      logger.error('[agents] POST /resolve failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents
  // Create a new agent (writes .dork/agent.json)
  router.post('/', async (req, res) => {
    try {
      const result = CreateAgentRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }
      const { path: agentPath, name, description, runtime } = result.data;
      await validateBoundary(agentPath);

      // Check if agent already exists
      const existing = await readManifest(agentPath);
      if (existing) {
        return res.status(409).json({ error: 'Agent already exists at this path', agent: existing });
      }

      const manifest: AgentManifest = {
        id: ulid(),
        name: name ?? path.basename(agentPath),
        description: description ?? '',
        runtime: runtime ?? 'claude-code',
        capabilities: [],
        behavior: { responseMode: 'always' },
        budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
        registeredAt: new Date().toISOString(),
        registeredBy: 'dorkos-ui',
        personaEnabled: true,
        enabledToolGroups: {},
      };

      await writeManifest(agentPath, manifest);

      // ADR-0043: sync to Mesh DB cache (best-effort)
      try { await meshCore?.syncFromDisk(agentPath); } catch { /* non-fatal */ }

      return res.status(201).json(manifest);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] POST / failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/agents/current?path=/path/to/project
  // Update agent fields by path
  router.patch('/current', async (req, res) => {
    try {
      const agentPath = req.query.path as string;
      if (!agentPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      await validateBoundary(agentPath);

      const result = UpdateAgentRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
      }

      const existing = await readManifest(agentPath);
      if (!existing) {
        return res.status(404).json({ error: 'No agent registered at this path' });
      }

      const updated: AgentManifest = { ...existing, ...result.data };
      await writeManifest(agentPath, updated);

      // ADR-0043: sync to Mesh DB cache (best-effort)
      try { await meshCore?.syncFromDisk(agentPath); } catch { /* non-fatal */ }

      return res.json(updated);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] PATCH /current failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
