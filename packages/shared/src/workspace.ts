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
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

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

// === Ownership ===

/**
 * Who a workspace belongs to, or `null` for the original semantics: a
 * unit-of-work checkout owned by nobody in particular.
 *
 * `kind` is a single-member union today and stays a union on purpose — the next
 * owner (a room, spec `project-rooms`) is a different kind, not a different
 * shape of the same one.
 *
 * `ref` is the agent's **`agentPath`**, never its ULID. The `agents` table is a
 * derived cache the reconciler may delete and rebuild, re-registering every
 * agent under a fresh ULID (`packages/db/src/schema/agent-identity.ts`); the
 * path survives that, and `agents.project_path` being `unique` makes it a
 * legitimate key. Same precedent as DOR-446 identity tokens, with the same
 * limitation: move the agent's directory and the workspace becomes unowned.
 */
export const WorkspaceOwnerSchema = z
  .object({
    kind: z.literal('agent'),
    ref: z.string().min(1),
  })
  .openapi('WorkspaceOwner');

/** Who a workspace belongs to — see {@link WorkspaceOwnerSchema}. */
export type WorkspaceOwner = z.infer<typeof WorkspaceOwnerSchema>;

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
    // `null` = unit-of-work, which is what every workspace was before ownership
    // existed — so pre-change rows and sidecar manifests need no backfill.
    owner: WorkspaceOwnerSchema.nullable().default(null),
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
    // Stamped only on the call that CREATES the workspace. `ensure` is
    // reuse-or-create, and re-owning an existing checkout from a later caller
    // would let one agent quietly adopt another's tree.
    owner: WorkspaceOwnerSchema.nullish(),
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

/**
 * The outcome of a `sweep` — removed ids and the reason each survivor was kept.
 *
 * `owned` is structural rather than conventional: an agent-owned checkout is
 * skipped because of what it IS, not because somebody remembered to pin it.
 * Unregistering an agent says nothing about the code in its tree.
 */
export interface SweepResult {
  removed: string[];
  skipped: Array<{ id: string; reason: 'owned' | 'pinned' | 'dirty' | 'active' }>;
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

// === Adoption scan (DOR-1056) ===

/**
 * One checkout found on disk under the workspace root by the read-only adoption
 * scan. This is filesystem truth, not the managed layer: it reports the git
 * worktrees agents actually create (the `.gtrconfig` flow points them here), so
 * the page can tell the truth about what exists rather than about what the
 * manager provisioned.
 *
 * Every git-derived field is nullable because a checkout can be unreadable — its
 * source repo moved, its `.git` link is broken, git timed out. Such a row still
 * appears, with `readable: false`; it is never silently dropped, because a
 * checkout you cannot read is exactly the one worth seeing.
 *
 * `branch` is `null` on a readable checkout whose HEAD is detached.
 */
export const WorktreeScanEntrySchema = z
  .object({
    /** Absolute path of the checkout directory. */
    path: z.string(),
    /** Directory name — the checkout's identity within its project folder. */
    name: z.string(),
    /** The folder directly under the workspace root that holds this checkout. */
    project: z.string(),
    /** Absolute path of the repository this checkout shares history with. */
    repoPath: z.string().nullable(),
    /** Checked-out branch; `null` when HEAD is detached or unreadable. */
    branch: z.string().nullable(),
    /** Files with uncommitted or untracked changes. */
    changedFiles: z.number().int().nullable(),
    /** Commits this branch has that its upstream does not; `null` with no upstream. */
    ahead: z.number().int().nullable(),
    /** Commits the upstream has that this branch does not; `null` with no upstream. */
    behind: z.number().int().nullable(),
    /**
     * The branch tracks an upstream that no longer exists — git's `[gone]`.
     * Almost always means the pull request merged and the remote branch was
     * deleted, which makes this the single most useful "done with it" signal in
     * the scan. Distinct from having no upstream at all: `ahead`/`behind` are
     * `null` in both cases, but only one of them says the work landed.
     */
    upstreamGone: z.boolean(),
    /** ISO timestamp of the newest commit on HEAD. */
    lastCommitAt: z.string().nullable(),
    /** False when git could not describe this checkout — the row is a stub. */
    readable: z.boolean(),
  })
  .openapi('WorktreeScanEntry');

/** One checkout found by the adoption scan — see {@link WorktreeScanEntrySchema}. */
export type WorktreeScanEntry = z.infer<typeof WorktreeScanEntrySchema>;

/**
 * A directory the scan could not list. Reported rather than skipped: a folder
 * that fails to open hides however many checkouts were inside it, and a scan
 * that quietly returns fewer rows is exactly the kind of lie this page exists to
 * stop telling. A root that simply does not exist yet is NOT a warning — that is
 * the ordinary empty state.
 */
export const WorktreeScanWarningSchema = z
  .object({
    /** Absolute path of the directory that could not be listed. */
    path: z.string(),
    /** Why it could not be read — an errno code such as `EACCES`. */
    reason: z.string(),
  })
  .openapi('WorktreeScanWarning');

/** A directory the scan could not list — see {@link WorktreeScanWarningSchema}. */
export type WorktreeScanWarning = z.infer<typeof WorktreeScanWarningSchema>;

/** The result of one adoption scan: the root that was scanned and what it holds. */
export const WorktreeScanResultSchema = z
  .object({
    /** The workspace root the scan walked. */
    root: z.string(),
    /** Every checkout found, newest commit first within each project. */
    worktrees: z.array(WorktreeScanEntrySchema),
    /** Directories that could not be listed, and so may hide checkouts. */
    warnings: z.array(WorktreeScanWarningSchema),
  })
  .openapi('WorktreeScanResult');

/** The result of one adoption scan — see {@link WorktreeScanResultSchema}. */
export type WorktreeScanResult = z.infer<typeof WorktreeScanResultSchema>;

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

  /**
   * Reclaim ready workspaces beyond the retention cap, oldest `lastUsedAt`
   * first. Pinned, session-attached, and dirty workspaces are kept (reported
   * in `skipped`); a `null` cap disables reclamation entirely.
   */
  sweep(): Promise<SweepResult>;
}
