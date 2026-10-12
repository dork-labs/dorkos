import { createOriginalHttpGrantTargetResolver } from './http/http-grant-target-resolution.js';
import {
  readOriginalHttpPrincipalCurrent,
  readOriginalHttpMembership,
  type OriginalHttpPrincipalMembershipView,
} from './http/http-principal-membership.js';
import {
  prepareServiceOriginalDocumentSave,
  completeServiceOriginalDocumentSave,
} from './service.js';
import {
  InstallationFileWrites,
  requireInstallationFileWritesAdmission,
  stopInstallationFileWrites,
  readInstallationHttpFileWrites,
} from './writes/installation-file-writes.js';
import { NormalFileSaveService } from './writes/normal-file-save.js';
import { createHash } from 'node:crypto';
import { agents, eq, type DbTransaction } from '@dorkos/db';
import type { DocChannelHttp } from '../../../routes/canvas-doc-events.js';
import { resolveCaller } from '../../../routes/room-caller.js';
import type { RequestFacts } from '../../../http/request-facts.js';
import { originalDocRequestFacts } from '../../../http/original-doc-request.js';
import type { Request } from 'express';
import {
  createServerPrincipal,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from '../../connectors/principal/server-principal.js';
import { requireRoomServiceFileWriteOwner } from '../../rooms/room-service.js';
import { requireRoomFileEditorOwner } from '../../rooms/repo/room-file-editor.js';
import { requireRoomRepoServiceOwner } from '../../rooms/repo/room-repo-service.js';
import { requireRoomMergeServiceOwner } from '../../rooms/repo/room-merge-service.js';
import { requireRoomWorktreeManagerOwner } from '../../rooms/repo/room-worktree-manager.js';
import { parseScope } from '../scopes.js';
import { DocChannelDownstream } from './downstream/service.js';
import { createDocDownstreamAuthority } from './downstream/authority.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  requireOriginalCurrentDocAccess,
} from './authorization.js';
import { DocChannelStore, requireDocChannelStoreDatabase } from './store.js';
import { DocChannelService } from './service.js';
import { DocCheckboxAuthority } from './writes/authority.js';
import {
  createInstallationOriginalCheckboxWriter,
  stopInstallationOriginalCheckboxWriter,
  createInstallationOriginalCheckboxGrantPreparation,
  createInstallationOriginalRoomDownstream,
} from './writes/installation-file-writes.js';
import { DocChannelGrants } from './grants.js';
import {
  grantOriginalCheckboxRoute,
  resolveOriginalCheckboxGrantBinding,
  type OriginalCheckboxGrantPreparation,
} from './writes/checkbox/checkbox-grant-preparation.js';
import { DocChannelIngest } from './ingest.js';
import type { DocGrantAuthority } from './grant-policy.js';
import { docInstallationOwner, sameDocOwnerAuthority } from './current/doc-source-policy.js';
import { requireRoomRepoReconcilerOwner } from '../../rooms/repo/room-repo-reconciler.js';
import {
  createOriginalHttpRequestOperations,
  type OriginalHttpRequestOperations,
} from './http/http-request-operations.js';
import {
  type OriginalHttpFileOwner,
  type OriginalHttpRoomFileCaller,
  type OriginalHttpRoomSessionPlacement,
  type OriginalHttpRoomRepoCaller,
  type OriginalHttpRequestCustody,
  type OriginalDocHttpCompositionDependencies,
  type OriginalDocHttpComposition,
} from './http/http-composition-contracts.js';
import { readOriginalHttpSourceRootOrRefuse } from './http/http-source-root-policy.js';
import {
  selectOriginalHttpRequestCustody,
  selectOriginalHttpPrincipalMembership,
} from './http/http-custody-view-selection.js';
export { RoomFileRequestAuthError } from './http/http-composition-contracts.js';

export {
  docInstallationOwner,
  sameDocOwnerAuthority,
  readDocSourceDescriptor,
} from './current/doc-source-policy.js';
export type { DocSourceDescriptor, DocSourceDependencies } from './current/doc-source-policy.js';

const originalHttpFileOwners = new WeakMap<object, OriginalHttpFileOwner>();
const originalHttpCompositions = new WeakMap<
  object,
  {
    composition: OriginalDocHttpComposition;
    owner: OriginalHttpFileOwner;
    actor: DocChannelHttp['actor'];
  }
>();

/** Capture only the actor of the exact constructed installation composition, refusing replacement. */
export function captureOriginalDocHttpActor(http: DocChannelHttp): DocChannelHttp['actor'] {
  const binding = originalHttpCompositions.get(http);
  const requireCurrent = () => {
    if (
      !binding ||
      binding.composition !== http ||
      binding.owner.closed ||
      originalHttpCompositions.get(http) !== binding ||
      http.actor !== binding.actor ||
      binding.composition.service !== binding.owner.service ||
      originalHttpFileOwners.get(binding.composition.fileWrites) !== binding.owner
    )
      throw new DocChannelNotFoundError();
  };
  requireCurrent();
  const captured = binding!;
  return (caller, res) => {
    requireCurrent();
    return Reflect.apply(captured.actor, captured.composition, [caller, res]);
  };
}

const originalHttpFileCallers = new WeakMap<
  object,
  {
    owner: InstallationFileWrites;
    binding: OriginalHttpFileOwner;
    actor: ReturnType<DocChannelHttp['actor']>;
    active: boolean;
  }
>();
const originalHttpRoomFileCallers = new WeakMap<object, OriginalHttpRoomFileCaller>();
const originalHttpRoomSessionPlacements = new WeakMap<object, OriginalHttpRoomSessionPlacement>();
const originalHttpRoomRepoCallers = new WeakMap<object, OriginalHttpRoomRepoCaller>();
const httpCustodyKey = Object.freeze({});
const httpCustodyViews = new WeakMap<object, OriginalHttpRequestCustody>();
const httpPrivateConstructionFreeze = Object.freeze;
const httpPrincipalMembershipViews = new WeakMap<object, OriginalHttpPrincipalMembershipView>();
const httpCustodyApply = Reflect.apply;
const httpCustodyGet = WeakMap.prototype.get;
const httpCustodySet = WeakMap.prototype.set;
httpCustodyApply(httpCustodySet, httpCustodyViews, [
  httpCustodyKey,
  Object.freeze({
    originalHttpFileOwners,
    originalHttpFileCallers,
    originalHttpRoomFileCallers,
    originalHttpRoomSessionPlacements,
    originalHttpRoomRepoCallers,
  }),
]);
/** Require the exact private composition custody key before selecting native request maps. */
export function readOriginalHttpRequestCustody(owner: object): OriginalHttpRequestCustody {
  return selectOriginalHttpRequestCustody(
    owner,
    httpCustodyViews,
    httpCustodyApply,
    httpCustodyGet
  );
}

/** Require this composition's original private principal-membership key before native reads. */
export function readOriginalHttpPrincipalMembershipView(
  owner: object
): OriginalHttpPrincipalMembershipView {
  return selectOriginalHttpPrincipalMembership(
    owner,
    httpPrincipalMembershipViews,
    httpCustodyApply,
    httpCustodyGet
  );
}

/** Original request operations retain their public names and private assembly selector. */
const originalHttpExplicitPublicBindings: Readonly<OriginalHttpRequestOperations> =
  createOriginalHttpRequestOperations(httpCustodyKey);
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalHttpRoomReconcilerOwner: OriginalHttpRequestOperations['requireOriginalHttpRoomReconcilerOwner'] =
  originalHttpExplicitPublicBindings.requireOriginalHttpRoomReconcilerOwner;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalHttpRoomReconcilerAdmission: OriginalHttpRequestOperations['requireOriginalHttpRoomReconcilerAdmission'] =
  originalHttpExplicitPublicBindings.requireOriginalHttpRoomReconcilerAdmission;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalHttpRoomWorktreeOwner: OriginalHttpRequestOperations['requireOriginalHttpRoomWorktreeOwner'] =
  originalHttpExplicitPublicBindings.requireOriginalHttpRoomWorktreeOwner;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalHttpRoomWorktreeAdmission: OriginalHttpRequestOperations['requireOriginalHttpRoomWorktreeAdmission'] =
  originalHttpExplicitPublicBindings.requireOriginalHttpRoomWorktreeAdmission;
/** Original public function reference with its exact named declaration contract. */
export const captureDocHttpFileWriteCaller: OriginalHttpRequestOperations['captureDocHttpFileWriteCaller'] =
  originalHttpExplicitPublicBindings.captureDocHttpFileWriteCaller;
/** Original public function reference with its exact named declaration contract. */
export const requireDocHttpFileWriteCurrent: OriginalHttpRequestOperations['requireDocHttpFileWriteCurrent'] =
  originalHttpExplicitPublicBindings.requireDocHttpFileWriteCurrent;
/** Original public function reference with its exact named declaration contract. */
export const retireDocHttpFileWriteCaller: OriginalHttpRequestOperations['retireDocHttpFileWriteCaller'] =
  originalHttpExplicitPublicBindings.retireDocHttpFileWriteCaller;
/** Original public function reference with its exact named declaration contract. */
export const captureDocHttpRoomFileWriteCaller: OriginalHttpRequestOperations['captureDocHttpRoomFileWriteCaller'] =
  originalHttpExplicitPublicBindings.captureDocHttpRoomFileWriteCaller;
/** Original public function reference with its exact named declaration contract. */
export const checkDocHttpRoomFileWriteCurrent: OriginalHttpRequestOperations['checkDocHttpRoomFileWriteCurrent'] =
  originalHttpExplicitPublicBindings.checkDocHttpRoomFileWriteCurrent;
/** Original public function reference with its exact named declaration contract. */
export const requireDocHttpRoomFileWriteCurrent: OriginalHttpRequestOperations['requireDocHttpRoomFileWriteCurrent'] =
  originalHttpExplicitPublicBindings.requireDocHttpRoomFileWriteCurrent;
/** Original public function reference with its exact named declaration contract. */
export const readDocHttpRoomFileWriteAttribution: OriginalHttpRequestOperations['readDocHttpRoomFileWriteAttribution'] =
  originalHttpExplicitPublicBindings.readDocHttpRoomFileWriteAttribution;
/** Original public function reference with its exact named declaration contract. */
export const originalHttpRoomSessionPlacementRefusal: OriginalHttpRequestOperations['originalHttpRoomSessionPlacementRefusal'] =
  originalHttpExplicitPublicBindings.originalHttpRoomSessionPlacementRefusal;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalHttpRoomSessionPlacement: OriginalHttpRequestOperations['readOriginalHttpRoomSessionPlacement'] =
  originalHttpExplicitPublicBindings.readOriginalHttpRoomSessionPlacement;
/** Original public function reference with its exact named declaration contract. */
export const checkOriginalHttpRoomSessionPlacement: OriginalHttpRequestOperations['checkOriginalHttpRoomSessionPlacement'] =
  originalHttpExplicitPublicBindings.checkOriginalHttpRoomSessionPlacement;
/** Original public function reference with its exact named declaration contract. */
export const captureOriginalHttpRoomSessionPlacement: OriginalHttpRequestOperations['captureOriginalHttpRoomSessionPlacement'] =
  originalHttpExplicitPublicBindings.captureOriginalHttpRoomSessionPlacement;
/** Original public function reference with its exact named declaration contract. */
export const retireDocHttpRoomFileWriteCaller: OriginalHttpRequestOperations['retireDocHttpRoomFileWriteCaller'] =
  originalHttpExplicitPublicBindings.retireDocHttpRoomFileWriteCaller;
/** Original public function reference with its exact named declaration contract. */
export const captureDocHttpRoomRepoCaller: OriginalHttpRequestOperations['captureDocHttpRoomRepoCaller'] =
  originalHttpExplicitPublicBindings.captureDocHttpRoomRepoCaller;
/** Original public function reference with its exact named declaration contract. */
export const checkDocHttpRoomRepoCaller: OriginalHttpRequestOperations['checkDocHttpRoomRepoCaller'] =
  originalHttpExplicitPublicBindings.checkDocHttpRoomRepoCaller;
/** Original public function reference with its exact named declaration contract. */
export const requireDocHttpRoomRepoCaller: OriginalHttpRequestOperations['requireDocHttpRoomRepoCaller'] =
  originalHttpExplicitPublicBindings.requireDocHttpRoomRepoCaller;
/** Original public function reference with its exact named declaration contract. */
export const readDocHttpRoomRepoCaller: OriginalHttpRequestOperations['readDocHttpRoomRepoCaller'] =
  originalHttpExplicitPublicBindings.readDocHttpRoomRepoCaller;
/** Original public function reference with its exact named declaration contract. */
export const retireDocHttpRoomRepoCaller: OriginalHttpRequestOperations['retireDocHttpRoomRepoCaller'] =
  originalHttpExplicitPublicBindings.retireDocHttpRoomRepoCaller;

/** Use real server-owned instances; no independent physical document writer or transcript store. */
export function createDocChannelHttpComposition(
  deps: OriginalDocHttpCompositionDependencies
): OriginalDocHttpComposition {
  const suppliedFileWrites = deps.owningFileWrites;
  const channels = suppliedFileWrites ? suppliedFileWrites.channels : new DocChannelStore(deps.db);
  requireDocChannelStoreDatabase(channels, deps.db);
  if (suppliedFileWrites)
    requireInstallationFileWritesAdmission(suppliedFileWrites.fileWrites, deps.db, channels);
  const tokens = new WeakMap<ServerPrincipalProof, string>();
  const currentOwner = () => docInstallationOwner(deps.installationId);
  const sameOwnerAuthority = (recorded: unknown) => sameDocOwnerAuthority(recorded, currentOwner());
  const sameOwner = (claims: ServerPrincipalClaims) => sameOwnerAuthority(claims.owner);
  const principalMembershipKey = httpPrivateConstructionFreeze({});
  httpCustodyApply(httpCustodySet, httpPrincipalMembershipViews, [
    principalMembershipKey,
    httpPrivateConstructionFreeze({ deps, tokens, sameOwner }),
  ]);
  const principalCurrent = (proof: ServerPrincipalProof): boolean =>
    readOriginalHttpPrincipalCurrent(principalMembershipKey, proof);
  const membership = (roomId: string, claims: ServerPrincipalClaims) =>
    readOriginalHttpMembership(principalMembershipKey, roomId, claims);
  const authorization = new DocChannelAuthorization(deps.db, deps.documents, {
    originalInstallationId: deps.installationId,
    ownsInstallation: sameOwner,
    principalCurrent,
    nativeRuntimePrincipals: deps.nativeRuntimePrincipals,
    roomConstruction: deps.roomConstruction,
    originalRoomStore: deps.roomStore,
    originalRoomRepoStore: deps.roomRepos,
    roomMembership: membership,
    revalidateRuntime: (proof) => deps.revalidateRuntime?.(proof) ?? Promise.resolve(false),
  });
  const resolveTarget = createOriginalHttpGrantTargetResolver(deps, membership, currentOwner);
  const sourceRoot = (documentId: string, tx?: DbTransaction): string | null =>
    readOriginalHttpSourceRootOrRefuse(principalMembershipKey, documentId, tx);
  const originalCheckboxGrantCapture: { preparation?: OriginalCheckboxGrantPreparation } = {};
  const grantAuthority: DocGrantAuthority = {
    resolveScope: (scope) => deps.documents.lifecycle.resolveScope(scope),
    requireCurrent: (documentId, actor, write, tx) =>
      requireOriginalCurrentDocAccess(authorization, documentId, actor, write, tx),
    resolveTarget,
    sourceRoot,
    resolveWriteBinding: (documentId, tx) =>
      originalCheckboxGrantCapture.preparation
        ? (resolveOriginalCheckboxGrantBinding(
            originalCheckboxGrantCapture.preparation,
            documentId,
            tx
          ) ?? null)
        : null,
    originCurrent: (documentId, opener, tx) => {
      const channel = channels.getChannel(documentId, tx);
      const agent = (tx ?? deps.db).select().from(agents).where(eq(agents.id, opener)).get();
      return channel?.openerAgentId === opener && agent?.status === 'active';
    },
    requireGrantedCurrent: (grant, tx) => {
      // Persisted grant evidence is verified by DocChannelGrants. Recheck the owning physical scope here,
      // without minting an operator principal or borrowing an expired opener-turn proof.
      const origin = (grant.approvalEvidence as { binding?: { origin?: { owner?: unknown } } })
        .binding?.origin;
      if (!sameOwnerAuthority(origin?.owner)) throw new DocChannelNotFoundError();
      const identity = deps.documents.lookupIdentity(grant.documentId);
      const channel = channels.getChannel(grant.documentId, tx);
      if (!identity || !channel || channel.closedAt !== null || grant.revokedAt)
        throw new DocChannelNotFoundError();
      deps.documents.lifecycle.assertReady(grant.documentId);
      const scope = deps.documents.lifecycle.resolveScope(identity.scope);
      if (
        channel.scope !== scope ||
        deps.documents.lifecycle.resolveScope(
          String((grant.approvalEvidence as { binding?: { scope?: string } }).binding?.scope ?? '')
        ) !== scope
      )
        throw new DocChannelNotFoundError();
      const parsed = parseScope(scope);
      if (parsed.kind === 'unknown') throw new DocChannelNotFoundError();
      if (parsed.kind === 'room') {
        const owner = membership(parsed.id, { kind: 'operator', owner: currentOwner() });
        if (!owner || owner.archived) throw new DocChannelNotFoundError();
      }
      return { id: identity.id, scope };
    },
  };
  const grants = new DocChannelGrants({
    db: deps.db,
    store: channels,
    approvals: deps.approvals,
    authority: grantAuthority,
  });
  const downstreamAuthority = createDocDownstreamAuthority(channels, authorization, grants, {
    principalCurrent,
    ownsInstallation: sameOwner,
    resolveScope: (scope) => deps.documents.lifecycle.resolveScope(scope),
    revalidateRuntime: (proof) => deps.revalidateRuntime?.(proof) ?? Promise.resolve(false),
  });
  const resolveOriginalHttpActor: DocChannelHttp['actor'] = (caller, res) => {
    const facts = res
      ? originalDocRequestFacts(caller as Request, res)
      : (caller as Pick<RequestFacts, 'headers' | 'agentIdentity' | 'user'>);
    resolveCaller(facts); // Refuse unknown/revoked agent headers before minting a principal.
    const identity = facts.agentIdentity;
    const owner = currentOwner();
    if (identity) {
      const agent = deps.db
        .select()
        .from(agents)
        .where(eq(agents.projectPath, identity.agentPath))
        .get();
      if (!agent || agent.status !== 'active') throw new DocChannelNotFoundError();
      const principal = createServerPrincipal({
        kind: 'agent',
        owner,
        agentId: agent.id,
        agentPath: agent.projectPath,
      });
      const raw = facts.headers['x-dorkos-agent'];
      if (typeof raw !== 'string') throw new DocChannelNotFoundError();
      tokens.set(principal, createHash('sha256').update(raw).digest('hex'));
      return { surface: 'http', principal };
    }
    const user = facts.user;
    if (user && (owner.kind !== 'user' || owner.userId !== user.userId))
      throw new DocChannelNotFoundError();
    return { surface: 'http', principal: createServerPrincipal({ kind: 'operator', owner }) };
  };
  const fileWrites =
    suppliedFileWrites?.fileWrites ?? new InstallationFileWrites({ db: deps.db, store: channels });
  requireInstallationFileWritesAdmission(fileWrites, deps.db, channels);
  const downstream = deps.nativeRuntimePrincipals
    ? createInstallationOriginalRoomDownstream(
        fileWrites,
        deps.db,
        channels,
        downstreamAuthority,
        deps.nativeRuntimePrincipals
      )
    : new DocChannelDownstream(channels, downstreamAuthority); // Ordinary lane retains Room refusal; it owns no emitter.

  requireRoomServiceFileWriteOwner(deps.rooms, deps.db, deps.roomStore);
  if (deps.roomFileEditor) requireRoomFileEditorOwner(deps.roomFileEditor, fileWrites);
  if (deps.roomRepoService)
    requireRoomRepoServiceOwner(deps.roomRepoService, fileWrites, deps.db, deps.rooms);
  if (deps.roomMergeService)
    requireRoomMergeServiceOwner(deps.roomMergeService, fileWrites, deps.db, deps.rooms);
  if (deps.roomWorktreeManager)
    requireRoomWorktreeManagerOwner(deps.roomWorktreeManager, fileWrites, deps.db, deps.rooms);
  if (deps.roomRepoReconciler)
    requireRoomRepoReconcilerOwner(
      deps.roomRepoReconciler,
      fileWrites,
      deps.db,
      deps.rooms,
      deps.roomRepos
    );
  const fileOwner: OriginalHttpFileOwner = {
    reconciler: deps.roomRepoReconciler,
    worktrees: deps.roomWorktreeManager,
    repoService: deps.roomRepoService,
    mergeService: deps.roomMergeService,
    editor: deps.roomFileEditor,
    rooms: deps.rooms,
    roomStore: deps.roomStore,
    native: deps.db.$client,
    db: deps.db,
    store: channels,
    actor: resolveOriginalHttpActor,
    principalCurrent,
    closed: false,
  };
  if (originalHttpFileOwners.has(fileWrites))
    throw new Error('Owning file writer already has its original HTTP binding.');
  originalHttpFileOwners.set(fileWrites, fileOwner);
  const stopOriginalFileWrites = () => stopInstallationFileWrites(fileWrites, deps.db, channels);
  const normalFileSave = new NormalFileSaveService(fileWrites, deps.db, channels);
  const service = new DocChannelService(deps.documents, channels, authorization, {
    ingest: new DocChannelIngest(channels),
    grants,
  });
  fileOwner.service = service;
  const checkboxAuthority = new DocCheckboxAuthority({
    db: deps.db,
    documents: deps.documents,
    roomRepos: deps.roomRepos,
    rooms: deps.rooms,
    authorization,
    grants,
    store: channels,
    installationId: deps.installationId,
    now: () => new Date(),
  });
  const checkboxWriter = createInstallationOriginalCheckboxWriter(
    fileWrites,
    deps.db,
    channels,
    checkboxAuthority,
    service
  );
  const checkboxGrantPreparation = createInstallationOriginalCheckboxGrantPreparation(
    fileWrites,
    deps.db,
    channels,
    checkboxAuthority,
    service,
    grants
  );
  originalCheckboxGrantCapture.preparation = checkboxGrantPreparation;
  const composition: OriginalDocHttpComposition = {
    checkboxWriter,
    grantCheckboxRoute: (raw, actor, approvalToken) =>
      grantOriginalCheckboxRoute(checkboxGrantPreparation, raw, actor, approvalToken),
    stopCheckboxWrites: () => stopInstallationOriginalCheckboxWriter(fileWrites, deps.db, channels),
    fileWrites,
    normalFileSave,
    namespaceFileWrites: readInstallationHttpFileWrites(fileWrites, deps.db, channels),
    async stopFileWrites() {
      fileOwner.closed = true;
      await stopOriginalFileWrites();
    },
    actor: resolveOriginalHttpActor,
    grants,
    downstream,
    channels,
    authorization,
    grantAuthority,
    service,
  };
  originalHttpCompositions.set(composition, {
    composition,
    owner: fileOwner,
    actor: resolveOriginalHttpActor,
  });
  return composition;
}

/** Original HTTP actor stays inside its captured owner-to-service completion lane. */
export function prepareDocHttpDocumentSave(
  owner: InstallationFileWrites,
  callerHandle: object,
  saveScope: object
) {
  requireDocHttpFileWriteCurrent(owner, callerHandle);
  const caller = originalHttpFileCallers.get(callerHandle)!;
  if (!caller.binding.service || caller.actor.principal.claims.kind !== 'operator')
    throw new DocChannelNotFoundError();
  return prepareServiceOriginalDocumentSave(caller.binding.service, saveScope, caller.actor);
}
/** Complete only the same actual caller and private writer scope after original persistence. */
export function completeDocHttpDocumentSave(
  owner: InstallationFileWrites,
  callerHandle: object,
  saveScope: object
) {
  requireDocHttpFileWriteCurrent(owner, callerHandle);
  const caller = originalHttpFileCallers.get(callerHandle)!;
  if (!caller.binding.service || caller.actor.principal.claims.kind !== 'operator')
    throw new DocChannelNotFoundError();
  return completeServiceOriginalDocumentSave(caller.binding.service, saveScope, caller.actor);
}
