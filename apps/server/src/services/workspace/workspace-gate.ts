/**
 * What a new workspace brings, and who has to see it before any session or
 * hook runs there (DOR-2335).
 *
 * A workspace is a folder sessions run in. Two things about a new one can run
 * code nobody saw:
 *
 * - **A clone's tree.** `provider: 'clone'` fetches any repository, and its
 *   `.claude/settings.json` hooks and allow rules, `.mcp.json`, Codex and
 *   OpenCode config, and skills load in every session started there. A
 *   worktree is a checkout of the source repository itself, so it brings
 *   nothing the source's own sessions do not already load.
 * - **The source's `.dork/workspace.json` hooks.** `after_create` runs as shell
 *   when the workspace is made, and `before_remove` when it is removed, from
 *   the server's process rather than a session, so no permission prompt stands
 *   in front of either.
 *
 * ## The rule
 *
 * A clone is made ONCE, into a staging folder under the workspace root
 * (`.staging/`, which no scan lists), and {@link inspectWorkspace} reads it
 * there with the same readers the template gate uses
 * (`readTreeDisclosures`): harness configuration, each settings file written
 * out, and what its skills run. It also lists every link in the tree, since a
 * checkout keeps its links and a harness follows them, and the hooks the
 * source's `workspace.json` would run. Only after a {@link WorkspaceGate} lets
 * it through does the clone move into place, the `after_create` hooks that were
 * shown run, and the `before_remove` hooks that were shown are recorded on the
 * workspace, to be the only ones its removal runs.
 *
 * Who decides depends on who asked, as for templates:
 *
 * - **A person** ({@link personWorkspaceGate}) is SHOWN a workspace that brings
 *   anything (409 `workspace_needs_review`) and makes it knowingly with the
 *   review hash they were shown.
 * - **Anyone else** ({@link cardWorkspaceGate}) gets an approval card for every
 *   clone, and for a worktree whose source runs hooks, bound to the source,
 *   the folder, the cloned bytes, its links and the hooks.
 *
 * `WorkspaceService.ensure` refuses to make a workspace with no gate at all.
 *
 * @module server/services/workspace/workspace-gate
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { disclosesAnything } from '@dorkos/shared/marketplace-schemas';
import type { WorkspaceProviderType } from '@dorkos/shared/workspace';
import type { TreeDisclosures } from '../core/agent-templates/template-gate.js';
import type {
  ConfirmationProvider,
  ConfirmationRequest,
} from '../marketplace-mcp/confirmation-provider.js';
import { WORKSPACE_HOOKS_ENTRY_MARKER } from '../harness/hook-consent.js';
import type { WorkspaceHookConfig } from './hooks.js';

/** The hooks a workspace runs from the server, as they were shown. */
export interface WorkspaceHooksShown {
  /** Run as shell when the workspace is made. */
  after_create: string[];
  /** Run as shell when it is removed. */
  before_remove: string[];
}

/** One link in a cloned tree. */
export interface WorkspaceLink {
  /** Its path in the tree. */
  path: string;
  /** Where it points, as written. */
  target: string;
}

/** What a new workspace brings, read before any session or hook runs there. */
export interface WorkspaceInspection {
  /** The repository or folder it is made from. */
  source: string;
  /**
   * The source's real path when it is a folder on this machine (links
   * resolved), else the source as given: what a person's remembered approval
   * and an agent's remembered card are keyed by.
   */
  sourceRealPath: string;
  /** How it is made. */
  provider: WorkspaceProviderType;
  /** The folder it lands in. */
  destination: string;
  /** The cloned tree's content hash (`.git` left out); `null` for a worktree. */
  contentHash: string | null;
  /** Harness configuration, settings files and skill effects (a clone's only). */
  tree: TreeDisclosures | null;
  /** Every link in the cloned tree. */
  links: WorkspaceLink[];
  /** The source `workspace.json` hooks that run from the server. */
  hooks: WorkspaceHooksShown;
  /** What a person's approval binds: every field above, hashed. */
  reviewHash: string;
}

/** Leave the clone's own git metadata out of what a person approves. */
const skipGitDir = (posixPath: string): boolean => posixPath === '.git';

/** Every link under `root`, `.git` left out, in path order. */
async function listLinks(root: string): Promise<WorkspaceLink[]> {
  const links: WorkspaceLink[] = [];
  const visit = async (rel: string, dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (skipGitDir(childRel)) continue;
      const abs = path.join(dir, name);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) links.push({ path: childRel, target: await readlink(abs) });
      else if (stats.isDirectory()) await visit(childRel, abs);
    }
  };
  await visit('', root);
  return links;
}

/**
 * Read a staged clone: its hash (`.git` left out), what it brings, and its links.
 *
 * The readers are loaded only when a clone is read. They pull the marketplace
 * package's built code, and everything that imports the workspace module
 * (session routing, the rooms and communities services) would otherwise need
 * that package built just to load (DOR-2335).
 */
async function readClone(staged: string): Promise<[string, TreeDisclosures, WorkspaceLink[]]> {
  const [{ hashTree }, { readTreeDisclosures }] = await Promise.all([
    import('../marketplace/lib/content-hash.js'),
    import('../core/agent-templates/template-gate.js'),
  ]);
  return Promise.all([
    hashTree(staged, skipGitDir),
    readTreeDisclosures(staged),
    listLinks(staged),
  ]);
}

/** The hooks a `workspace.json` runs from the server; none when there is none. */
function hooksOf(config: WorkspaceHookConfig | null): WorkspaceHooksShown {
  return {
    after_create: [...(config?.hooks.after_create ?? [])],
    before_remove: [...(config?.hooks.before_remove ?? [])],
  };
}

/**
 * Read what a new workspace brings.
 *
 * @param opts.source - The repository or folder it is made from.
 * @param opts.provider - How it is made.
 * @param opts.destination - The folder it lands in.
 * @param opts.staged - The staged clone, for `clone`; absent for a worktree.
 * @param opts.hookConfig - The source's `workspace.json`, as it will run.
 * @returns The inspection.
 */
export async function inspectWorkspace(opts: {
  source: string;
  provider: WorkspaceProviderType;
  destination: string;
  staged?: string;
  hookConfig: WorkspaceHookConfig | null;
}): Promise<WorkspaceInspection> {
  const hooks = hooksOf(opts.hookConfig);
  const sourceRealPath = await realpath(opts.source).catch(() => opts.source);
  const [contentHash, tree, links] = opts.staged
    ? await readClone(opts.staged)
    : [null, null, [] as WorkspaceLink[]];
  const reviewHash = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        source: opts.source,
        provider: opts.provider,
        destination: opts.destination,
        contentHash,
        links,
        hooks,
      })
    )
    .digest('hex')}`;
  return {
    source: opts.source,
    sourceRealPath,
    provider: opts.provider,
    destination: opts.destination,
    contentHash,
    tree,
    links,
    hooks,
    reviewHash,
  };
}

/**
 * Whether a workspace brings anything a person has to see: harness
 * configuration, skills that run programs or use tools without asking, links,
 * or hooks that run from the server.
 *
 * @param inspection - The workspace's inspection.
 */
export function workspaceBringsAnything(inspection: WorkspaceInspection): boolean {
  return (
    inspection.hooks.after_create.length > 0 ||
    inspection.hooks.before_remove.length > 0 ||
    inspection.links.length > 0 ||
    (inspection.tree !== null &&
      (inspection.tree.findings.length > 0 || disclosesAnything(inspection.tree.disclosed)))
  );
}

/**
 * Decides whether an inspected workspace may be made. Resolves to let it
 * through; throws one of the errors below to stop, having left nothing.
 *
 * `person` marks the gate {@link personWorkspaceGate} builds: a person at this
 * machine asked, so git may run their repository's own hooks when it makes the
 * checkout. Any other gate leaves it unset, and git runs no hook or fsmonitor
 * (DOR-2335).
 */
export type WorkspaceGate = ((inspection: WorkspaceInspection) => Promise<void>) & {
  readonly person?: true;
};

/** A person has to see what the workspace brings first (409). */
export class WorkspaceNeedsReviewError extends Error {
  /** Machine-readable code on the response. */
  readonly code = 'workspace_needs_review';
  /**
   * Build the error.
   *
   * @param inspection - What the workspace brings, for the caller to show.
   */
  constructor(readonly inspection: WorkspaceInspection) {
    super(
      'This workspace brings settings, links or commands that run in its sessions or from ' +
        'DorkOS itself. Look at them, then ask again with the review hash you were shown.'
    );
    this.name = 'WorkspaceNeedsReviewError';
  }
}

/** A card is waiting for a person (202). */
export class WorkspaceApprovalPendingError extends Error {
  /** Machine-readable status on the response. */
  readonly status = 'requires_confirmation';
  /**
   * Build the error.
   *
   * @param token - The token to retry with once a person approved.
   * @param inspection - What the card shows.
   * @param reason - Why a second card appeared, when this replaced a stale one.
   */
  constructor(
    readonly token: string,
    readonly inspection: WorkspaceInspection,
    readonly reason?: string
  ) {
    super(
      'A person has to approve this workspace. Tell them an approval card is waiting, then ' +
        'retry with the same arguments and this confirmationToken.'
    );
    this.name = 'WorkspaceApprovalPendingError';
  }
}

/** A person turned it down, or nobody can be asked (403). */
export class WorkspaceDeclinedError extends Error {
  /**
   * Build the error.
   *
   * @param message - One plain sentence saying why.
   */
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceDeclinedError';
  }
}

/** The names of the three gate errors, which every caller passes through as-is. */
export const WORKSPACE_GATE_ERRORS: ReadonlySet<string> = new Set([
  'WorkspaceNeedsReviewError',
  'WorkspaceApprovalPendingError',
  'WorkspaceDeclinedError',
]);

/**
 * Where a person's decisions about their own worktrees' hooks are kept
 * (`worktree-consent.ts`): the operator-only hook decision store.
 */
export interface WorktreeHookMemory {
  /** Whether this exact decision was made before. */
  has(entry: string): boolean;
  /** Record that the person allowed it. */
  record(entry: string): void;
}

/**
 * The decision a person's approval of a worktree's hooks is remembered as:
 * `<source real path>@workspace-<digest>`, the digest over the real path, the
 * provider and both hook lists, so any changed command asks again. `undefined`
 * for anything else a workspace brings: a clone, or a tree's settings or links,
 * are never remembered.
 *
 * @param inspection - The workspace's inspection.
 */
export function worktreeHooksEntry(inspection: WorkspaceInspection): string | undefined {
  if (inspection.provider !== 'worktree' || inspection.tree !== null) return undefined;
  if (inspection.links.length > 0) return undefined;
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'worktree-hooks',
        inspection.sourceRealPath,
        inspection.provider,
        inspection.hooks.after_create,
        inspection.hooks.before_remove,
      ])
    )
    .digest('hex');
  return `${inspection.sourceRealPath}${WORKSPACE_HOOKS_ENTRY_MARKER}${digest}`;
}

/**
 * The gate for a person: a workspace that brings nothing is made; one that
 * brings anything is made only when the caller sends back the review hash it
 * was shown. A worktree of their own repository whose hooks they already
 * allowed, unchanged, is made without asking again, and allowing one records
 * that (`memory`). A clone is never remembered.
 *
 * @param approvedReviewHash - The review hash the person was shown, on the retry.
 * @param memory - Their remembered worktree decisions; none when absent.
 */
export function personWorkspaceGate(
  approvedReviewHash?: string,
  memory?: WorktreeHookMemory
): WorkspaceGate {
  const gate = async (inspection: WorkspaceInspection): Promise<void> => {
    if (!workspaceBringsAnything(inspection)) return;
    const entry = worktreeHooksEntry(inspection);
    if (entry !== undefined && memory?.has(entry)) return;
    if (approvedReviewHash !== undefined && approvedReviewHash === inspection.reviewHash) {
      if (entry !== undefined) memory?.record(entry);
      return;
    }
    throw new WorkspaceNeedsReviewError(inspection);
  };
  return Object.assign(gate, { person: true as const });
}

/** What {@link cardWorkspaceGate} binds its card to, beyond the inspection. */
export interface CardWorkspaceGateOptions {
  /** The approval primitive's provider; absent when approvals are off. */
  provider: ConfirmationProvider | undefined;
  /** The workspace's `projectKey/key`, the card's name for it. */
  name: string;
  /** The token from an earlier `requires_confirmation`, on the retry. */
  confirmationToken?: string;
  /** Who asked, for the card. */
  requestedBy?: string;
  /**
   * With no token, look for an open card of exactly this request before
   * raising another (a requester that lost its token to a restart).
   */
  reopenOpenCard?: boolean;
}

/**
 * The request a workspace card is raised for and resolved against: bound to
 * its name, source, provider, folder, cloned bytes, links and hooks
 * (`bindingOf` in the confirmation provider).
 */
function cardRequestOf(
  opts: CardWorkspaceGateOptions,
  inspection: WorkspaceInspection
): ConfirmationRequest {
  return {
    packageName: opts.name,
    operation: 'create-workspace',
    projectPath: inspection.destination,
    ...(inspection.contentHash !== null && { contentHash: inspection.contentHash }),
    workspaceDisclosure: {
      source: inspection.source,
      provider: inspection.provider,
      findings: inspection.tree?.findings.map((f) => f.path) ?? [],
      settings: inspection.tree?.settings ?? [],
      disclosed: inspection.tree?.disclosed ?? null,
      links: inspection.links,
      hooks: inspection.hooks,
    },
    origin: { source: inspection.source },
    ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
  };
}

/**
 * The gate for anyone who is not a person at this machine: an approval card
 * for every clone (a fetched repository shapes every session there, whatever
 * it declares) and for a worktree that brings anything; a plain worktree of
 * the source is made without asking.
 *
 * @param opts - The provider and what the card binds.
 */
export function cardWorkspaceGate(opts: CardWorkspaceGateOptions): WorkspaceGate {
  return async (inspection) => {
    if (inspection.provider !== 'clone' && !workspaceBringsAnything(inspection)) return;
    if (!opts.provider) {
      throw new WorkspaceDeclinedError(
        'Making this workspace needs a person’s approval, and approvals are not available on ' +
          'this server right now.'
      );
    }
    const request = cardRequestOf(opts, inspection);
    const token =
      opts.confirmationToken ??
      (opts.reopenOpenCard ? await opts.provider.reopen?.(request) : undefined);
    const answer = token
      ? await opts.provider.resolveToken(token, request)
      : await opts.provider.requestInstallConfirmation(request);
    if (answer.status === 'approved') return;
    if (answer.status === 'pending') {
      throw new WorkspaceApprovalPendingError(answer.token, inspection, answer.reason);
    }
    throw new WorkspaceDeclinedError(answer.reason ?? 'A person turned down this workspace.');
  };
}

/**
 * A card gate for callers that cannot carry a token back: a session turn that
 * asks for a workspace, and an agent's managed checkout (`resolve-session-cwd`).
 * It remembers the pending token per workspace, keyed by the source's real
 * path and the folder it lands in (two sources that share a folder name are
 * two workspaces), so each turn resolves the one card instead of raising
 * another. After a restart it has no token, and reopens the card still open
 * for exactly this request rather than leaving it orphaned beside a new one.
 */
export class RememberedWorkspaceCards {
  private readonly pending = new Map<string, string>();

  /**
   * The gate for one workspace.
   *
   * @param opts - As {@link cardWorkspaceGate}, without a token: the memory supplies it.
   */
  gateFor(opts: Omit<CardWorkspaceGateOptions, 'confirmationToken'>): WorkspaceGate {
    return async (inspection) => {
      const key = `${inspection.sourceRealPath}\0${inspection.destination}`;
      const token = this.pending.get(key);
      try {
        await cardWorkspaceGate({
          ...opts,
          reopenOpenCard: true,
          ...(token && { confirmationToken: token }),
        })(inspection);
        this.pending.delete(key);
      } catch (err) {
        if (err instanceof WorkspaceApprovalPendingError) this.pending.set(key, err.token);
        else this.pending.delete(key);
        throw err;
      }
    };
  }
}
