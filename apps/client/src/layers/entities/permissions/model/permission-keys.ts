/**
 * Query keys for the permission model, in one place so every write can
 * invalidate every read it affects.
 *
 * @module entities/permissions/model/permission-keys
 */

/** Every permission query sits under this prefix. */
const PERMISSIONS_KEY = ['permissions'] as const;

/** The query keys the permission hooks read under. */
export const permissionKeys = {
  /** Everything permission-shaped. */
  all: PERMISSIONS_KEY,
  /** `GET /api/permissions`. */
  overview: () => [...PERMISSIONS_KEY, 'overview'] as const,
  /** `GET /api/agents/:id/permissions`. */
  agent: (agentId: string) => [...PERMISSIONS_KEY, 'agent', agentId] as const,
  /** `GET /api/permissions/history`, optionally for one agent. */
  history: (agentId?: string) => [...PERMISSIONS_KEY, 'history', agentId ?? 'all'] as const,
};
