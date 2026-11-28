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
import { readerFor } from '../audit/audit-capabilities.js';
import { auditTrail } from '../audit/audit-trail.js';
import { readableSessionIds } from '../audit/session-visibility.js';
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
    'with the chats attached to each that the caller may read. Pass `projectKey` to list ' +
    'one project’s.',
  tier: 'observe',
  area: null,
  areaNote: 'reading',
  input: z.object({ projectKey: z.string().optional() }),
  // Documented as unknown until the list pages by cursor (the API lint's list rule).
  output: z.unknown(),
  surfaces: { http: { method: 'get', path: '/api/workspaces' } },
  invoke: async (_deps, input, context) => {
    const workspaces = await getWorkspaceManager().list({ projectKey: input.projectKey });
    // A person's own chat is theirs (spec `audit-trail` §3.4): an agent never
    // learns its id or title from the chats attached to a workspace.
    const reader = readerFor({ accounts: auditTrail()?.accounts }, context);
    const readable = readableSessionIds(
      reader,
      workspaces.flatMap((workspace) => workspace.sessions.map((s) => s.sessionId))
    );
    return {
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        sessions: workspace.sessions.filter((s) => readable.has(s.sessionId)),
      })),
    };
  },
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
  surfaces: { http: { method: 'get', path: '/api/workspaces/disk-checkouts' } },
  invoke: async () => scanWorktrees(getWorkspaceRoot()),
});

/** `workspaces.pin`: keep a workspace at the top of the list, or stop. */
export const workspacesPinCapability = defineCapability({
  id: 'workspaces.pin',
  title: 'Pin a workspace',
  description:
    'Pin a workspace so it stays at the top of the list (`pinned: true`), or unpin it. ' +
    'Changes nothing on disk.',
  // A person's display preference that changes no file and no power, so it is
  // allowed from Wi-Fi like a read cursor (`wifi-level-census.test.ts`), and
  // only a person sets it.
  tier: 'observe',
  area: null,
  areaNote: 'a person’s display preference; agents are refused',
  input: z.object({ id: z.string(), pinned: z.boolean() }),
  output: WorkspaceSchema,
  surfaces: { http: { method: 'post', path: '/api/workspaces/{id}/pin', audience: 'person' } },
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
