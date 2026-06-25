/**
 * Zod schemas + hexagonal interfaces for server-managed isolated workspaces.
 *
 * A {@link Workspace} is an isolated checkout — one per unit of work (issue id /
 * spec slug) — that an agent session binds to via `SessionOpts.cwd`. This module
 * defines the entity, the {@link WorkspaceProvider} port (`worktree` | `clone`),
 * the {@link WorkspaceManager} service contract, and the request/result DTOs the
 * HTTP API + `Transport` speak. The server implementation lives in
 * `apps/server/src/services/workspace/`.
 *
 * @module shared/workspace
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// === Port block ===

/**
 * Offset of each named dev port within a workspace's allocated contiguous block.
 * A workspace owns `[portBase, portBase + portBlockSize)`; these three named
 * ports map to fixed offsets so the existing `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT`
 * env contract is preserved (Conductor model). Remaining slots are reserved.
 */
export const WORKSPACE_PORT_OFFSETS = {
  DORKOS_PORT: 0,
  VITE_PORT: 1,
  SITE_PORT: 2,
} as const;

/** The three named dev ports derived from a workspace's port block. */
export interface WorkspacePorts {
  DORKOS_PORT: number;
  VITE_PORT: number;
  SITE_PORT: number;
}

/**
 * Derive the named dev ports from a workspace's allocated port-block base.
 *
 * @param portBase - First port of the workspace's contiguous block.
 */
export function derivePorts(portBase: number): WorkspacePorts {
  return {
    DORKOS_PORT: portBase + WORKSPACE_PORT_OFFSETS.DORKOS_PORT,
    VITE_PORT: portBase + WORKSPACE_PORT_OFFSETS.VITE_PORT,
    SITE_PORT: portBase + WORKSPACE_PORT_OFFSETS.SITE_PORT,
  };
}

// === Keys ===

/** Allowed characters in a sanitized workspace/project key (Symphony §9). */
export const WORKSPACE_KEY_REGEX = /^[A-Za-z0-9._-]+$/;

/**
 * Sanitize an arbitrary unit-of-work identifier into a safe workspace key —
 * every character outside `[A-Za-z0-9._-]` becomes `_`.
 *
 * @param raw - Raw issue identifier or spec slug.
 */
export function sanitizeWorkspaceKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '_');
}

// === Enums ===

/** Workspace provider kind. `worktree` (git worktree) and `clone` ship in v1. */
export const WorkspaceProviderTypeSchema = z
  .enum(['worktree', 'clone'])
  .openapi('WorkspaceProviderType');

export type WorkspaceProviderType = z.infer<typeof WorkspaceProviderTypeSchema>;

/** Lifecycle status of a workspace. */
export const WorkspaceStatusSchema = z
  .enum(['provisioning', 'ready', 'failed', 'removing'])
  .openapi('WorkspaceStatus');

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

// === Entity ===

/**
 * A server-managed isolated workspace. Persisted file-first (a sidecar manifest
 * is the source of truth; the SQLite `workspaces` table is a derived cache —
 * ADR-0043). `hostname`/`url` are reserved for the v2 naming layer (DOR-91) and
 * are always `null` in v1.
 */
export const WorkspaceSchema = z
  .object({
    id: z.string(),
    projectKey: z.string(),
    key: z.string().regex(WORKSPACE_KEY_REGEX),
    path: z.string(),
    source: z.string(),
    branch: z.string().nullable(),
    provider: WorkspaceProviderTypeSchema,
    status: WorkspaceStatusSchema,
    portBase: z.number().int(),
    portBlockSize: z.number().int(),
    hostname: z.string().nullable(),
    url: z.string().nullable(),
    pinned: z.boolean(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
  })
  .openapi('Workspace');

export type Workspace = z.infer<typeof WorkspaceSchema>;

// === DTOs ===

/** Request to provision-or-reuse a workspace, keyed by `(projectKey, key)`. */
export const EnsureWorkspaceRequestSchema = z
  .object({
    projectKey: z.string(),
    key: z.string(),
    source: z.string(),
    provider: WorkspaceProviderTypeSchema.optional(),
  })
  .openapi('EnsureWorkspaceRequest');

export type EnsureWorkspaceRequest = z.infer<typeof EnsureWorkspaceRequestSchema>;

/** Low-level provisioning request handed to a {@link WorkspaceProvider}. */
export interface WorkspaceCreateRequest {
  projectKey: string;
  key: string;
  path: string;
  source: string;
  branch: string;
}

/** What a provider returns after provisioning a checkout. */
export interface ProviderResult {
  path: string;
  branch: string | null;
}

/** The result of a dirty-state check — the cleanup safety gate. */
export interface DirtyState {
  /** True if removal must be refused without an explicit force. */
  dirty: boolean;
  /** Paths with uncommitted (staged or unstaged) changes. */
  uncommitted: string[];
  /** Untracked file paths. */
  untracked: string[];
  /** Count of local commits not present on the upstream branch. */
  unpushed: number;
}

/** The outcome of a `remove` call — a refusal carries the blocking dirty state. */
export interface RemoveResult {
  removed: boolean;
  blocked?: 'dirty';
  dirty?: DirtyState;
}

/** The outcome of a `sweep` — removed ids and the reason each survivor was kept. */
export interface SweepResult {
  removed: string[];
  skipped: Array<{ id: string; reason: 'pinned' | 'dirty' | 'active' }>;
}

/** A session attached to a workspace (its resolved cwd is under the path). */
export interface AttachedSession {
  sessionId: string;
  cwd: string;
  title?: string;
}

/** A workspace plus the sessions currently bound to it (for the UI). */
export type WorkspaceWithSessions = Workspace & {
  sessions: AttachedSession[];
  /** Best-effort dirty state for the list view; omitted if it could not be computed. */
  dirty?: DirtyState;
};

// === Hexagonal port: WorkspaceProvider ===

/**
 * The provisioning port. Each concrete provider (`worktree`, `clone`, and later
 * `container`/`remote`) owns the VCS/runtime mechanics of materializing and
 * tearing down a checkout. Mirrors the `AgentRuntime`/`Transport` hexagonal idiom.
 */
export interface WorkspaceProvider {
  readonly type: WorkspaceProviderType;

  /**
   * Materialize the checkout at `req.path`. Throws on failure (the caller marks
   * the workspace `failed`). MUST validate the path is inside the workspace root.
   */
  create(req: WorkspaceCreateRequest): Promise<ProviderResult>;

  /**
   * Tear down the checkout. Refuses a dirty workspace unless `opts.force` is set;
   * callers gate this on {@link WorkspaceProvider.isDirty}.
   */
  remove(workspace: Workspace, opts: { force: boolean }): Promise<void>;

  /** Report uncommitted / untracked / unpushed state — the cleanup safety gate. */
  isDirty(workspace: Workspace): Promise<DirtyState>;
}

// === Service contract: WorkspaceManager ===

/**
 * The workspace lifecycle service. Composes providers + port allocation +
 * hooks + file-first persistence. `ensure` is idempotent on `(projectKey, key)`
 * (reuse-or-create); `resolveByPath` powers the session-view workspace indicator.
 */
export interface WorkspaceManager {
  /** Reuse-or-create the workspace for `(projectKey, key)`; bumps `lastUsedAt`. */
  ensure(req: EnsureWorkspaceRequest): Promise<Workspace>;

  /** List workspaces (optionally one project), each with its attached sessions. */
  list(filter?: { projectKey?: string }): Promise<WorkspaceWithSessions[]>;

  /** Fetch one workspace by id, or `null`. */
  get(id: string): Promise<Workspace | null>;

  /** Resolve an absolute path (e.g. a session cwd) to its containing workspace. */
  resolveByPath(absPath: string): Promise<Workspace | null>;

  /** Remove a workspace; refuses a dirty one unless `opts.force`. */
  remove(id: string, opts: { force: boolean }): Promise<RemoveResult>;

  /** Pin or unpin a workspace (pinned workspaces are exempt from `sweep`). */
  setPinned(id: string, pinned: boolean): Promise<Workspace>;

  /** Reclaim eligible workspaces (terminal-state + cap/age), all dirty-gated. */
  sweep(): Promise<SweepResult>;
}
