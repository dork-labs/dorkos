/**
 * The agent registry routes still served by hand (DOR-4978). Every other
 * `/api/mesh/*` path is a capability the mount serves
 * (`services/mesh/doors/mesh-capabilities.ts`).
 *
 * - `GET /agents/paths`, `/agents/:id/access` and `/agents/:id/health` answer
 *   lists that do not page yet; they move once paging is settled (A5).
 * - `GET /agents/:id` moves with them: on the mount its `{id}` would answer
 *   `/agents/paths` before this router could.
 * - `PATCH /agents/:id` holds a credits change for "Confirm it's you" and
 *   refuses an agent's runtime, model and effort changes in middleware
 *   (`mesh-agent-patch-http.ts`).
 * - `POST /agents/:id/heartbeat` is one a Wi-Fi sign-in may send on purpose,
 *   so it waits for Security to approve a network mode for it.
 *
 * The heartbeat's `agent.status_changed` event is not the caller's doing: it
 * records DorkOS noticing a health transition, so it stays `system` /
 * `System`. See `routes/__tests__/route-activity-actor.test.ts`, which exempts
 * that one site by name.
 *
 * @module routes/mesh
 */
import { Hono } from 'hono';
import { projectComputerPlacement } from './computer-placement.js';
import { HeartbeatRequestSchema } from '@dorkos/shared/mesh-schemas';
import type { ActivityService } from '../services/activity/activity-service.js';
import {
  refuseAgentExecutionWrites,
  refuseAgentSelfFilesFromWifi,
} from '../middleware/agent-execution-gate.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '@dorkos/http-kit';
import { agentNotFound } from './mesh-problems.js';
import type { TopologyEnrichmentDeps } from './mesh-topology.js';
import { patchMeshAgent } from './mesh-agent-patch-http.js';

/** Registry, activity and topology services the Mesh HTTP routes use. */
export interface MeshRouterDeps extends TopologyEnrichmentDeps {
  /** Where registrations and removals are recorded; absent in a test that does not watch it. */
  activity?: ActivityService;
}

/**
 * Create the hand-served Mesh routes: four reads, an agent's update and its heartbeat.
 *
 * @param deps - MeshCore, the activity feed, and the subsystems topology enrichment reads
 * @returns The routes, to mount at `/api/mesh`.
 */
export function createMeshRoutes(deps: MeshRouterDeps): Hono<ApiEnv> {
  const { meshCore, activity: activityService } = deps;
  const router = new Hono<ApiEnv>();

  // GET /agents/paths — Lightweight agent list with projectPath (for onboarding/scheduling)
  router.get('/agents/paths', (c) => {
    const agents = meshCore.listWithPaths().map(projectComputerPlacement);
    return c.json({ agents });
  });

  // GET /agents/:id/access — Get reachable agents for a specific agent
  router.get('/agents/:id/access', (c) => {
    const agents = meshCore.getAgentAccess(c.req.param('id'));
    if (!agents) return agentNotFound(c);
    return c.json({ agents });
  });

  // GET /agents/:id — One agent. By hand while `/agents/paths` is: on the mount
  // its `{id}` would answer that path first.
  router.get('/agents/:id', (c) => {
    const agent = meshCore.get(c.req.param('id'));
    if (!agent) return agentNotFound(c);
    return c.json(agent);
  });

  // GET /agents/:id/health — Health snapshot for a single agent
  router.get('/agents/:id/health', (c) => {
    const health = meshCore.getAgentHealth(c.req.param('id'));
    if (!health) return agentNotFound(c);
    return c.json(health);
  });

  // POST /agents/:id/heartbeat — Record a heartbeat for an agent
  router.post('/agents/:id/heartbeat', async (c) => {
    const id = c.req.param('id');
    const parsed = HeartbeatRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    const event = parsed.success ? (parsed.data.event ?? 'heartbeat') : 'heartbeat';
    const healthBefore = meshCore.getAgentHealth(id);
    if (!healthBefore) return agentNotFound(c);

    const previousStatus = healthBefore.status;
    meshCore.updateLastSeen(id, event);

    // Emit activity event only when health status actually transitions
    const healthAfter = meshCore.getAgentHealth(id);
    if (healthAfter && healthAfter.status !== previousStatus) {
      if (activityService) {
        await activityService.emit({
          // The one emit on this router that must NOT read the caller. Nobody
          // asked for this line: the caller sent a heartbeat, and DorkOS is the
          // one that noticed the health transition and is reporting it. Naming
          // the heartbeat's sender would say an agent changed its own status,
          // which is not what happened.
          actorType: 'system',
          actorLabel: 'System',
          category: 'agent',
          eventType: 'agent.status_changed',
          resourceType: 'agent',
          resourceId: id,
          resourceLabel: healthAfter.name,
          summary: `${healthAfter.name} is now ${healthAfter.status}`,
          linkPath: '/agents',
        });
      }
    }

    return c.json({ success: true });
  });

  // PATCH /agents/:id — Update agent fields
  // An agent's runtime, model and effort move every schedule that follows it,
  // so an agent changing them is sent to the tool that asks a person (DOR-2328).
  router.patch('/agents/:id', refuseAgentExecutionWrites, refuseAgentSelfFilesFromWifi, (c) =>
    patchMeshAgent(c, deps)
  );

  return router;
}
