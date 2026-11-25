/**
 * The workspace reads and the pin as capabilities (DOR-84, ADR 261123-170830),
 * served by the capability mount on `/api/workspaces/*` and reachable by
 * agents through `dorkos call`.
 *
 * Making and removing a workspace stay hand routes (`routes/workspaces.ts`):
 * they show a person what a new workspace brings and wait for their password,
 * which a capability does not express yet. Reading one by id stays there too
 * until the mount orders its own routes against each other, and resolving a
 * path until its verb path is renamed.
 *
 * @module services/workspace/workspace-capabilities
 */
import { z } from 'zod';
import { WorkspaceSchema, WorktreeScanResultSchema } from '@dorkos/shared/workspace';

import { logger } from '../../lib/logger.js';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDomain,
} from '../core/capabilities/index.js';
import { getWorkspaceManager, getWorkspaceRoot, scanWorktrees } from './index.js';

/** `workspaces.list`: every workspace, or one project's, with the chats in each. */
export const workspacesListCapability = defineCapability({
  id: 'workspaces.list',
  title: 'List workspaces',
  description:
    'Every workspace DorkOS made (a checkout of a project kept apart for one piece of work), ' +
    'with the chats attached to each. Pass `projectKey` to list one project’s.',
  tier: 'observe',
  area: null,
  areaNote: 'reading',
  input: z.object({ projectKey: z.string().optional() }),
  // Documented as unknown until the list pages by cursor (the API lint's list rule).
  output: z.unknown(),
  surfaces: { http: { method: 'get', path: '/api/workspaces' } },
  invoke: async (_deps, input) => ({
    workspaces: await getWorkspaceManager().list({ projectKey: input.projectKey }),
  }),
});

/** `workspaces.scan`: the real checkouts on disk under the workspace root. */
export const workspacesScanCapability = defineCapability({
  id: 'workspaces.scan',
  title: 'List the real checkouts on disk',
  description:
    'Scan the workspace root and report every git checkout there: branch, uncommitted ' +
    'changes, ahead/behind and last commit. Writes to none of them. A checkout git cannot ' +
    'describe is reported with `readable: false` rather than left out.',
  tier: 'observe',
  area: null,
  areaNote: 'reading',
  input: z.object({}),
  output: WorktreeScanResultSchema,
  surfaces: { http: { method: 'get', path: '/api/workspaces/scan' } },
  invoke: async () => scanWorktrees(getWorkspaceRoot()),
});

/** `workspaces.pin`: keep a workspace at the top of the list, or stop. */
export const workspacesPinCapability = defineCapability({
  id: 'workspaces.pin',
  title: 'Pin a workspace',
  description:
    'Pin a workspace so it stays at the top of the list (`pinned: true`), or unpin it. ' +
    'Changes nothing on disk.',
  // A display preference that changes no file and no power, so it is allowed
  // from Wi-Fi like a read cursor (`wifi-level-census.test.ts`).
  tier: 'observe',
  area: null,
  areaNote: 'a display preference that changes nothing on disk',
  input: z.object({ id: z.string(), pinned: z.boolean() }),
  output: WorkspaceSchema,
  surfaces: { http: { method: 'post', path: '/api/workspaces/{id}/pin' } },
  invoke: async (_deps, input) => {
    try {
      return await getWorkspaceManager().setPinned(input.id, input.pinned);
    } catch (err) {
      logger.error('[workspaces] pin failed', { err });
      throw new CapabilityToolError({
        error: 'No workspace with that id.',
        code: 'WORKSPACE_NOT_FOUND',
      });
    }
  },
});

/** The workspace reads and the pin; on every server, as the workspace routes are. */
export const workspacesDomain: CapabilityDomain = {
  name: 'workspaces',
  capabilities: [workspacesListCapability, workspacesScanCapability, workspacesPinCapability],
};
