/**
 * A person's changes to the agent registry (`/api/mesh/*` writes) as
 * capabilities the mount serves (DOR-4978, ADR 261123-170830): the same paths,
 * bodies and statuses the hand routes had.
 *
 * Every one is person-only (`http.audience: 'person'`). Who the agents are,
 * which folders discovery skips and which agents may message which are a
 * person's decisions; an agent asks through its own tools (`mesh_discover`,
 * `mesh_register`, `mesh_unregister`, `mesh_deny`), which carry its turn's
 * power and ask a person where they must. The hand routes let any caller make
 * these changes with no gate at all, and recorded who did it; now only a
 * person can, so the feed names the person.
 *
 * @module services/mesh/doors/mesh-write-capabilities
 */
import path from 'node:path';
import { z } from 'zod';
import { InsideRoomFilesError, isManifestGitTracked, ManifestUnreadableError } from '@dorkos/mesh';
import {
  CrossNamespaceRuleSchema,
  DenyRequestSchema,
  DiscoverRequestSchema,
  DiscoveryCandidateSchema,
  RegisterAgentRequestSchema,
  UpdateAccessRuleRequestSchema,
  AgentManifestSchema,
} from '@dorkos/shared/mesh-schemas';
import { probeManifest, removeDorkDirectory } from '@dorkos/shared/manifest';

import { defineCapability } from '../../core/capabilities/index.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { validateBoundary, validateBoundaryOrDorkHome } from '../../../lib/boundary.js';
import { logger } from '../../../lib/logger.js';
import { createScanBrowserWarner } from '../../browser/agent-browser-lint.js';
import { notifyAgentCreated } from '../../core/agent-created-hook.js';
import { personActivityActor } from '../../activity/activity-actor.js';
import { logOrphanedInstalls } from '../orphaned-installs.js';
import { resolveAgentIdentity } from '../normalize-agent-identity.js';
import { registrationFields } from '../agent-patch.js';
import { MESH_AGENT_PARAM, meshOf, PERSON_DOOR_NOTE } from './mesh-capability-deps.js';
import { IDENTITY_REFUSAL, meshRefusal } from './mesh-refusals.js';

/** The most candidates one scan answers with. */
const MAX_CANDIDATES = 1000;

/** The same folder refusal every door answers (`PATH_OUTSIDE_BOUNDARY`). */
function outsideBoundary(): CapabilityToolError {
  return new CapabilityToolError({
    code: 'PATH_OUTSIDE_BOUNDARY',
    error: 'Pick a folder inside the ones DorkOS may use.',
  });
}

/** A folder inside the boundary, or the boundary refusal. */
async function inBoundary(
  folder: string,
  check: (folder: string) => Promise<string> = validateBoundary
): Promise<string> {
  try {
    return await check(folder);
  } catch {
    throw outsideBoundary();
  }
}

/** The agent a path names. */
const AgentId = z.string().min(1).describe('The Mesh id of the agent.');
/** What a removal answers. */
const Success = z.object({ success: z.boolean() });

/** `mesh.discover`: scan folders for agents. */
export const meshDiscoverCapability = defineCapability({
  id: 'mesh.discover',
  title: 'Scan folders for agents',
  description:
    'Scan folders for agent candidates. A folder that already holds an agent file is ' +
    'registered as it is found. Answers at most 1000 candidates.',
  tier: 'act',
  area: null,
  areaNote: PERSON_DOOR_NOTE,
  input: DiscoverRequestSchema,
  output: z.object({ candidates: z.array(DiscoveryCandidateSchema), truncated: z.boolean() }),
  surfaces: {
    http: {
      method: 'post',
      path: '/api/mesh/discover',
      audience: 'person',
      agentsUse:
        'Agents scan for, register and remove agents with mesh_discover, mesh_register and mesh_unregister.',
    },
  },
  invoke: async (deps, input) => {
    const { meshCore } = meshOf(deps);
    const roots: string[] = [];
    for (const root of input.roots) roots.push(await inBoundary(root));
    const candidates = [];
    const options = input.maxDepth ? { maxDepth: input.maxDepth } : undefined;
    // A folder the scan finds may hold a browser server outside DorkOS's guard (DOR-3957).
    const warnBrowsers = createScanBrowserWarner(logger);
    try {
      for await (const event of meshCore.discover(roots, options)) {
        if (event.type === 'candidate') {
          candidates.push(event.data);
          warnBrowsers(event.data.path);
        }
        if (candidates.length >= MAX_CANDIDATES) break;
      }
    } catch (err) {
      logger.error('[Mesh] Discovery failed', { err });
      throw meshRefusal('MESH_DISCOVERY_FAILED');
    }
    return { candidates, truncated: candidates.length >= MAX_CANDIDATES };
  },
});

/** Answer a registration `registerByPath` refused. */
function registrationRefusal(err: unknown): CapabilityToolError {
  if (err instanceof InsideRoomFilesError) return meshRefusal('MESH_ROOM_FOLDER');
  if (err instanceof ManifestUnreadableError)
    return meshRefusal('MESH_REGISTER_MANIFEST_UNREADABLE');
  // The thrown message stays in the log: it can name a folder.
  logger.warn('[mesh] write refused', { err });
  return meshRefusal('MESH_REGISTER_REFUSED');
}

/**
 * `mesh.register_agent`: put a folder's agent on the team.
 *
 * A folder that already holds a `.dork/agent.json` is ADOPTED: the file is
 * left as it is and the identity it describes is registered, so the answer's
 * name and id can differ from what was asked for (DOR-1019).
 */
export const meshRegisterAgentCapability = defineCapability({
  id: 'mesh.register_agent',
  title: 'Register an agent',
  description:
    'Register the agent in a folder. A folder with an agent file is adopted as it is; one ' +
    'without needs `overrides.name` and `overrides.runtime`. Clears any denial on the folder.',
  tier: 'act',
  area: null,
  areaNote: PERSON_DOOR_NOTE,
  input: RegisterAgentRequestSchema,
  output: AgentManifestSchema,
  surfaces: {
    http: {
      method: 'post',
      path: '/api/mesh/agents',
      success: 201,
      audience: 'person',
      agentsUse:
        'Agents scan for, register and remove agents with mesh_discover, mesh_register and mesh_unregister.',
    },
  },
  invoke: async (deps, input) => {
    const mesh = meshOf(deps);
    const { path: projectPath, overrides, approver, scanRoot } = input;
    // System and marketplace-installed agents live under `{dorkHome}/agents/*`,
    // so registering one there is in bounds even under a project boundary.
    const agentPath = await inBoundary(projectPath, validateBoundaryOrDorkHome);
    // The scan root must sit inside the boundary AND hold the agent's folder,
    // or the namespace taken from it would climb out of the scanned tree (ADR-0032).
    let checkedScanRoot: string | undefined;
    if (scanRoot !== undefined) {
      checkedScanRoot = await inBoundary(scanRoot, validateBoundaryOrDorkHome);
      const holdsIt =
        agentPath === checkedScanRoot || agentPath.startsWith(checkedScanRoot + path.sep);
      if (!holdsIt) throw meshRefusal('MESH_SCAN_ROOT_NOT_ANCESTOR');
    }
    // Adopting needs neither a name nor a runtime: the file on disk has both.
    const adoptable = (await probeManifest(agentPath)).state === 'present';
    if (!adoptable && (!overrides?.name || !overrides?.runtime)) {
      throw meshRefusal('MESH_NAME_AND_RUNTIME_NEEDED');
    }
    // `name` is the slug an `@handle` comes from, and a face has to be a face (DOR-2054).
    const identity = resolveAgentIdentity({
      name: overrides?.name,
      displayName: overrides?.displayName,
      icon: overrides?.icon,
      color: overrides?.color,
    });
    if (!identity.ok) throw meshRefusal(IDENTITY_REFUSAL[identity.code], identity.error);

    let manifest;
    try {
      manifest = await mesh.meshCore.registerByPath(
        agentPath,
        // `createdBy` is the account making this request; `reportsTo` is never the body's say.
        registrationFields(overrides, identity.identity),
        approver,
        checkedScanRoot
      );
    } catch (err) {
      throw registrationRefusal(err);
    }
    // The seat on #team, before the feed: it never throws, and a feed that is
    // down must not cost the agent its seat (DOR-1042).
    await notifyAgentCreated({
      id: manifest.id,
      name: manifest.name,
      displayName: manifest.displayName,
      path: agentPath,
      origin: 'registered',
    });
    try {
      await mesh.activity?.emit({
        ...personActivityActor(),
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
    return manifest;
  },
});

/** `mesh.remove_agent`: take an agent off the team. */
export const meshRemoveAgentCapability = defineCapability({
  id: 'mesh.remove_agent',
  title: 'Remove an agent',
  description:
    'Take an agent off the team and delete its agent file, so discovery does not add it back. ' +
    'When git tracks that file, it stays and the folder is hidden from discovery instead ' +
    '(`blockedFromDiscovery`).',
  tier: 'act',
  area: null,
  areaNote: PERSON_DOOR_NOTE,
  input: z.object({ agentId: AgentId }),
  output: Success.extend({ blockedFromDiscovery: z.boolean() }),
  surfaces: {
    http: {
      method: 'delete',
      path: '/api/mesh/agents/{id}',
      params: MESH_AGENT_PARAM,
      audience: 'person',
      agentsUse:
        'Agents scan for, register and remove agents with mesh_discover, mesh_register and mesh_unregister.',
    },
  },
  invoke: async (deps, { agentId }) => {
    const mesh = meshOf(deps);
    const agent = mesh.meshCore.get(agentId);
    if (!agent) throw meshRefusal('MESH_AGENT_NOT_FOUND');
    if (agent.isSystem) throw meshRefusal('MESH_SYSTEM_AGENT_NOT_REMOVABLE');
    // Its `.dork/plugins/` stays on disk, so any installs there are left behind:
    // say so BEFORE unregistering, while the folder is still known.
    const orphanScanPath = mesh.meshCore.getProjectPath(agentId);
    if (orphanScanPath) {
      await logOrphanedInstalls({ projectPath: orphanScanPath, agentLabel: agent.name, logger });
    }
    const { manifestKept } = await mesh.meshCore.unregister(agentId);
    await mesh.activity?.emit({
      ...personActivityActor(),
      category: 'agent',
      eventType: 'agent.removed',
      resourceType: 'agent',
      resourceId: agentId,
      resourceLabel: agent.name,
      summary: `Removed agent ${agent.name}`,
    });
    return { success: true, blockedFromDiscovery: manifestKept };
  },
});

/** `mesh.delete_agent_data`: take an agent off the team and delete its `.dork` folder. */
export const meshDeleteAgentDataCapability = defineCapability({
  id: 'mesh.delete_agent_data',
  title: 'Remove an agent and its data',
  description:
    'Take an agent off the team and delete its `.dork` folder. Refused when git tracks the ' +
    'agent file: remove the agent without its data instead.',
  tier: 'act',
  area: null,
  areaNote: PERSON_DOOR_NOTE,
  input: z.object({ agentId: AgentId }),
  output: Success.extend({ deletedPath: z.string() }),
  surfaces: {
    http: {
      method: 'delete',
      path: '/api/mesh/agents/{id}/data',
      params: MESH_AGENT_PARAM,
      audience: 'person',
      agentsUse:
        'Agents scan for, register and remove agents with mesh_discover, mesh_register and mesh_unregister.',
    },
  },
  invoke: async (deps, { agentId }) => {
    const mesh = meshOf(deps);
    const agent = mesh.meshCore.get(agentId);
    if (!agent) throw meshRefusal('MESH_AGENT_NOT_FOUND');
    if (agent.isSystem) {
      throw meshRefusal('MESH_SYSTEM_AGENT_NOT_REMOVABLE', 'A system agent can’t be deleted.');
    }
    const projectPath = mesh.meshCore.getProjectPath(agentId);
    if (!projectPath) throw meshRefusal('MESH_AGENT_FOLDER_UNKNOWN');
    // The PLAIN boundary, not the dork-home seam: deleting from disk stays
    // inside the boundary even where registering the same folder is allowed.
    const folder = await inBoundary(projectPath);
    // A manifest git tracks belongs to somebody's repo; refuse rather than half-delete (DOR-1019).
    if (await isManifestGitTracked(folder, logger)) throw meshRefusal('MESH_MANIFEST_GIT_TRACKED');
    await mesh.meshCore.unregister(agentId);
    await removeDorkDirectory(folder);
    await mesh.activity?.emit({
      ...personActivityActor(),
      category: 'agent',
      eventType: 'agent.deleted',
      resourceType: 'agent',
      resourceId: agentId,
      resourceLabel: agent.name,
      summary: `Deleted agent ${agent.name} and data`,
      linkPath: '/agents',
    });
    return { success: true, deletedPath: path.join(folder, '.dork') };
  },
});

/** `mesh.deny_folder`: hide a folder from discovery. */
export const meshDenyFolderCapability = defineCapability({
  id: 'mesh.deny_folder',
  title: 'Hide a folder from discovery',
  description: 'Hide a folder from agent discovery, with an optional reason.',
  tier: 'act',
  area: null,
  areaNote: PERSON_DOOR_NOTE,
  input: DenyRequestSchema,
  output: Success,
  surfaces: {
    http: {
      method: 'post',
      path: '/api/mesh/deny',
      success: 201,
      audience: 'person',
      agentsUse: 'Agents hide a folder from discovery with mesh_deny.',
    },
  },
  invoke: async (deps, input) => {
    const { meshCore } = meshOf(deps);
    const folder = await inBoundary(input.path);
    try {
      await meshCore.deny(folder, input.reason, input.denier);
    } catch (err) {
      logger.warn('[mesh] write refused', { err });
      throw meshRefusal('MESH_DENY_REFUSED');
    }
    return { success: true };
  },
});

/**
 * `mesh.clear_denial`: let discovery see a folder again. The folder rides in
 * the query string, never a path segment: an encoded `/` in a path is refused
 * over Remote Access (DOR-4212).
 */
export const meshClearDenialCapability = defineCapability({
  id: 'mesh.clear_denial',
  title: 'Show a folder to discovery again',
  description: 'Clear a folder’s denial, so discovery sees it again. The folder goes in `path`.',
  tier: 'act',
  area: null,
  areaNote: PERSON_DOOR_NOTE,
  // Optional here so a missing folder gets the hand route's own sentence.
  input: z.object({ path: z.string().optional().describe('The denied folder, absolute.') }),
  output: Success,
  surfaces: {
    http: { method: 'delete', path: '/api/mesh/denied', query: ['path'], audience: 'person' },
  },
  invoke: async (deps, input) => {
    const folder = input.path;
    if (folder === undefined || folder === '') throw meshRefusal('MESH_DENIAL_PATH_MISSING');
    if (folder.includes('..') || folder.includes('\0')) {
      throw meshRefusal('MESH_DENIAL_PATH_NOT_ALLOWED');
    }
    await meshOf(deps).meshCore.undeny(await inBoundary(folder));
    return { success: true };
  },
});

/**
 * `mesh.set_access_rule`: allow or deny one namespace messaging another. `*`
 * on BOTH sides is the "Let all my agents talk to each other" switch.
 */
export const meshSetAccessRuleCapability = defineCapability({
  id: 'mesh.set_access_rule',
  title: 'Change who may message whom',
  description:
    'Allow or deny agents in one namespace messaging another. `*` on both sides turns the ' +
    'mesh-wide switch on (allow) or off (deny).',
  tier: 'act',
  area: null,
  areaNote: PERSON_DOOR_NOTE,
  input: UpdateAccessRuleRequestSchema,
  output: CrossNamespaceRuleSchema,
  surfaces: { http: { method: 'put', path: '/api/mesh/topology/access', audience: 'person' } },
  invoke: async (deps, input) => {
    const { meshCore } = meshOf(deps);
    const { sourceNamespace, targetNamespace, action } = input;
    try {
      if (action === 'allow') meshCore.allowCrossNamespace(sourceNamespace, targetNamespace);
      else meshCore.denyCrossNamespace(sourceNamespace, targetNamespace);
    } catch (err) {
      // A rule the registry refuses is the caller's mistake, never a server fault.
      logger.warn('[Mesh] access rule refused', { err });
      throw meshRefusal('MESH_ACCESS_RULE_REFUSED');
    }
    // Only a person's grants are written here, never the bridge's defaults.
    return { sourceNamespace, targetNamespace, action, origin: 'explicit' as const };
  },
});

/** A person's changes to the registry, in the mesh domain. */
export const MESH_WRITE_CAPABILITIES = [
  meshDiscoverCapability,
  meshRegisterAgentCapability,
  meshRemoveAgentCapability,
  meshDeleteAgentDataCapability,
  meshDenyFolderCapability,
  meshClearDenialCapability,
  meshSetAccessRuleCapability,
] as const;
