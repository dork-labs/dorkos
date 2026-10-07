import type { BrowserRuntimeOwnerResolution } from './runtime-owner-resolution.js';
import nodePath from 'node:path';
import { approvals, workspaces, eq, type Db } from '@dorkos/db';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import { hashApprovalInput } from '../../core/approvals/index.js';
import { findOwnerAccount } from '../../core/auth/accounts.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import { BrowserApiRefusal } from '../api/service.js';

/** An original owner approval is bound to the whole delegated-open input. */
export type RuntimeWorkspaceDelegationInput = Readonly<{
  workspaceId: string;
  sessionId: string;
}>;
/** Opaque constructor-private authority; a workspace selector alone is never permission. */
export interface RuntimeWorkspaceDelegation {
  readonly kind: 'runtime-workspace-delegation';
}
type Cell = Readonly<{
  principal: ServerPrincipalProof;
  workspaceId: string;
  path: string;
  current(): boolean;
}>;
const cells = new WeakMap<RuntimeWorkspaceDelegation, Cell>();
/** Capture only the original bank-issued cell for this exact runtime turn. */
export function captureRuntimeWorkspaceDelegation(
  token: RuntimeWorkspaceDelegation,
  principal: ServerPrincipalProof
): Readonly<Cell> {
  const cell = cells.get(token);
  if (
    !cell ||
    !isServerPrincipal(principal) ||
    principal.claims.kind !== 'runtime' ||
    cell.principal.claims.kind !== 'runtime' ||
    principal.claims.bindingId !== cell.principal.claims.bindingId ||
    principal.claims.canonicalSessionId !== cell.principal.claims.canonicalSessionId ||
    principal.claims.agentId !== cell.principal.claims.agentId ||
    principal.claims.canonicalCwd !== cell.principal.claims.canonicalCwd ||
    !cell.current()
  )
    throw new BrowserApiRefusal('inaccessible');
  return cell;
}
/** Existing human approval cards issue finite grants; SQL workspace ownership is never changed. */
export function createRuntimeWorkspaceDelegations(options: {
  db: Db;
  owners?: BrowserRuntimeOwnerResolution;
  enabled(): boolean;
  refuse(): Error;
}) {
  const db = options.db,
    enabled = options.enabled.bind(options),
    refuse = options.refuse.bind(options);
  const bank = new Set<Cell>();
  const spent = new Map<string, number>();
  let closed = false;
  const workspace = (workspaceId: string) => {
    if (closed || !enabled() || closed) throw refuse();
    const row = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (
      !row ||
      row.status !== 'ready' ||
      row.ownerKind !== null ||
      row.ownerRef !== null ||
      !nodePath.isAbsolute(row.path)
    )
      throw refuse();
    return row;
  };
  return Object.freeze({
    /** The exact current workspace path is shown and hashed into the existing approval card. */
    describe(input: RuntimeWorkspaceDelegationInput): string {
      const row = workspace(input.workspaceId);
      return `Workspace: ${row.id}\nPath: ${row.path}\nAgent session: ${input.sessionId}\nPermission: open a separate browser for this agent’s current task`;
    },
    /** Spend only a real consumed owner decision for this exact input, author and session. */
    issue(
      input: RuntimeWorkspaceDelegationInput,
      wholeInput: unknown,
      context: CapabilityHandlerContext,
      principals: ConnectorRuntimePrincipalService,
      authors: AuthorRegistry
    ): RuntimeWorkspaceDelegation {
      const principal = context.serverPrincipal,
        identity = context.identity,
        approval = context.approval;
      if (
        !isServerPrincipal(principal) ||
        principal.claims.kind !== 'runtime' ||
        (!options.owners && principal.claims.owner.kind !== 'user') ||
        !identity ||
        identity.inactive ||
        context.trusted ||
        context.signal?.aborted ||
        approval?.via !== 'approval' ||
        !approval.decidedByUserId ||
        context.sessionId !== input.sessionId ||
        principal.claims.canonicalSessionId !== input.sessionId ||
        principal.claims.agentPath !== identity.agentPath ||
        !principal.claims.canonicalCwd ||
        !nodePath.isAbsolute(principal.claims.canonicalCwd)
      )
        throw refuse();
      const now = Date.now();
      for (const [id, expires] of spent) if (expires <= now) spent.delete(id);
      if (spent.size >= 64 || spent.has(approval.approvalId)) throw refuse();
      // Reserve before any original mode/author/SQL callback can reenter this issuer.
      spent.set(approval.approvalId, Number.POSITIVE_INFINITY);
      const claims = principal.claims;
      const currentPrincipal = principals.isPrincipalCurrent.bind(principals),
        resolveAuthor = authors.resolveAgent.bind(authors),
        bindOwner = authors.bindOwner.bind(authors),
        isOwner = authors.isOwner.bind(authors);
      const mappedOwner = options.owners?.resolve(
        principal,
        () => !closed && enabled() && currentPrincipal(principal) && !context.signal?.aborted
      );
      const accountId =
        mappedOwner?.accountId ??
        (!options.owners && claims.owner.kind === 'user' ? claims.owner.userId : undefined);
      if (!accountId || (options.owners && !mappedOwner)) throw refuse();
      const row = workspace(input.workspaceId),
        author = resolveAuthor(claims.agentPath, identity.displayName),
        owner = bindOwner(accountId);
      if (typeof claims.canonicalCwd !== 'string') throw refuse();
      const relative = nodePath.relative(row.path, claims.canonicalCwd);
      if (
        relative === '..' ||
        relative.startsWith('..' + nodePath.sep) ||
        nodePath.isAbsolute(relative)
      )
        throw refuse();
      const change = this.describe(input),
        inputHash = hashApprovalInput({ input: wholeInput, change });
      if (context.approvedChange !== change || approval.decidedByUserId !== accountId)
        throw refuse();
      let retired = false;
      const evaluate = () => {
        if (
          closed ||
          !enabled() ||
          !currentPrincipal(principal) ||
          context.signal?.aborted ||
          (mappedOwner && !mappedOwner.current())
        )
          return false;
        const decision = db
          .select()
          .from(approvals)
          .where(eq(approvals.id, approval.approvalId))
          .get();
        const live = db.select().from(workspaces).where(eq(workspaces.id, row.id)).get();
        const activeAuthor = resolveAuthor(claims.agentPath, identity.displayName);
        const account = findOwnerAccount(db);
        const now = Date.now();
        return (
          !!decision &&
          decision.capabilityId === 'browser.open_delegated' &&
          decision.inputHash === inputHash &&
          decision.state === 'granted' &&
          !!decision.consumedAt &&
          decision.decidedByUserId === accountId &&
          decision.requestedByPath === claims.agentPath &&
          Number.isFinite(Date.parse(decision.expiresAt)) &&
          Date.parse(decision.expiresAt) > now &&
          account?.id === accountId &&
          isOwner(owner.id, accountId) &&
          activeAuthor.id === author.id &&
          activeAuthor.kind === 'agent' &&
          activeAuthor.mintedForManifestId === claims.agentId &&
          live?.status === 'ready' &&
          live.path === row.path &&
          live.ownerKind === null &&
          live.ownerRef === null &&
          !closed &&
          !context.signal?.aborted &&
          currentPrincipal(principal) &&
          (!mappedOwner || mappedOwner.current()) &&
          !closed &&
          !context.signal?.aborted
        );
      };
      const read = () => {
        if (retired) return false;
        const valid = evaluate();
        if (!valid) retired = true;
        return valid && !closed && !context.signal?.aborted;
      };
      // Only expired/revoked metadata is pruned. Native campaigns retain their own original close bank.
      for (const old of bank) if (!old.current()) bank.delete(old);
      if (bank.size >= 64 || !read()) throw refuse();
      const originalDecision = db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approval.approvalId))
        .get();
      if (!originalDecision || !read()) throw refuse();
      spent.set(approval.approvalId, Date.parse(originalDecision.expiresAt));
      const cell = Object.freeze({
        principal,
        workspaceId: row.id,
        path: row.path,
        current: read,
      });
      const token: RuntimeWorkspaceDelegation = Object.freeze({
        kind: 'runtime-workspace-delegation',
      });
      bank.add(cell);
      cells.set(token, cell);
      return token;
    },
    /** Fence grants synchronously; native close remains owned by the mode's original session bank. */
    close(): void {
      closed = true;
      bank.clear();
      spent.clear();
    },
  });
}
