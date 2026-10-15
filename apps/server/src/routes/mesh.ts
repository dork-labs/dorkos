import { projectComputerPlacement, projectComputerPlacementById } from './computer-placement.js';
/**
 * Mesh agent discovery and registry routes — discover agents, manage registrations,
 * maintain the denial list, and query network topology.
 *
 * ## Who the Activity feed says did it
 *
 * Register, remove, and remove-with-data all read the caller
 * (`readActivityActor`) instead of asserting the person did it. Until DOR-1829
 * they hardcoded `user` / `'You'`, so an agent that removed another agent was
 * recorded in the operator's own feed as the operator's own doing — the exact
 * lie DOR-1801 fixed one router over.
 *
 * They are NOT person-barred, and that is a decision rather than an omission.
 * `MCP_TOOL_TIERS` already classifies these verbs for agents: `mesh_register` is
 * `act` and `mesh_unregister` is `destructive` (an approval card, not a
 * prohibition). A bar here would make the HTTP door refuse outright what the
 * sanctioned agent door allows with a person's consent — a policy change, not an
 * attribution fix. What the HTTP routes lack is the tier gate the MCP twins run,
 * which is a separate piece of work; recording who acted is the part that can be
 * true today.
 *
 * The heartbeat route's `agent.status_changed` event is the one actor here that
 * is NOT the caller: it records DorkOS noticing a health transition, so it stays
 * `system` / `System`. See `routes/__tests__/route-activity-actor.test.ts`,
 * which exempts that one site by name.
 *
 * @module routes/mesh
 */
import path from 'path';
import { Hono } from 'hono';
import { z } from 'zod';
import { isManifestGitTracked, ManifestUnreadableError } from '@dorkos/mesh';
import type { TopologyView } from '@dorkos/shared/mesh-schemas';
import {
  DiscoverRequestSchema,
  RegisterAgentRequestSchema,
  DenyRequestSchema,
  UpdateAgentRequestSchema,
  AgentListQuerySchema,
  HeartbeatRequestSchema,
  UpdateAccessRuleRequestSchema,
} from '@dorkos/shared/mesh-schemas';
import { removeDorkDirectory, probeManifest } from '@dorkos/shared/manifest';
import { validateBoundary, validateBoundaryOrDorkHome } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import { logOrphanedInstalls } from '../services/mesh/orphaned-installs.js';
import { notifyAgentCreated } from '../services/core/agent-created-hook.js';
import { resolveAgentIdentity } from '../services/mesh/normalize-agent-identity.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { refuseAgentExecutionWrites } from '../middleware/agent-execution-gate.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { enrichTopology, type TopologyEnrichmentDeps } from './mesh-topology.js';
import { setCreditsAllowedForAgent } from '../services/core/cloud/credits-defaults.js';
import { creditsAgentPatchRefusal } from '../services/core/cloud/credits-model-gate.js';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { writeAgentManifest } from '../services/core/agent-observation/agent-execution-writes.js';
import { prepareAgentPatch, registrationFields } from '../services/mesh/agent-patch.js';

/** What the mesh routes read: the registry, the activity feed, and what topology enrichment reads. */
export interface MeshRouterDeps extends TopologyEnrichmentDeps {
  /** Where registrations and removals are recorded; absent in a test that does not watch it. */
  activity?: ActivityService;
}

/**
 * The permission fields a mesh agent PATCH names, which this route refuses: the
 * `permissions` object, and the two retired fields that used to carry the same
 * answer, `enabledToolGroups` and `tierCeiling` (spec `agent-permissions` D13).
 * Refused by name rather than stripped, so a caller still sending one learns
 * where the setting went instead of hearing "done".
 *
 * @param body - The raw request body.
 * @returns The refused field paths, empty when the body names none.
 */
function retiredPermissionFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  return ['permissions', 'enabledToolGroups', 'tierCeiling'].filter((field) =>
    Object.hasOwn(record, field)
  );
}

/**
 * Create the Mesh routes with discovery, registration, and denial endpoints.
 *
 * @param deps - MeshCore, the activity feed, and the subsystems topology enrichment reads
 * @returns The routes, to mount at `/api/mesh`.
 */
export function createMeshRoutes(deps: MeshRouterDeps): Hono<ApiEnv> {
  const { meshCore, activity: activityService } = deps;
  const router = new Hono<ApiEnv>();

  // POST /discover — Scan directories for agent candidates
  router.post('/discover', async (c) => {
    const result = DiscoverRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
    }

    // Validate each discovery root against boundary
    const validatedRoots: string[] = [];
    for (const root of result.data.roots) {
      try {
        validatedRoots.push(await validateBoundary(root));
      } catch {
        return c.json({ error: `Path outside boundary: ${root}` }, 403);
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
      return c.json({ candidates, truncated: candidates.length >= MAX_CANDIDATES });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Discovery failed';
      const stack = err instanceof Error ? err.stack : undefined;
      console.error('[Mesh] Discovery failed:', message, stack ?? err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /agents — Register an agent by path.
  //
  // A directory that already holds a `.dork/agent.json` is ADOPTED: the file is
  // left exactly as it is and the identity it describes is what gets
  // registered, so the response's name and id can differ from what was asked
  // for. Registration used to write over that file, which cost this repo its
  // own committed manifest (DOR-1019). A manifest that is there but unreadable
  // is refused with a 422 naming the file.
  router.post('/agents', async (c) => {
    const result = RegisterAgentRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
    }

    const { path: projectPath, overrides, approver, scanRoot } = result.data;

    // Validate projectPath against boundary. Agent-registry seam: system and
    // marketplace-installed agents live under `{dorkHome}/agents/*`, so registering
    // an agent there is in-bounds even under a user-project boundary.
    let validatedPath: string;
    try {
      validatedPath = await validateBoundaryOrDorkHome(projectPath);
    } catch {
      return c.json({ error: `Path outside boundary: ${projectPath}` }, 403);
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
        return c.json({ error: `Scan root outside boundary: ${scanRoot}` }, 403);
      }
      const isAncestor =
        validatedPath === validatedScanRoot ||
        validatedPath.startsWith(validatedScanRoot + path.sep);
      if (!isAncestor) {
        return c.json(
          { error: `Scan root must be an ancestor of the agent path: ${scanRoot}` },
          400
        );
      }
    }

    // Creating an agent needs a name and a runtime; ADOPTING one needs neither,
    // because the manifest already on disk supplies both and the overrides are
    // ignored. Requiring them regardless 400'd the one recovery this route
    // documents — re-registering a folder to take it off the denied list, which
    // the "Undo" on an unregister toast sends as a bare `{ path }` (DOR-1019
    // review).
    const adoptable = (await probeManifest(validatedPath)).state === 'present';
    if (!adoptable && (!overrides?.name || !overrides?.runtime)) {
      return c.json(
        {
          error:
            'overrides.name and overrides.runtime are required to register a directory that has ' +
            'no .dork/agent.json of its own',
        },
        400
      );
    }

    // The same identity gate the `mesh_register` MCP tool uses, and for the same
    // reason it exists at all: an agent reaches this route too, `name` is the
    // immutable slug an `@handle` is derived from rather than a label, and a
    // face has to be a face (DOR-2054). No fallback name is passed — a bare
    // `{ path }` is the documented re-register recovery, and adoption ignores
    // every override, so there is nothing here to name.
    const identity = resolveAgentIdentity({
      name: overrides?.name,
      displayName: overrides?.displayName,
      icon: overrides?.icon,
      color: overrides?.color,
    });
    if (!identity.ok) {
      return c.json({ error: identity.error, code: identity.code }, 400);
    }

    try {
      const manifest = await meshCore.registerByPath(
        validatedPath,
        // `createdBy` is the account making this request and `reportsTo` is never
        // the body's say here (spec `heartbeats` §4.1).
        registrationFields(overrides, identity.identity),
        approver,
        validatedScanRoot
      );

      // The agent-created seam: mesh registration writes the manifest through
      // `registerByPath` rather than `createAgentWorkspace`, so it must notify
      // directly — otherwise an agent registered here only took its #team seat
      // at the next server boot (DOR-1042, team-room-home spec D3.1). Awaited,
      // but never throws: a reaction that failed never turns a registration
      // that succeeded into a 422.
      //
      // It goes BEFORE the activity write, and that order is deliberate: only
      // `registerByPath` is allowed to decide this request's outcome, and the
      // seat is what a person sees. Behind the emit, a failing activity store
      // both 422'd a registration that had genuinely happened and left the new
      // agent outside #team until the next boot.
      await notifyAgentCreated({
        id: manifest.id,
        name: manifest.name,
        displayName: manifest.displayName,
        path: validatedPath,
        // Registration, not creation: this takes a directory the person already
        // has onto the roster. It gets the seat; it does not get a moment.
        origin: 'registered',
      });

      // Fire-and-forget activity event for agent registration — and now
      // actually fire-and-forget. The feed is bookkeeping: a store that is down
      // is worth a log line, never a 422 on work that succeeded.
      if (activityService) {
        try {
          await activityService.emit({
            // Read, never asserted: this route is reachable by an agent, and a
            // feed that credits the person with a machine's registration is
            // believed (DOR-1829).
            ...readActivityActor(honoRequestFacts(c)),
            category: 'agent',
            eventType: 'agent.registered',
            resourceType: 'agent',
            resourceId: manifest.id,
            resourceLabel: manifest.name,
            summary: `Registered agent ${manifest.name}`,
            linkPath: '/agents',
          });
        } catch (err) {
          logger.warn('[mesh] could not record the agent registration in the activity feed', {
            err,
            agentId: manifest.id,
          });
        }
      }

      return c.json(manifest, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      return c.json({ error: message }, 422);
    }
  });

  // GET /topology — Query the mesh network topology with optional namespace filtering
  // meshCore.getTopology() returns base AgentManifest agents; enrichTopology()
  // adds healthStatus, relayAdapters, taskCount, etc. from other subsystems.
  router.get('/topology', (c) => {
    const namespace = (readQuery(c).namespace as string) ?? '*';
    const topology = meshCore.getTopology(namespace);
    const enriched = enrichTopology(topology as TopologyView, deps);
    enriched.namespaces.forEach((ns) => {
      ns.agents = ns.agents.map(projectComputerPlacement);
    });
    return c.json(enriched);
  });

  // PUT /topology/access — Create or remove cross-namespace access rules.
  //
  // `'*'` on BOTH sides is the mesh-wide "Let all my agents talk to each other"
  // switch (allow turns it on, deny turns it off); the schema rejects a
  // wildcard on one side only. It routes to the same verbs as a namespace pair
  // — Mesh stores it in the same rule store and projects it into Relay as
  // `relay.agent.> -> relay.agent.>`.
  router.put('/topology/access', (c) => {
    const result = UpdateAccessRuleRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
    }
    const { sourceNamespace, targetNamespace, action } = result.data;
    try {
      if (action === 'allow') {
        meshCore.allowCrossNamespace(sourceNamespace, targetNamespace);
      } else {
        meshCore.denyCrossNamespace(sourceNamespace, targetNamespace);
      }
    } catch (err) {
      // Mesh enforces the same wildcard invariant the schema does, plus any
      // future rule validation — a rejected rule is the caller's mistake (400),
      // never a server fault (500).
      const message = err instanceof Error ? err.message : 'Access rule rejected';
      return c.json({ error: message }, 400);
    }
    // This endpoint only ever writes user-configured grants — bridge-written
    // defaults are never created or removed here — so origin is always 'explicit'.
    return c.json({ sourceNamespace, targetNamespace, action, origin: 'explicit' });
  });

  // GET /status — Aggregate mesh health status
  router.get('/status', (c) => {
    const status = meshCore.getStatus();
    return c.json(status);
  });

  // GET /agents/paths — Lightweight agent list with projectPath (for onboarding/scheduling)
  // Must come before GET /agents/:id to avoid param capture
  router.get('/agents/paths', (c) => {
    const agents = meshCore.listWithPaths().map(projectComputerPlacement);
    return c.json({ agents });
  });

  // GET /agents — List agents with optional filters.
  //
  // One response shape regardless of `callerNamespace`: each agent carries
  // health fields (healthStatus, lastSeenAt, lastSeenEvent) and NO projectPath
  // (stripped per the manifest contract). `callerNamespace` only narrows
  // visibility to reachable namespaces (topology boundary; '*' for admin) — it
  // no longer swaps in a different, projectPath-leaking payload.
  router.get('/agents', (c) => {
    const result = AgentListQuerySchema.safeParse(readQuery(c));
    if (!result.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
    }
    const paths = meshCore.listWithPaths();
    const agents = meshCore
      .listWithHealth(result.data ?? {})
      .map((agent) => projectComputerPlacementById(agent, paths));
    return c.json({ agents });
  });

  // GET /agents/:id/access — Get reachable agents for a specific agent
  // MUST come before GET /agents/:id to avoid being swallowed by the param route
  router.get('/agents/:id/access', (c) => {
    const agents = meshCore.getAgentAccess(c.req.param('id'));
    if (!agents) return c.json({ error: 'Agent not found' }, 404);
    return c.json({ agents });
  });

  // GET /agents/:id/health — Health snapshot for a single agent
  // MUST come before GET /agents/:id to avoid being swallowed by the param route
  router.get('/agents/:id/health', (c) => {
    const health = meshCore.getAgentHealth(c.req.param('id'));
    if (!health) return c.json({ error: 'Agent not found' }, 404);
    return c.json(health);
  });

  // POST /agents/:id/heartbeat — Record a heartbeat for an agent
  router.post('/agents/:id/heartbeat', async (c) => {
    const id = c.req.param('id');
    const parsed = HeartbeatRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    const event = parsed.success ? (parsed.data.event ?? 'heartbeat') : 'heartbeat';
    const healthBefore = meshCore.getAgentHealth(id);
    if (!healthBefore) return c.json({ error: 'Agent not found' }, 404);

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

  // GET /agents/:id — Get single agent
  router.get('/agents/:id', (c) => {
    const agent = meshCore.get(c.req.param('id'));
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    return c.json(agent);
  });

  // PATCH /agents/:id — Update agent fields
  // An agent's runtime, model and effort move every schedule that follows it,
  // so an agent changing them is sent to the tool that asks a person (DOR-2328).
  router.patch('/agents/:id', refuseAgentExecutionWrites, async (c) => {
    const id = c.req.param('id');
    // Read as an object: anything else fails the schema below before a field
    // is looked up, as `req.body` did on Express.
    const body = readJsonBody(c) as Record<string, unknown>;
    // What an agent may do is never written here (spec `agent-permissions` D10).
    // This route has no caller guard of its own, so any local program can reach
    // it; the permission routes are the one way in, behind a person and with an
    // audit event. Refused by name rather than stripped by the schema, so the
    // caller learns where to go instead of getting a 200 that changed nothing.
    const refused = retiredPermissionFields(body);
    if (refused.length > 0) {
      return c.json(
        {
          error:
            'Only a person can change permissions, from the Permissions page. Agents can ask the person.',
          code: 'USE_PERMISSIONS_API',
          fields: refused,
        },
        400
      );
    }
    const result = UpdateAgentRequestSchema.safeParse(body);
    if (!result.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
    }

    // Guard: system agents cannot have identity fields changed
    const SYSTEM_PROTECTED_FIELDS = ['name', 'description', 'namespace', 'isSystem'] as const;
    const blockedFields = meshCore.get(id)?.isSystem
      ? SYSTEM_PROTECTED_FIELDS.filter((f) => f in body)
      : [];
    if (blockedFields.length > 0) {
      return c.json(
        {
          error: `Cannot modify ${blockedFields.join(', ')} on system agents`,
        },
        403
      );
    }

    // Only the keys the caller sent, `null` as "clear", and a reports-to change
    // checked for loops (spec `heartbeats` §4.1) — see `prepareAgentPatch`.
    const patch = prepareAgentPatch(meshCore, id, body, result.data);
    if ('refusal' in patch) return c.json(patch.refusal, 400);
    // An agent on DorkOS credits may be set only to a model credits serve on
    // its runtime's protocol, the same menu its Model row offers (DOR-2636).
    const modelRefusal = await creditsAgentPatchRefusal(
      id,
      patch.fields,
      Object.hasOwn(body as object, 'account'),
      meshCore.get(id)
    );
    if (modelRefusal) return c.json({ error: modelRefusal, code: 'UNSUPPORTED_MODEL' }, 400);
    // ADR-0043: update() is async — writes to disk first, then DB.
    //
    // It REFUSES when the manifest is present but unreadable, rather than
    // rebuilding one from the DB row, because that row cannot carry
    // `permissions`, `mcpServers` or `workspace` and the rebuild would erase all
    // three (DOR-486 review). Answered as a 409 with the
    // reason: the request is fine, the state on disk is not, and the operator
    // can act on the sentence.
    // Narrowed to the sentinel class on purpose. An unconditional catch here
    // also swallowed `writeManifest`'s schema rejection and any I/O failure, and
    // answered all of them `409 MANIFEST_UNREADABLE` with the raw message —
    // a wrong status over a wrong story, and internals on the wire (DOR-486
    // re-review). Anything else rethrows to the error middleware, which is where
    // an unexpected failure belongs.
    let updated;
    // Through the observer of outside changes when it names the runtime, model
    // or effort, so this person's change is never reported as one (DOR-2337).
    try {
      updated = await writeAgentManifest(body, meshCore.getProjectPath(id), async () =>
        patch.recorded(await meshCore.update(id, patch.fields))
      );
    } catch (err) {
      if (!(err instanceof ManifestUnreadableError)) throw err;
      return c.json({ error: err.message, code: 'MANIFEST_UNREADABLE' }, 409);
    }
    if (!updated) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    // Only the owner of this DorkOS can put an agent on DorkOS credits
    // (ADR 261001-000811, DOR-2652). The file now says what was asked; the
    // consent lives in DorkOS config, recorded only for the owner, so an agent,
    // another signed-in account, or a cloned file naming credits on its own
    // spends nothing.
    if (
      Object.hasOwn(body as object, 'account') &&
      refuseUnlessAccountOwner(honoRequestFacts(c)) === undefined
    ) {
      setCreditsAllowedForAgent(id, (body as { account?: unknown }).account === CREDITS_ACCOUNT_ID);
    }
    return c.json(updated);
  });

  // DELETE /agents/:id/data — Unregister agent and delete its .dork directory
  // MUST come before DELETE /agents/:id to avoid Express treating "data" as an :id param
  router.delete('/agents/:id/data', async (c) => {
    const id = c.req.param('id');
    const agent = meshCore.get(id);
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (agent.isSystem) {
      return c.json({ error: 'System agents cannot be deleted' }, 403);
    }

    const projectPath = meshCore.getProjectPath(id);
    if (!projectPath) {
      return c.json({ error: 'Agent project path not found' }, 404);
    }

    let validatedPath: string;
    try {
      // Deliberately the PLAIN boundary (not the dork-home agents seam):
      // this deletes the agent's .dork directory from disk, and destructive
      // filesystem writes stay confined to the boundary even though
      // registering the same path is allowed via the seam.
      validatedPath = await validateBoundary(projectPath);
    } catch {
      return c.json({ error: `Path outside boundary: ${projectPath}` }, 403);
    }

    // A manifest git tracks belongs to somebody's repo, and this route deletes
    // the whole `.dork/` directory around it — so it refuses outright rather
    // than half-deleting, and says what to do instead (DOR-1019). Removing the
    // agent without its data still works and leaves the file alone.
    if (await isManifestGitTracked(validatedPath, logger)) {
      return c.json(
        {
          error:
            `Cannot delete ${path.join(validatedPath, '.dork')}: agent.json in it is tracked by ` +
            `git, so it belongs to that repository. Remove the agent without its data, then delete ` +
            `the files with git if you want them gone.`,
        },
        409
      );
    }

    await meshCore.unregister(id);
    await removeDorkDirectory(validatedPath);

    // Emit activity event for agent deletion with data
    if (activityService) {
      await activityService.emit({
        // The highest-stakes verb on this router — it removes another agent AND
        // its data — so naming the wrong actor here is the worst version of the
        // DOR-1801 defect. Read the caller.
        ...readActivityActor(honoRequestFacts(c)),
        category: 'agent',
        eventType: 'agent.deleted',
        resourceType: 'agent',
        resourceId: id,
        resourceLabel: agent.name,
        summary: `Deleted agent ${agent.name} and data`,
        linkPath: '/agents',
      });
    }

    return c.json({ success: true, deletedPath: path.join(validatedPath, '.dork') });
  });

  // DELETE /agents/:id — Unregister agent
  router.delete('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const agent = meshCore.get(id);
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (agent.isSystem) {
      return c.json({ error: 'System agents cannot be removed' }, 403);
    }

    // Surface any marketplace installs this leaves behind. Unregister keeps the
    // agent's `.dork/plugins/` on disk (unlike the delete-with-data route), so
    // those installs orphan. Resolve the path and scan BEFORE unregister — the
    // registry entry is gone by the time unregister callbacks fire.
    const orphanScanPath = meshCore.getProjectPath(id);
    if (orphanScanPath) {
      await logOrphanedInstalls({ projectPath: orphanScanPath, agentLabel: agent.name, logger });
    }

    const { manifestKept } = await meshCore.unregister(id);

    // Fire-and-forget activity event for agent removal
    if (activityService) {
      await activityService.emit({
        // Same as the delete-with-data route above: an agent may reach this, so
        // who removed whom is read rather than assumed.
        ...readActivityActor(honoRequestFacts(c)),
        category: 'agent',
        eventType: 'agent.removed',
        resourceType: 'agent',
        resourceId: id,
        resourceLabel: agent.name,
        summary: `Removed agent ${agent.name}`,
      });
    }

    // `blockedFromDiscovery` is the durable second effect, and the caller has to
    // be able to say it: the agent's manifest was git-tracked, so it is still on
    // disk and the folder was denied instead — a state the person meets again
    // the next time they look at that directory (DOR-1019).
    return c.json({ success: true, blockedFromDiscovery: manifestKept });
  });

  // POST /deny — Deny a candidate path
  router.post('/deny', async (c) => {
    const result = DenyRequestSchema.safeParse(readJsonBody(c));
    if (!result.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
    }

    let resolvedPath: string;
    try {
      resolvedPath = await validateBoundary(result.data.path);
    } catch {
      return c.json({ error: `Path outside boundary: ${result.data.path}` }, 403);
    }

    try {
      await meshCore.deny(resolvedPath, result.data.reason, result.data.denier);
      return c.json({ success: true }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Denial failed';
      return c.json({ error: message }, 422);
    }
  });

  // GET /denied — List all denial records
  router.get('/denied', (c) => {
    const denied = meshCore.listDenied();
    return c.json({ denied });
  });

  // DELETE /denied/:encodedPath — Clear a denial by URL-encoded path
  router.delete('/denied/:encodedPath', async (c) => {
    // The parameter arrives decoded once, as on Express, and is decoded again:
    // the client encodes the whole path into one segment.
    const filePath = decodeURIComponent(c.req.param('encodedPath'));
    // Reject paths with traversal segments
    if (filePath.includes('..') || filePath.includes('\0')) {
      return c.json({ error: 'Invalid path' }, 400);
    }

    let resolvedPath: string;
    try {
      resolvedPath = await validateBoundary(filePath);
    } catch {
      return c.json({ error: `Path outside boundary: ${filePath}` }, 403);
    }

    await meshCore.undeny(resolvedPath);
    return c.json({ success: true });
  });

  return router;
}
