/**
 * Workspace subsystem barrel + factory (DOR-84).
 *
 * `createWorkspaceSubsystem` wires the store, allocator, providers, service, and
 * reconciler from resolved config; `set/getWorkspaceManager` provide the
 * module-singleton the routes read (mirrors the `runtimeRegistry` access idiom).
 *
 * @module server/services/workspace
 */
import path from 'node:path';
import type { Db } from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type {
  AttachedSession,
  EnsureWorkspaceRequest,
  Workspace,
  WorkspaceManager,
} from '@dorkos/shared/workspace';
import type { ConfirmationProvider } from '../marketplace-mcp/confirmation-provider.js';
import {
  cardWorkspaceGate,
  personWorkspaceGate,
  RememberedWorkspaceCards,
  type WorkspaceGate,
  type WorktreeHookMemory,
} from './workspace-gate.js';
import { recordApprovedEntry, storedHookDecisions } from '../harness/hook-consent.js';
import { WorkspaceStore } from './workspace-store.js';
import { PortAllocator } from './port-allocator.js';
import { WorktreeProvider } from './providers/worktree.js';
import { CloneProvider } from './providers/clone.js';
import { WorkspaceService } from './workspace-service.js';
import { WorkspaceReconciler } from './workspace-reconciler.js';

/** The resolved `workspace` config section. */
export type WorkspaceConfig = UserConfig['workspace'];

/** The wired workspace subsystem. */
export interface WorkspaceSubsystem {
  service: WorkspaceService;
  reconciler: WorkspaceReconciler;
  store: WorkspaceStore;
  root: string;
}

/**
 * Resolve where workspace checkouts live — the one place that answer is derived.
 *
 * Both the managed subsystem and the read-only adoption scan must walk the same
 * directory, and `os.homedir()` is banned here (Hard Rule 3), so the root always
 * comes from the resolved data dir unless config names another.
 *
 * @param opts.dorkHome - The resolved data dir.
 * @param opts.config - The resolved `workspace` config section.
 */
export function resolveWorkspaceRoot(opts: { dorkHome: string; config: WorkspaceConfig }): string {
  return opts.config.rootPath ?? path.join(opts.dorkHome, 'workspaces');
}

/**
 * Wire the workspace subsystem from config + the DB handle.
 *
 * @param opts.db - The consolidated DB handle.
 * @param opts.dorkHome - The resolved data dir (root = `<dorkHome>/workspaces` unless overridden).
 * @param opts.config - The resolved `workspace` config section.
 * @param opts.listAttachedSessions - Resolver for sessions bound to a workspace path.
 */
export function createWorkspaceSubsystem(opts: {
  db: Db;
  dorkHome: string;
  config: WorkspaceConfig;
  listAttachedSessions?: (workspacePath: string) => AttachedSession[] | Promise<AttachedSession[]>;
}): WorkspaceSubsystem {
  const root = resolveWorkspaceRoot(opts);
  const store = new WorkspaceStore(opts.db, root);
  const allocator = new PortAllocator(
    { portBase: opts.config.portBase, portBlockSize: opts.config.portBlockSize },
    () => store.list().map((w) => w.portBase)
  );
  const providers = {
    worktree: new WorktreeProvider(root),
    clone: new CloneProvider(root),
  };
  const service = new WorkspaceService({
    store,
    allocator,
    providers,
    config: {
      defaultProvider: opts.config.defaultProvider,
      portBlockSize: opts.config.portBlockSize,
      retentionCap: opts.config.retentionCap,
    },
    listAttachedSessions: opts.listAttachedSessions,
  });
  const reconciler = new WorkspaceReconciler(store);
  return { service, reconciler, store, root };
}

/**
 * The WorkspaceManager as the server calls it: `ensure` takes the gate that
 * decides who sees what a new workspace brings (DOR-2335).
 */
export interface GatedWorkspaceManager extends Omit<WorkspaceManager, 'ensure'> {
  /** Reuse or make a workspace; making one goes through `gate`. */
  ensure(req: EnsureWorkspaceRequest, gate?: WorkspaceGate): Promise<Workspace>;
}

let active: GatedWorkspaceManager | null = null;

/** Register the active WorkspaceManager at bootstrap. */
export function setWorkspaceManager(manager: GatedWorkspaceManager): void {
  active = manager;
}

/** Read the active WorkspaceManager (throws if bootstrap has not run). */
export function getWorkspaceManager(): GatedWorkspaceManager {
  if (!active) throw new Error('WorkspaceManager not initialized');
  return active;
}

/**
 * A person's remembered decisions about their own worktrees' hooks, in the
 * operator-only hook decision store (DOR-2335): listed by
 * `dorkos harness hooks --list`, forgotten by `--revoke <source path>`.
 */
const worktreeHookMemory: WorktreeHookMemory = {
  has: (entry) => storedHookDecisions().approved.includes(entry),
  record: (entry) => recordApprovedEntry(entry, "approving a worktree's workspace hooks"),
};

let approvals: () => ConfirmationProvider | undefined = () => undefined;
const rememberedCards = new RememberedWorkspaceCards();

/**
 * Register where workspace approval cards are raised (DOR-2335): the
 * marketplace's confirmation provider, composed later in boot.
 *
 * @param getter - Reads the provider; `undefined` while there is none.
 */
export function setWorkspaceApprovals(getter: () => ConfirmationProvider | undefined): void {
  approvals = getter;
}

/** Who is asking for a new workspace, and what they sent back. */
export interface WorkspaceCaller {
  /** A person at this machine (`trustedCaller`), rather than an agent. */
  trusted: boolean;
  /** The workspace's `projectKey/key`, the card's name for it. */
  name: string;
  /** Who asked, for the card. */
  requestedBy?: string;
  /** The review hash a person was shown, on their retry. */
  approvedReviewHash?: string;
  /**
   * The token from an earlier card, on an agent's retry. A caller that cannot
   * carry one back (a session turn, a managed checkout) leaves it out, and the
   * pending card is remembered for it instead.
   */
  confirmationToken?: string;
  /** Whether this caller can carry a token back; `false` remembers it here. */
  carriesToken: boolean;
}

/**
 * The gate for a caller (DOR-2335): a person is shown what a workspace brings;
 * anyone else gets a card.
 *
 * @param caller - Who is asking, and what they sent back.
 */
export function workspaceGateFor(caller: WorkspaceCaller): WorkspaceGate {
  if (caller.trusted) return personWorkspaceGate(caller.approvedReviewHash, worktreeHookMemory);
  const card = {
    provider: approvals(),
    name: caller.name,
    ...(caller.requestedBy && { requestedBy: caller.requestedBy }),
  };
  return caller.carriesToken
    ? cardWorkspaceGate({
        ...card,
        ...(caller.confirmationToken && { confirmationToken: caller.confirmationToken }),
      })
    : rememberedCards.gateFor(card);
}

let scanRoot: string | null = null;

/**
 * Register the root the adoption scan walks. Registered unconditionally at
 * bootstrap — reading which checkouts exist is filesystem truth, and stays true
 * whether or not the managed layer (`workspace.enabled`) is switched on.
 *
 * @param root - The resolved workspace root.
 */
export function setWorkspaceRoot(root: string): void {
  scanRoot = root;
}

/** Read the registered workspace root (throws if bootstrap has not run). */
export function getWorkspaceRoot(): string {
  if (!scanRoot) throw new Error('Workspace root not initialized');
  return scanRoot;
}

export { WorkspaceService } from './workspace-service.js';
export { UnsafeWorkspaceSourceError } from './providers/git.js';
export { WorkspaceStore } from './workspace-store.js';
export { WorkspaceReconciler } from './workspace-reconciler.js';
export { scanWorktrees } from './worktree-scan.js';
export {
  WorkspaceApprovalPendingError,
  WorkspaceDeclinedError,
  WorkspaceNeedsReviewError,
  type WorkspaceGate,
  type WorkspaceInspection,
} from './workspace-gate.js';
