/**
 * Mesh agent discovery and registry routes — discover agents, manage registrations,
 * maintain the denial list, and query network topology.
 *
 * @module routes/mesh
 */
import path from 'path';
import { Router } from 'express';
import { z } from 'zod';
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
import { removeDorkDirectory } from '@dorkos/shared/manifest';
import { validateBoundary, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { logOrphanedInstalls } from '../services/mesh/orphaned-installs.js';
import type { ActivityService } from '../services/activity/activity-service.js';

/**
 * Canonical UUID regex — used to exclude session-ID-shaped subject segments
 * from the mesh topology's `relayAdapters` list. See the subject-space caveat
 * comment in `enrichAgent()`.
 */
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical ULID regex (26-char Crockford base32) — used to exclude agent-ID-shaped
 * subject segments from the mesh topology's `relayAdapters` list. Mesh agent IDs are
 * ULIDs (`ulidx`), so a sibling agent's own Relay inbox subject
 * (`relay.agent.<namespace>.<agentId>`) shares the exact namespace prefix every OTHER
 * agent in that namespace matches on — without this filter, every agent in a
 * multi-agent namespace would list its siblings (and itself) as "relay adapters".
 * See the subject-space caveat comment in `enrichAgent()`.
 */
const ULID_LIKE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Optional cross-subsystem dependencies for topology enrichment. */
export interface MeshRouterDeps {
  meshCore: MeshCore;
  /**
   * Task store for per-agent schedule counts. Tasks link to agents via
   * `agentId`; only enabled tasks count toward `taskCount` — disabled ones
   * (e.g. cascade-disabled on unregister, or paused) are not live schedules.
   */
  taskStore?: { getTasks(): Array<{ agentId: string | null; enabled: boolean }> };
  relayCore?: { listEndpoints(): Array<{ subject: string }> };
}

/**
 * Enrich a topology view with health, Relay, and Task data for each agent.
 *
 * Each enrichment step is individually wrapped in try/catch so a failure
 * in one subsystem never breaks the topology response.
 */
function enrichTopology(topology: TopologyView, deps: MeshRouterDeps): TopologyView {
  // Pre-compute Task counts by linked agent ID for O(1) lookups per agent
  const taskCounts = new Map<string, number>();
  if (deps.taskStore) {
    try {
      for (const task of deps.taskStore.getTasks()) {
        if (task.enabled && task.agentId) {
          taskCounts.set(task.agentId, (taskCounts.get(task.agentId) ?? 0) + 1);
        }
      }
    } catch {
      // Tasks unavailable — taskCounts stays empty, all agents get 0
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
        enrichAgent(agent, ns.namespace, deps, taskCounts, relayEndpoints)
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
 * @param taskCounts - Pre-computed agent-ID-to-task-count map
 * @param relayEndpoints - Pre-fetched Relay endpoints
 */
function enrichAgent(
  agent: AgentManifest,
  namespace: string,
  deps: MeshRouterDeps,
  taskCounts: Map<string, number>,
  relayEndpoints: Array<{ subject: string }>
): AgentManifest & {
  healthStatus: AgentHealthStatus;
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  relayAdapters: string[];
  relaySubject: string | null;
  taskCount: number;
} {
  // Safe defaults
  let healthStatus: AgentHealthStatus = 'stale';
  let lastSeenAt: string | null = null;
  let lastSeenEvent: string | null = null;
  let relayAdapters: string[] = [];
  let relaySubject: string | null = null;

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
  // the agent's relay namespace prefix (e.g., "relay.agent.<namespace>.").
  //
  // Subject-space sharing caveat: the second `.`-segment of `relay.agent.*`
  // subjects is overloaded. Mesh uses it as a mesh namespace (this filter);
  // the runtime-scoped dispatch shape (ADR 0256) uses it as a runtime type
  // (e.g., `relay.agent.claude-code.<sessionId>`). The two vocabularies are
  // orthogonal in practice, but a mesh namespace literally named after a
  // registered runtime type ('claude-code', 'codex', 'test-mode') would
  // cause this filter to scoop session-dispatch subjects into the agent's
  // `relayAdapters` list. We defensively exclude segments that look like
  // session identifiers (UUID shape) from the extracted adapter names so
  // the topology enrichment never misreports a session id as an adapter.
  //
  // Every OTHER agent registered in the same namespace also owns an endpoint
  // under this exact prefix (its own inbox, `relay.agent.<namespace>.<agentId>`)
  // — and mesh agent IDs are ULIDs, not UUIDs, so the UUID filter above doesn't
  // catch them. Without also excluding ULID-shaped segments, every agent in a
  // multi-agent namespace mislabels its siblings (and itself) as relay adapters.
  if (relaySubject && relayEndpoints.length > 0) {
    try {
      const nsPrefix = `relay.agent.${namespace}.`;
      const matchingEndpoints = relayEndpoints.filter((ep) => ep.subject.startsWith(nsPrefix));
      relayAdapters = matchingEndpoints
        .map((ep) => ep.subject.slice(nsPrefix.length))
        .filter(Boolean)
        .filter((seg) => !UUID_LIKE.test(seg) && !ULID_LIKE.test(seg));
    } catch {
      // Relay matching failed — defaults apply
    }
  }

  // Task count — tasks link to agents directly via agentId
  const taskCount = taskCounts.get(agent.id) ?? 0;

  return {
    ...agent,
    healthStatus,
    lastSeenAt,
    lastSeenEvent,
    relayAdapters,
    relaySubject,
    taskCount,
  };
}

/**
 * Create the Mesh router with discovery, registration, and denial endpoints.
 *
 * @param deps - MeshCore plus optional cross-subsystem dependencies for topology enrichment
 */
export function createMeshRouter(deps: MeshRouterDeps): Router {
  const { meshCore } = deps;
  const router = Router();

  // POST /discover — Scan directories for agent candidates
  router.post('/discover', async (req, res) => {
    const result = DiscoverRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
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
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }

    const { path: projectPath, overrides, approver, scanRoot } = result.data;

    // Validate projectPath against boundary. Agent-registry seam: system and
    // marketplace-installed agents live under `{dorkHome}/agents/*`, so registering
    // an agent there is in-bounds even under a user-project boundary.
    let validatedPath: string;
    try {
      validatedPath = await validateBoundaryOrDorkHome(projectPath);
    } catch {
      return res.status(403).json({ error: `Path outside boundary: ${projectPath}` });
    }

    // Validate the scan root (ADR-0032): it must sit inside the boundary (or
    // dork-home, matching the agent path allowance above) AND be an ancestor of
    // the agent path — otherwise namespace derivation
    // (`path.relative(scanRoot, path)`) would climb outside the scanned tree.
    // Omitted scanRoot falls back to the server default (homedir-relative).
    let validatedScanRoot: string | undefined;
    if (scanRoot !== undefined) {
      try {
        validatedScanRoot = await validateBoundaryOrDorkHome(scanRoot);
      } catch {
        return res.status(403).json({ error: `Scan root outside boundary: ${scanRoot}` });
      }
      const isAncestor =
        validatedPath === validatedScanRoot ||
        validatedPath.startsWith(validatedScanRoot + path.sep);
      if (!isAncestor) {
        return res
          .status(400)
          .json({ error: `Scan root must be an ancestor of the agent path: ${scanRoot}` });
      }
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
        approver,
        validatedScanRoot
      );

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

      return res.status(201).json(manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      return res.status(422).json({ error: message });
    }
  });

  // GET /topology — Query the mesh network topology with optional namespace filtering
  // meshCore.getTopology() returns base AgentManifest agents; enrichTopology()
  // adds healthStatus, relayAdapters, taskCount, etc. from other subsystems.
  router.get('/topology', (req, res) => {
    const namespace = (req.query.namespace as string) ?? '*';
    const topology = meshCore.getTopology(namespace);
    const enriched = enrichTopology(topology as TopologyView, deps);
    return res.json(enriched);
  });

  // PUT /topology/access — Create or remove cross-namespace access rules
  router.put('/topology/access', (req, res) => {
    const result = UpdateAccessRuleRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }
    const { sourceNamespace, targetNamespace, action } = result.data;
    if (action === 'allow') {
      meshCore.allowCrossNamespace(sourceNamespace, targetNamespace);
    } else {
      meshCore.denyCrossNamespace(sourceNamespace, targetNamespace);
    }
    // This endpoint only ever writes user-configured grants — bridge-written
    // defaults are never created or removed here — so origin is always 'explicit'.
    return res.json({ sourceNamespace, targetNamespace, action, origin: 'explicit' });
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

  // GET /agents — List agents with optional filters.
  //
  // One response shape regardless of `callerNamespace`: each agent carries
  // health fields (healthStatus, lastSeenAt, lastSeenEvent) and NO projectPath
  // (stripped per the manifest contract). `callerNamespace` only narrows
  // visibility to reachable namespaces (topology boundary; '*' for admin) — it
  // no longer swaps in a different, projectPath-leaking payload.
  router.get('/agents', (req, res) => {
    const result = AgentListQuerySchema.safeParse(req.query);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }
    const agents = meshCore.listWithHealth(result.data ?? {});
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
  router.post('/agents/:id/heartbeat', async (req, res) => {
    const parsed = HeartbeatRequestSchema.safeParse(req.body ?? {});
    const event = parsed.success ? (parsed.data.event ?? 'heartbeat') : 'heartbeat';
    const healthBefore = meshCore.getAgentHealth(req.params.id);
    if (!healthBefore) return res.status(404).json({ error: 'Agent not found' });

    const previousStatus = healthBefore.status;
    meshCore.updateLastSeen(req.params.id, event);

    // Emit activity event only when health status actually transitions
    const healthAfter = meshCore.getAgentHealth(req.params.id);
    if (healthAfter && healthAfter.status !== previousStatus) {
      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'system',
          actorLabel: 'System',
          category: 'agent',
          eventType: 'agent.status_changed',
          resourceType: 'agent',
          resourceId: req.params.id,
          resourceLabel: healthAfter.name,
          summary: `${healthAfter.name} is now ${healthAfter.status}`,
          linkPath: '/agents',
        });
      }
    }

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
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }

    // Guard: system agents cannot have identity fields changed
    const SYSTEM_PROTECTED_FIELDS = ['name', 'description', 'namespace', 'isSystem'] as const;
    const agent = meshCore.get(req.params.id);
    if (agent?.isSystem) {
      const blockedFields = SYSTEM_PROTECTED_FIELDS.filter((f) => f in req.body);
      if (blockedFields.length > 0) {
        return res.status(403).json({
          error: `Cannot modify ${blockedFields.join(', ')} on system agents`,
        });
      }
    }

    // Strip keys that were absent from the request body (defaults filled in by Zod).
    // PATCH semantics: only update fields explicitly provided by the caller.
    // Null values signal "clear this field" (undefined can't travel over JSON).
    const explicitFields = Object.fromEntries(
      Object.entries(result.data)
        .filter(([k]) => k in req.body)
        .map(([k, v]) => [k, v === null ? undefined : v])
    ) as Partial<AgentManifest>;
    // ADR-0043: update() is async — writes to disk first, then DB
    const updated = await meshCore.update(req.params.id, explicitFields);
    if (!updated) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    return res.json(updated);
  });

  // DELETE /agents/:id/data — Unregister agent and delete its .dork directory
  // MUST come before DELETE /agents/:id to avoid Express treating "data" as an :id param
  router.delete('/agents/:id/data', async (req, res) => {
    const agent = meshCore.get(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (agent.isSystem) {
      return res.status(403).json({ error: 'System agents cannot be deleted' });
    }

    const projectPath = meshCore.getProjectPath(req.params.id);
    if (!projectPath) {
      return res.status(404).json({ error: 'Agent project path not found' });
    }

    let validatedPath: string;
    try {
      validatedPath = await validateBoundary(projectPath);
    } catch {
      return res.status(403).json({ error: `Path outside boundary: ${projectPath}` });
    }

    await meshCore.unregister(req.params.id);
    await removeDorkDirectory(validatedPath);

    // Emit activity event for agent deletion with data
    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService) {
      await activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'agent',
        eventType: 'agent.deleted',
        resourceType: 'agent',
        resourceId: req.params.id,
        resourceLabel: agent.name,
        summary: `Deleted agent ${agent.name} and data`,
        linkPath: '/agents',
      });
    }

    return res.json({ success: true, deletedPath: path.join(validatedPath, '.dork') });
  });

  // DELETE /agents/:id — Unregister agent
  router.delete('/agents/:id', async (req, res) => {
    const agent = meshCore.get(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (agent.isSystem) {
      return res.status(403).json({ error: 'System agents cannot be removed' });
    }

    // Surface any marketplace installs this leaves behind. Unregister keeps the
    // agent's `.dork/plugins/` on disk (unlike the delete-with-data route), so
    // those installs orphan. Resolve the path and scan BEFORE unregister — the
    // registry entry is gone by the time unregister callbacks fire.
    const orphanScanPath = meshCore.getProjectPath(req.params.id);
    if (orphanScanPath) {
      await logOrphanedInstalls({ projectPath: orphanScanPath, agentLabel: agent.name, logger });
    }

    await meshCore.unregister(req.params.id);

    // Fire-and-forget activity event for agent removal
    const activityService = req.app.locals.activityService as ActivityService | undefined;
    if (activityService) {
      await activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'agent',
        eventType: 'agent.removed',
        resourceType: 'agent',
        resourceId: req.params.id,
        resourceLabel: agent.name,
        summary: `Removed agent ${agent.name}`,
      });
    }

    return res.json({ success: true });
  });

  // POST /deny — Deny a candidate path
  router.post('/deny', async (req, res) => {
    const result = DenyRequestSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }

    let resolvedPath: string;
    try {
      resolvedPath = await validateBoundary(result.data.path);
    } catch {
      return res.status(403).json({ error: `Path outside boundary: ${result.data.path}` });
    }

    try {
      await meshCore.deny(resolvedPath, result.data.reason, result.data.denier);
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

    let resolvedPath: string;
    try {
      resolvedPath = await validateBoundary(filePath);
    } catch {
      return res.status(403).json({ error: `Path outside boundary: ${filePath}` });
    }

    await meshCore.undeny(resolvedPath);
    return res.json({ success: true });
  });

  return router;
}
