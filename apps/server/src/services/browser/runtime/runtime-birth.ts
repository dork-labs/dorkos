import type { BrowserRuntimeOwnerResolution } from './runtime-owner-resolution.js';
import {
  captureRuntimeWorkspaceDelegation,
  type RuntimeWorkspaceDelegation,
} from './runtime-workspace-delegation.js';
import nodePath from 'node:path';
import { and, eq, connectorRuntimeBindings, workspaces, type Db } from '@dorkos/db';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalService as RuntimePrincipalService } from '../../connectors/principal/runtime-principal-service.js';
import type { AuthorRegistry } from '../../rooms/author-registry.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import { findOwnerAccount } from '../../core/auth/accounts.js';
import { BrowserApiRefusal } from '../api/service.js';

/** Private live credential for one original runtime turn's own managed workspace. */
export type RuntimeBrowserBirth = Readonly<{
  principal: ServerPrincipalProof;
  principals: RuntimePrincipalService;
  authors: AuthorRegistry;
  ownerResolution?: BrowserRuntimeOwnerResolution;
  accountId: string;
  accountCurrent(): boolean;
  actor: (() => boolean) & { readonly ownerId: string };
  workspaceId: string;
  recipientId: string;
  sessionId: string;
  expiresAt(): string;
  delegation?: RuntimeWorkspaceDelegation;
}>;

/** Resolve an original turn, durable author and agent-owned workspace before native birth.
 * No tool JSON supplies account, recipient, cwd or permission. */
export async function captureRuntimeBrowserBirth(options: {
  db: Db;
  principals: RuntimePrincipalService;
  authors: AuthorRegistry;
  context: CapabilityHandlerContext;
  owners?: BrowserRuntimeOwnerResolution;
  enabled(): boolean;
  refuse?(): Error;
  delegation?: RuntimeWorkspaceDelegation;
}): Promise<RuntimeBrowserBirth> {
  const refuse = options.refuse?.bind(options) ?? (() => new BrowserApiRefusal('inaccessible'));
  const principal = options.context.serverPrincipal,
    identity = options.context.identity,
    signal = options.context.signal;
  if (
    !isServerPrincipal(principal) ||
    principal.claims.kind !== 'runtime' ||
    !identity ||
    identity.inactive ||
    options.context.trusted ||
    identity.agentPath !== principal.claims.agentPath ||
    options.context.sessionId !== principal.claims.canonicalSessionId ||
    !principal.claims.canonicalCwd ||
    !nodePath.isAbsolute(principal.claims.canonicalCwd)
  )
    throw refuse();
  const claims = principal.claims;
  const currentPrincipal = options.principals.isPrincipalCurrent.bind(options.principals),
    refresh = options.principals.revalidatePrincipal.bind(options.principals),
    resolveAgent = options.authors.resolveAgent.bind(options.authors),
    bindOwner = options.authors.bindOwner.bind(options.authors),
    isOwner = options.authors.isOwner.bind(options.authors),
    enabled = options.enabled.bind(options);
  const guard = () => {
    const available = enabled();
    const live = currentPrincipal(principal);
    return available && live && !signal?.aborted;
  };
  if (!guard()) throw refuse();
  const mappedOwner = options.owners?.resolve(principal, guard);
  const accountId =
    mappedOwner?.accountId ??
    (claims.owner.kind === 'user' && !options.owners ? claims.owner.userId : undefined);
  if (!accountId || (options.owners && !mappedOwner) || !guard()) throw refuse();
  if (!(await refresh(principal)) || !guard() || (mappedOwner && !mappedOwner.current()))
    throw refuse();
  const resourceOwner = bindOwner(accountId);
  const ownerId = resourceOwner.id;
  if (mappedOwner && mappedOwner.authorId !== ownerId) throw refuse();
  const accountCurrent = () =>
    mappedOwner
      ? mappedOwner.current()
      : findOwnerAccount(options.db)?.id === accountId && isOwner(ownerId, accountId);
  const bindingOwnerId =
    claims.owner.kind === 'user' ? claims.owner.userId : claims.owner.installationId;
  const author = resolveAgent(claims.agentPath, identity.displayName);
  const delegated = options.delegation
    ? captureRuntimeWorkspaceDelegation(options.delegation, principal)
    : undefined;
  const rows = options.db
    .select()
    .from(workspaces)
    .where(
      and(
        ...(delegated
          ? [eq(workspaces.id, delegated.workspaceId)]
          : [eq(workspaces.ownerKind, 'agent'), eq(workspaces.ownerRef, claims.agentPath)]),
        eq(workspaces.status, 'ready')
      )
    )
    .limit(65)
    .all();
  if (rows.length > 64) throw refuse();
  const matching = rows
    .filter((row) => {
      if (!nodePath.isAbsolute(row.path)) return false;
      const relative = nodePath.relative(row.path, claims.canonicalCwd!);
      return (
        relative !== '..' &&
        !relative.startsWith('..' + nodePath.sep) &&
        !nodePath.isAbsolute(relative)
      );
    })
    .sort((a, b) => b.path.length - a.path.length);
  const workspace = matching[0];
  if (!workspace || matching[1]?.path.length === workspace.path.length) throw refuse();
  const read = () => {
    if (!guard() || !accountCurrent()) return undefined;
    const liveAuthor = resolveAgent(claims.agentPath, identity.displayName);
    const owner = findOwnerAccount(options.db);
    const row = options.db
      .select()
      .from(connectorRuntimeBindings)
      .where(eq(connectorRuntimeBindings.id, claims.bindingId))
      .get();
    const liveWorkspace = options.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id))
      .get();
    if (
      owner?.id !== accountId ||
      !isOwner(ownerId, accountId) ||
      liveAuthor.id !== author.id ||
      liveAuthor.kind !== 'agent' ||
      liveAuthor.naturalKey !== claims.agentPath ||
      liveAuthor.mintedForManifestId !== claims.agentId ||
      !row ||
      row.revokedAt ||
      row.ownerKind !== claims.owner.kind ||
      row.ownerId !== bindingOwnerId ||
      row.agentId !== claims.agentId ||
      row.agentPath !== claims.agentPath ||
      row.canonicalSessionId !== claims.canonicalSessionId ||
      row.canonicalCwd !== claims.canonicalCwd ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      Date.parse(row.expiresAt) <= Date.now() ||
      !liveWorkspace ||
      (delegated
        ? !delegated.current() ||
          liveWorkspace?.ownerKind !== null ||
          liveWorkspace.ownerRef !== null
        : liveWorkspace?.ownerKind !== 'agent' || liveWorkspace.ownerRef !== claims.agentPath) ||
      liveWorkspace.path !== workspace.path ||
      liveWorkspace.status !== 'ready' ||
      !accountCurrent() ||
      signal?.aborted
    )
      return undefined;
    return row;
  };
  const actor = Object.assign(() => !!read(), { ownerId });
  if (!actor()) throw refuse();
  return Object.freeze({
    principal,
    ...(options.delegation ? { delegation: options.delegation } : {}),
    principals: options.principals,
    authors: options.authors,
    ...(options.owners ? { ownerResolution: options.owners } : {}),
    accountId,
    accountCurrent,
    actor,
    workspaceId: workspace.id,
    recipientId: author.id,
    sessionId: claims.canonicalSessionId,
    expiresAt: () => {
      const row = read();
      if (!row) throw refuse();
      return row.expiresAt;
    },
  });
}
