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
import { z } from 'zod';
import path from 'path';
import { ulid } from 'ulidx';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import { ResolveAgentsRequestSchema, CreateAgentRequestSchema } from '@dorkos/shared/mesh-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import {
  buildSoulContent,
  defaultSoulTemplate,
  defaultNopeTemplate,
} from '@dorkos/shared/convention-files';
import { readConventionFile, writeConventionFile } from '@dorkos/shared/convention-files-io';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { validateBoundaryOrDorkHome, BoundaryError } from '../lib/boundary.js';
import { createAgentWorkspace, AgentCreationError } from '../services/core/agent-creator.js';
import { updateAgentManifest, AgentUpdateError } from '../services/core/operator/agent-updater.js';
import { notifyAgentCreated } from '../services/core/agent-created-hook.js';
import { logger } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';

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
  // Returns the agent manifest for the given directory, or null
  router.get('/current', async (req, res) => {
    try {
      const rawPath = req.query.path as string;
      if (!rawPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      const agentPath = await validateBoundaryOrDorkHome(rawPath);
      const manifest = await readManifest(agentPath);
      if (!manifest) {
        return res.json(null);
      }

      // Include convention file contents alongside manifest data
      const soulContent = await readConventionFile(agentPath, 'SOUL.md');
      const nopeContent = await readConventionFile(agentPath, 'NOPE.md');

      return res.json({ ...manifest, soulContent, nopeContent });
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
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(result.error) });
      }
      const agents: Record<string, AgentManifest | null> = {};
      await Promise.all(
        result.data.paths.map(async (p) => {
          try {
            const resolvedP = await validateBoundaryOrDorkHome(p);
            agents[p] = await readManifest(resolvedP);
          } catch {
            agents[p] = null;
          }
        })
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
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(result.error) });
      }
      const { path: rawAgentPath, name, description, runtime } = result.data;
      const agentPath = await validateBoundaryOrDorkHome(rawAgentPath);

      // Check if agent already exists
      const existing = await readManifest(agentPath);
      if (existing) {
        return res
          .status(409)
          .json({ error: 'Agent already exists at this path', agent: existing });
      }

      const manifest: AgentManifest = {
        id: ulid(),
        name: name ?? path.basename(agentPath),
        description: description ?? '',
        runtime: runtime ?? 'claude-code',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: new Date().toISOString(),
        registeredBy: 'dorkos-ui',
        personaEnabled: true,
        isSystem: false,
        enabledToolGroups: {},
      };

      await writeManifest(agentPath, manifest);

      // Scaffold convention files with sensible defaults
      const traitBlock = renderTraits(DEFAULT_TRAITS);
      const soulContent = defaultSoulTemplate(manifest.name ?? 'agent', traitBlock);
      const nopeContent = defaultNopeTemplate();

      await writeConventionFile(agentPath, 'SOUL.md', soulContent);
      await writeConventionFile(agentPath, 'NOPE.md', nopeContent);

      // ADR-0043: sync to Mesh DB cache (best-effort)
      try {
        await meshCore?.syncFromDisk(agentPath);
      } catch {
        /* non-fatal */
      }

      // Fire-and-forget activity event for agent registration
      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'agent',
          eventType: 'agent.registered',
          resourceType: 'agent',
          resourceId: manifest.id,
          resourceLabel: manifest.name,
          summary: `Registered agent ${manifest.name}`,
          linkPath: '/agents',
        });
      }

      // The agent-created seam: this register path writes the manifest itself
      // (it does not go through `createAgentWorkspace`), so it must notify the
      // seam directly. Awaited, but never throws — a failing reaction (e.g.
      // Shape schedule re-bind) never turns a successful registration into a 500.
      await notifyAgentCreated({
        id: manifest.id,
        name: manifest.name,
        displayName: manifest.displayName,
      });

      return res.status(201).json(manifest);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] POST / failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents/create
  // Full creation pipeline: mkdir + scaffold + optional template + register
  router.post('/create', async (req, res) => {
    try {
      const result = await createAgentWorkspace(req.body, meshCore);

      // Fire-and-forget activity event for agent registration
      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'agent',
          eventType: 'agent.registered',
          resourceType: 'agent',
          resourceId: result.manifest.id,
          resourceLabel: result.manifest.name,
          summary: `Registered agent ${result.manifest.name}`,
          linkPath: '/agents',
        });
      }

      // (The agent-created seam already fired inside `createAgentWorkspace` —
      // no extra notify here.)
      return res.status(201).json({
        ...result.manifest,
        _path: result.path,
        ...(result.meta ? { _meta: result.meta } : {}),
      });
    } catch (err) {
      if (err instanceof AgentCreationError) {
        if (err.code === 'VALIDATION') {
          return res.status(400).json({ error: 'Validation failed', details: err.message });
        }
        if (err.code === 'BOUNDARY') {
          return res.status(403).json({ error: err.message, code: 'OUTSIDE_BOUNDARY' });
        }
        return res.status(err.statusCode).json({ error: err.message });
      }
      logger.error('[agents] POST /create failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/agents/current?path=/path/to/project
  // Update agent fields by path
  router.patch('/current', async (req, res) => {
    try {
      const rawPath = req.query.path as string;
      if (!rawPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      const agentPath = await validateBoundaryOrDorkHome(rawPath);

      // Manifest guards + write live in the shared agent-updater service so the
      // `update_agent` MCP tool enforces the exact same rules (ADR-0043 sync
      // included) without re-implementing them.
      const updated = await updateAgentManifest({ agentPath, body: req.body, meshCore });
      return res.json(updated);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      if (err instanceof AgentUpdateError) {
        switch (err.code) {
          case 'VALIDATION':
            return res.status(400).json({ error: 'Validation failed', details: err.details });
          case 'NOT_FOUND':
            return res.status(404).json({ error: err.message });
          case 'IMMUTABLE_NAME':
            return res.status(400).json({ error: err.message });
          case 'SYSTEM_PROTECTED':
            return res.status(403).json({ error: err.message });
        }
      }
      logger.error('[agents] PATCH /current failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents/current/migrate-persona?path=/path/to/project
  // Migrates legacy persona field to SOUL.md convention file
  router.post('/current/migrate-persona', async (req, res) => {
    try {
      const rawPath = req.query.path as string;
      if (!rawPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      const agentPath = await validateBoundaryOrDorkHome(rawPath);

      const manifest = await readManifest(agentPath);
      if (!manifest) {
        return res.status(404).json({ error: 'No agent registered at this path' });
      }

      // Check if already migrated
      const existingSoul = await readConventionFile(agentPath, 'SOUL.md');
      if (existingSoul) {
        return res.json({ migrated: false, reason: 'SOUL.md already exists' });
      }

      const { persona } = manifest as { persona?: string };
      if (!persona) {
        return res.json({ migrated: false, reason: 'No persona to migrate' });
      }

      // Migrate persona text to SOUL.md custom prose
      const traits = (manifest as { traits?: Record<string, number> }).traits;
      const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
      const soulContent = buildSoulContent(traitBlock, persona);
      await writeConventionFile(agentPath, 'SOUL.md', soulContent);

      // Scaffold NOPE.md if missing
      const existingNope = await readConventionFile(agentPath, 'NOPE.md');
      if (!existingNope) {
        await writeConventionFile(agentPath, 'NOPE.md', defaultNopeTemplate());
      }

      return res.json({ migrated: true });
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] POST /current/migrate-persona failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
