/**
 * Mesh agent discovery and registry routes — discover agents, manage registrations,
 * maintain the denial list, and query network topology.
 *
 * @module routes/mesh
 */
import { Router } from 'express';
import type { MeshCore } from '@dorkos/mesh';
import {
  DiscoverRequestSchema,
  RegisterAgentRequestSchema,
  DenyRequestSchema,
  UpdateAgentRequestSchema,
  AgentListQuerySchema,
  HeartbeatRequestSchema,
  UpdateAccessRuleRequestSchema,
} from '@dorkos/shared/mesh-schemas';

/**
 * Create the Mesh router with discovery, registration, and denial endpoints.
 *
 * @param meshCore - The MeshCore instance for agent lifecycle operations
 */
export function createMeshRouter(meshCore: MeshCore): Router {
  const router = Router();

  // POST /discover — Scan directories for agent candidates
  router.post('/discover', async (req, res) => {
    const result = DiscoverRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    try {
      const candidates = [];
      const options = result.data.maxDepth ? { maxDepth: result.data.maxDepth } : undefined;
      for await (const candidate of meshCore.discover(result.data.roots, options)) {
        candidates.push(candidate);
      }
      return res.json({ candidates });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Discovery failed';
      return res.status(500).json({ error: message });
    }
  });

  // POST /agents — Register an agent by path
  router.post('/agents', async (req, res) => {
    const result = RegisterAgentRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }

    const { path: projectPath, overrides, approver } = result.data;

    // registerByPath requires name and runtime
    const name = overrides?.name;
    const runtime = overrides?.runtime;
    if (!name || !runtime) {
      return res
        .status(400)
        .json({ error: 'overrides.name and overrides.runtime are required for manual registration' });
    }

    try {
      const manifest = await meshCore.registerByPath(
        projectPath,
        { ...overrides, name, runtime },
        approver,
      );
      return res.status(201).json(manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      return res.status(422).json({ error: message });
    }
  });

  // GET /topology — Query the mesh network topology with optional namespace filtering
  router.get('/topology', (req, res) => {
    const namespace = (req.query.namespace as string) ?? '*';
    const topology = meshCore.getTopology(namespace);
    return res.json(topology);
  });

  // PUT /topology/access — Create or remove cross-namespace access rules
  router.put('/topology/access', (req, res) => {
    const result = UpdateAccessRuleRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { sourceNamespace, targetNamespace, action } = result.data;
    if (action === 'allow') {
      meshCore.allowCrossNamespace(sourceNamespace, targetNamespace);
    } else {
      meshCore.denyCrossNamespace(sourceNamespace, targetNamespace);
    }
    return res.json({ success: true });
  });

  // GET /status — Aggregate mesh health status
  router.get('/status', (_req, res) => {
    const status = meshCore.getStatus();
    res.json(status);
  });

  // GET /agents — List agents with optional filters
  router.get('/agents', (req, res) => {
    const result = AgentListQuerySchema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const agents = meshCore.list(result.data);
    return res.json({ agents });
  });

  // GET /agents/:id/access — Get reachable agents for a specific agent
  // MUST come before GET /agents/:id to avoid being swallowed by the param route
  router.get('/agents/:id/access', (req, res) => {
    const agents = meshCore.getAgentAccess(req.params.id);
    if (!agents) return res.status(404).json({ error: 'Agent not found' });
    return res.json({ agents });
  });

  // GET /agents/:id/health — Health snapshot for a single agent
  // MUST come before GET /agents/:id to avoid being swallowed by the param route
  router.get('/agents/:id/health', (req, res) => {
    const health = meshCore.getAgentHealth(req.params.id);
    if (!health) return res.status(404).json({ error: 'Agent not found' });
    return res.json(health);
  });

  // POST /agents/:id/heartbeat — Record a heartbeat for an agent
  router.post('/agents/:id/heartbeat', (req, res) => {
    const parsed = HeartbeatRequestSchema.safeParse(req.body ?? {});
    const event = parsed.success ? (parsed.data.event ?? 'heartbeat') : 'heartbeat';
    const health = meshCore.getAgentHealth(req.params.id);
    if (!health) return res.status(404).json({ error: 'Agent not found' });
    meshCore.updateLastSeen(req.params.id, event);
    return res.json({ success: true });
  });

  // GET /agents/:id — Get single agent
  router.get('/agents/:id', (req, res) => {
    const agent = meshCore.get(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(agent);
  });

  // PATCH /agents/:id — Update agent fields
  router.patch('/agents/:id', (req, res) => {
    const result = UpdateAgentRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const updated = meshCore.update(req.params.id, result.data);
    if (!updated) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(updated);
  });

  // DELETE /agents/:id — Unregister agent
  router.delete('/agents/:id', async (req, res) => {
    const agent = meshCore.get(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    await meshCore.unregister(req.params.id);
    return res.json({ success: true });
  });

  // POST /deny — Deny a candidate path
  router.post('/deny', async (req, res) => {
    const result = DenyRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    try {
      await meshCore.deny(result.data.path, result.data.reason, result.data.denier);
      return res.status(201).json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Denial failed';
      return res.status(422).json({ error: message });
    }
  });

  // GET /denied — List all denial records
  router.get('/denied', (_req, res) => {
    const denied = meshCore.listDenied();
    return res.json({ denied });
  });

  // DELETE /denied/:encodedPath — Clear a denial by URL-encoded path
  router.delete('/denied/:encodedPath', async (req, res) => {
    const filePath = decodeURIComponent(req.params.encodedPath);
    await meshCore.undeny(filePath);
    return res.json({ success: true });
  });

  return router;
}
