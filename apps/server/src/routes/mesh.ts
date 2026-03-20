/**
 * Mesh agent discovery and registry routes — discover agents, manage registrations,
 * maintain the denial list, and query network topology.
 *
 * @module routes/mesh
 */
import { Router } from 'express';
import type { MeshCore } from '@dorkos/mesh';
import type { AgentManifest, AgentHealthStatus, TopologyView } from '@dorkos/shared/mesh-schemas';
import {
  DiscoverRequestSchema,
  RegisterAgentRequestSchema,
  DenyRequestSchema,
  UpdateAgentRequestSchema,
  AgentListQuerySchema,
  HeartbeatRequestSchema,
  UpdateAccessRuleRequestSchema,
} from '@dorkos/shared/mesh-schemas';
import { validateBoundary } from '../lib/boundary.js';

/** Optional cross-subsystem dependencies for topology enrichment. */
export interface MeshRouterDeps {
  meshCore: MeshCore;
  pulseStore?: { getSchedules(): Array<{ cwd: string | null }> };
  relayCore?: { listEndpoints(): Array<{ subject: string }> };
}

/**
 * Enrich a topology view with health, Relay, and Pulse data for each agent.
 *
 * Each enrichment step is individually wrapped in try/catch so a failure
 * in one subsystem never breaks the topology response.
 */
function enrichTopology(topology: TopologyView, deps: MeshRouterDeps): TopologyView {
  // Pre-compute Pulse schedule counts by CWD for O(1) lookups per agent
  const scheduleCounts = new Map<string, number>();
  if (deps.pulseStore) {
    try {
      for (const schedule of deps.pulseStore.getSchedules()) {
        if (schedule.cwd) {
          scheduleCounts.set(schedule.cwd, (scheduleCounts.get(schedule.cwd) ?? 0) + 1);
        }
      }
    } catch {
      // Pulse unavailable — scheduleCounts stays empty, all agents get 0
    }
  }

  // Pre-fetch Relay endpoints once
  let relayEndpoints: Array<{ subject: string }> = [];
  if (deps.relayCore) {
    try {
      relayEndpoints = deps.relayCore.listEndpoints();
    } catch {
      // Relay unavailable — relayEndpoints stays empty
    }
  }

  return {
    ...topology,
    namespaces: topology.namespaces.map((ns) => ({
      ...ns,
      agents: ns.agents.map((agent) =>
        enrichAgent(agent, ns.namespace, deps, scheduleCounts, relayEndpoints)
      ),
    })),
  };
}

/**
 * Enrich a single agent with cross-subsystem data.
 *
 * @param agent - The base agent manifest from the topology
 * @param namespace - The namespace this agent belongs to
 * @param deps - Router dependencies for cross-subsystem lookups
 * @param scheduleCounts - Pre-computed CWD-to-schedule-count map
 * @param relayEndpoints - Pre-fetched Relay endpoints
 */
function enrichAgent(
  agent: AgentManifest,
  namespace: string,
  deps: MeshRouterDeps,
  scheduleCounts: Map<string, number>,
  relayEndpoints: Array<{ subject: string }>
): AgentManifest & {
  healthStatus: AgentHealthStatus;
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  relayAdapters: string[];
  relaySubject: string | null;
  pulseScheduleCount: number;
} {
  // Safe defaults
  let healthStatus: AgentHealthStatus = 'stale';
  let lastSeenAt: string | null = null;
  let lastSeenEvent: string | null = null;
  let relayAdapters: string[] = [];
  let relaySubject: string | null = null;
  let pulseScheduleCount = 0;

  // Health enrichment
  try {
    const health = deps.meshCore.getAgentHealth(agent.id);
    if (health) {
      healthStatus = health.status;
      lastSeenAt = health.lastSeenAt;
      lastSeenEvent = health.lastSeenEvent;
    }
  } catch {
    // Health unavailable — defaults apply
  }

  // Relay enrichment via inspect (provides relaySubject)
  try {
    const inspection = deps.meshCore.inspect(agent.id);
    if (inspection) {
      relaySubject = inspection.relaySubject;
    }
  } catch {
    // Inspect unavailable — relaySubject stays null
  }

  // Relay adapter matching — find endpoints whose subject starts with
  // the agent's relay namespace prefix (e.g., "relay.agent.<namespace>.")
  if (relaySubject && relayEndpoints.length > 0) {
    try {
      const nsPrefix = `relay.agent.${namespace}.`;
      const matchingEndpoints = relayEndpoints.filter((ep) => ep.subject.startsWith(nsPrefix));
      // Extract adapter names from subject segments after the namespace prefix
      relayAdapters = matchingEndpoints
        .map((ep) => ep.subject.slice(nsPrefix.length))
        .filter(Boolean);
    } catch {
      // Relay matching failed — defaults apply
    }
  }

  // Pulse schedule count — match against the agent's exact projectPath
  if (scheduleCounts.size > 0) {
    try {
      const projectPath = deps.meshCore.getProjectPath(agent.id);
      if (projectPath && scheduleCounts.has(projectPath)) {
        pulseScheduleCount = scheduleCounts.get(projectPath)!;
      }
    } catch {
      // Pulse matching failed — defaults apply
    }
  }

  return {
    ...agent,
    healthStatus,
    lastSeenAt,
    lastSeenEvent,
    relayAdapters,
    relaySubject,
    pulseScheduleCount,
  };
}

/**
 * Create the Mesh router with discovery, registration, and denial endpoints.
 *
 * @param deps - MeshCore instance and optional cross-subsystem dependencies
 */
export function createMeshRouter(deps: MeshRouterDeps | MeshCore): Router {
  // Support both the new deps object and the legacy single-arg signature.
  // If the argument has a `meshCore` property, treat it as MeshRouterDeps;
  // otherwise it's a bare MeshCore instance.
  const resolvedDeps: MeshRouterDeps =
    'meshCore' in deps ? (deps as MeshRouterDeps) : { meshCore: deps as MeshCore };
  const meshCore = resolvedDeps.meshCore;
  const router = Router();

  // POST /discover — Scan directories for agent candidates
  router.post('/discover', async (req, res) => {
    const result = DiscoverRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }

    // Validate each discovery root against boundary
    const validatedRoots: string[] = [];
    for (const root of result.data.roots) {
      try {
        validatedRoots.push(await validateBoundary(root));
      } catch {
        return res.status(403).json({ error: `Path outside boundary: ${root}` });
      }
    }

    try {
      const MAX_CANDIDATES = 1000;
      const candidates = [];
      const options = result.data.maxDepth ? { maxDepth: result.data.maxDepth } : undefined;
      for await (const event of meshCore.discover(validatedRoots, options)) {
        if (event.type === 'candidate') {
          candidates.push(event.data);
        }
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      return res.json({ candidates, truncated: candidates.length >= MAX_CANDIDATES });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Discovery failed';
      const stack = err instanceof Error ? err.stack : undefined;
      console.error('[Mesh] Discovery failed:', message, stack ?? err);
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

    // Validate projectPath against boundary
    let validatedPath: string;
    try {
      validatedPath = await validateBoundary(projectPath);
    } catch {
      return res.status(403).json({ error: `Path outside boundary: ${projectPath}` });
    }

    // registerByPath requires name and runtime
    const name = overrides?.name;
    const runtime = overrides?.runtime;
    if (!name || !runtime) {
      return res.status(400).json({
        error: 'overrides.name and overrides.runtime are required for manual registration',
      });
    }

    try {
      const manifest = await meshCore.registerByPath(
        validatedPath,
        { ...overrides, name, runtime },
        approver
      );
      return res.status(201).json(manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      return res.status(422).json({ error: message });
    }
  });

  // GET /topology — Query the mesh network topology with optional namespace filtering
  // meshCore.getTopology() returns base AgentManifest agents; enrichTopology()
  // adds healthStatus, relayAdapters, pulseScheduleCount, etc. from other subsystems.
  router.get('/topology', (req, res) => {
    const namespace = (req.query.namespace as string) ?? '*';
    const topology = meshCore.getTopology(namespace);
    const enriched = enrichTopology(topology as TopologyView, resolvedDeps);
    return res.json(enriched);
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
    return res.json({ sourceNamespace, targetNamespace, action });
  });

  // GET /status — Aggregate mesh health status
  router.get('/status', (_req, res) => {
    const status = meshCore.getStatus();
    res.json(status);
  });

  // GET /agents/paths — Lightweight agent list with projectPath (for onboarding/scheduling)
  // Must come before GET /agents/:id to avoid param capture
  router.get('/agents/paths', (_req, res) => {
    const agents = meshCore.listWithPaths();
    return res.json({ agents });
  });

  // GET /agents — List agents with optional filters (includes health status)
  router.get('/agents', (req, res) => {
    const result = AgentListQuerySchema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    const { callerNamespace, ...filters } = result.data ?? {};
    // When callerNamespace is provided, use list() which applies
    // topology-based namespace-scoped visibility filtering
    const agents = callerNamespace
      ? meshCore.list({ ...filters, callerNamespace })
      : meshCore.listWithHealth(filters);
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
  router.patch('/agents/:id', async (req, res) => {
    const result = UpdateAgentRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
    }
    // Strip keys that were absent from the request body (defaults filled in by Zod).
    // PATCH semantics: only update fields explicitly provided by the caller.
    const explicitFields = Object.fromEntries(
      Object.entries(result.data).filter(([k]) => k in req.body)
    ) as typeof result.data;
    // ADR-0043: update() is async — writes to disk first, then DB
    const updated = await meshCore.update(req.params.id, explicitFields);
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
      await validateBoundary(result.data.path);
    } catch {
      return res.status(403).json({ error: `Path outside boundary: ${result.data.path}` });
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
    // Reject paths with traversal segments
    if (filePath.includes('..') || filePath.includes('\0')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    try {
      await validateBoundary(filePath);
    } catch {
      return res.status(403).json({ error: `Path outside boundary: ${filePath}` });
    }

    await meshCore.undeny(filePath);
    return res.json({ success: true });
  });

  return router;
}
