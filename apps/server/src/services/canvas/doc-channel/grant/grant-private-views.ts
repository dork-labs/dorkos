import type { CurrentRoomOperation } from '../operations/room-current-operation.js';
import type { CurrentDocOperationEngineCore } from '../current/current-operation-types.js';
import type { OriginalCheckboxGrantPreparation } from '../writes/checkbox/checkbox-grant-preparation.js';
import type { CanvasChannelDeclaration } from '@dorkos/shared/canvas-channel-schemas';
import type { DocRouteGrantRequest } from '../grant-policy.js';
import type { readCurrentGrantSourceRows } from '../current/current-operation-row-audit.js';
import type { selectOriginalRoomGrantSource } from '../current/current-operation-intentions.js';
import type { canvasDocChannels, approvals, Db, DbTransaction } from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import type {
  DocChannelStore,
  DocGrantRow,
  DocBatchRow,
  requireOriginalDocGrantStore,
  requireOriginalDocumentRelayStore,
} from '../store.js';
import type { CompiledCanvasAppManifest } from '@dorkos/shared/canvas-app-manifest';
import type { createOriginalDocAppManifestReader, DocAppManifest } from '../app-manifest.js';
import type {
  DocGrantActor,
  DocGrantTarget,
  DocOriginalWriteObservation,
} from '../grant-policy.js';
import type { grantCoreGetEffectiveLimits } from './grant-current-core.js';
import type { readCurrentDocIngressInput, DocChannelAuthorization } from '../authorization.js';
import type {
  CurrentGrantConstructorBinding,
  CurrentGrantSourceClaims,
  DocGrantedRoute,
  DocGrantCurrentServices,
} from '../current/current-operation-types.js';
import type { DocChannelGrantRevalidation, DocChannelGrants } from '../grant-revalidation.js';
import type {
  OriginalTokenWriteObservation,
  OriginalCurrentDocumentGrantDependencies,
  OriginalGrantCreationDependencies,
  OriginalGrantPlatformLimits,
  PreparedDocGrant,
  DocGrantResult,
} from './grant-private-contracts.js';

/** Fixed private base state and genuine owner calls; copied structures establish no membership. */
export interface OriginalGrantRevalidationView {
  readonly originalOwner: DocChannelGrantRevalidation;
  readonly services: DocGrantCurrentServices;
  readonly originalTokenPayloadValidate: typeof CompiledCanvasAppManifest.prototype.validate;
  readonly relayStore: ReturnType<typeof requireOriginalDocGrantStore> &
    ReturnType<typeof requireOriginalDocumentRelayStore>;
  readonly tokenManifestReader: ReturnType<typeof createOriginalDocAppManifestReader>;
  readonly fixedServices: DocGrantCurrentServices & {
    readonly originalManifestReader: ReturnType<typeof createOriginalDocAppManifestReader>;
  };
  readonly fixedClaims: WeakMap<DbTransaction, CurrentGrantSourceClaims>;
  readonly privatePrepareTokenManifest: (
    documentId: string,
    observed: OriginalTokenWriteObservation
  ) => import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation;
  readonly privatePrepareTokenCurrent: (
    input: ReturnType<typeof readCurrentDocIngressInput>,
    authorization: DocChannelAuthorization,
    tx: DbTransaction
  ) => import('../ingest-data/ingest-types.js').DocIngestAccess;
  readonly privateReadTokenManifestOutsideSql: (documentId: string) => string | null;
  readonly now: () => string;
  readonly access: (
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ) => { id: string; scope: string };
  readonly refreshManifest: (documentId: string, tx: DbTransaction) => unknown;
  readonly refreshAuthority: (documentId: string, actor: DocGrantActor) => void;
  readonly refreshGrantedAuthority: (grantId: string) => void;
  readonly manifest: (documentId: string, tx: DbTransaction) => DocAppManifest | undefined;
  readonly suspend: (documentId: string, tx: DbTransaction) => void;
  readonly validateEventPayload: (
    documentId: string,
    type: string,
    payload: unknown,
    actor: DocGrantActor,
    tx?: DbTransaction
  ) => void;
  readonly revalidateGrant: (
    documentId: string,
    grantId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ) => DocGrantRow;
  readonly verifyCurrentGrant: (
    documentId: string,
    grantId: string,
    scope: string,
    tx: DbTransaction,
    observed?: DocOriginalWriteObservation
  ) => DocGrantRow;
  readonly revalidateOriginalWriteGrant: (
    documentId: string,
    grantId: string,
    revision: number,
    scope: string,
    observed: DocOriginalWriteObservation,
    tx: DbTransaction
  ) => DocGrantRow;
  readonly revalidateBatchGrant: (
    batch: DocBatchRow,
    tx: DbTransaction
  ) => { grant: DocGrantRow; target: DocGrantTarget };
  readonly getEffectiveLimits: (
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ) => ReturnType<typeof grantCoreGetEffectiveLimits>;
  readonly getCurrentRoutes: (
    documentId: string,
    type: string | undefined,
    actor: DocGrantActor,
    tx?: DbTransaction
  ) => DocGrantedRoute[];
  readonly privateRelayRefresh: (grantId: string) => void;
  readonly privateRelayBatch: (
    batch: DocBatchRow,
    tx: DbTransaction
  ) => { grant: DocGrantRow; target: DocGrantTarget };
  readonly privateFixedNow: () => string;
  readonly privateFixedAccess: (
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ) => { id: string; scope: string };
  readonly privateDocumentFinal: (
    documentId: string,
    grantIds: readonly string[],
    tx: DbTransaction
  ) => void;
  readonly privateDocumentDependencies: (
    documentId: string,
    actor: DocGrantActor,
    grantIds: readonly string[],
    tx: DbTransaction,
    observed?: DocOriginalWriteObservation
  ) => OriginalCurrentDocumentGrantDependencies;
  readonly privateReplayRouting: (
    documentId: string,
    actor: DocGrantActor,
    tx: DbTransaction,
    room?: CurrentRoomOperation,
    engine?: CurrentDocOperationEngineCore,
    observed?: DocOriginalWriteObservation
  ) => import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting;
  readonly privateSourceRows: (
    documentId: string,
    tx: DbTransaction
  ) => ReturnType<typeof readCurrentGrantSourceRows>;
  readonly privatePrepareCurrent: (
    authorization: DocChannelAuthorization,
    tx: DbTransaction,
    observed?: DocOriginalWriteObservation
  ) => import('../ingest-data/ingest-types.js').DocIngestAccess;
  readonly privateAuditCurrent: (authorization: DocChannelAuthorization, tx: DbTransaction) => void;
  readonly privateOriginalRoomSource: (
    authorization: DocChannelAuthorization,
    tx: DbTransaction,
    routeId: string
  ) => ReturnType<typeof selectOriginalRoomGrantSource>;
  readonly privateReadCurrentChannel: (
    documentId: string,
    tx: DbTransaction
  ) => typeof canvasDocChannels.$inferSelect | undefined;
  readonly privateRefreshCurrentAuthority: (documentId: string, actor: DocGrantActor) => void;
  readonly originalGrantInsertions: WeakMap<
    DbTransaction,
    {
      grants: DocChannelGrants;
      store: DocChannelStore;
      documentId: string;
      actor: DocGrantActor;
      grant: DocGrantRow;
      approval: typeof approvals.$inferSelect | null;
    }
  >;
  readonly originalReviewedReplayRoutes: WeakMap<
    DocChannelGrantRevalidation,
    (
      documentId: string,
      actor: DocGrantActor,
      tx: DbTransaction,
      grantId: string,
      observed?: DocOriginalWriteObservation,
      inputs?: readonly { type: string; payload: unknown }[],
      room?: CurrentRoomOperation,
      engine?: CurrentDocOperationEngineCore
    ) => { grant: DocGrantRow; route: CanvasChannelRoute }
  >;
  readonly originalReplayRouting: WeakMap<
    DocChannelGrantRevalidation,
    (
      documentId: string,
      actor: DocGrantActor,
      tx: DbTransaction,
      room?: CurrentRoomOperation,
      engine?: CurrentDocOperationEngineCore,
      observed?: DocOriginalWriteObservation
    ) => import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting
  >;
  readonly currentGrantBindings: WeakMap<
    DocChannelGrantRevalidation,
    CurrentGrantConstructorBinding
  >;
  readonly originalTokenGrantPreparations: WeakMap<
    import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation,
    {
      owner: DocChannelGrantRevalidation;
      documentId: string;
      manifest: DocAppManifest | undefined;
      observed: OriginalTokenWriteObservation;
    }
  >;
  readonly originalTokenGrantPreparers: WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      prepare: (
        documentId: string,
        observed: OriginalTokenWriteObservation
      ) => import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation;
    }
  >;
  readonly originalTokenManifestReads: WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      read: (documentId: string) => string | null;
      source: (documentId: string, tx: DbTransaction) => DocAppManifest | undefined;
      closed: () => void;
    }
  >;
  readonly originalRelayGrantReads: WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      calls: Readonly<
        Pick<DocChannelGrantRevalidation, 'refreshGrantedAuthority' | 'revalidateBatchGrant'>
      >;
    }
  >;
  readonly currentGrantEngines: WeakMap<
    DocChannelGrantRevalidation,
    { db: Db; store: DocChannelStore }
  >;
  readonly originalPreparedGrantCalls: WeakMap<
    DocChannelGrants,
    {
      db: Db;
      store: DocChannelStore;
      grant: (
        helper: OriginalCheckboxGrantPreparation,
        request: DocRouteGrantRequest,
        actor: DocGrantActor,
        token?: string
      ) => DocGrantResult;
    }
  >;
  readonly originalGrantMutations: WeakMap<
    DocChannelGrants,
    {
      configure: (
        documentId: string,
        declaration: CanvasChannelDeclaration,
        actor: DocGrantActor,
        opener?: string
      ) => void;
      grant: (
        request: DocRouteGrantRequest,
        actor: DocGrantActor,
        token?: string
      ) => DocGrantResult;
      revoke: (documentId: string, grantId: string, actor: DocGrantActor) => void;
    }
  >;
}
/** Fixed private grant state and genuine owner calls; copied structures establish no membership. */
export interface OriginalGrantCreationView {
  readonly originalOwner: DocChannelGrants;
  readonly store: Pick<
    DocChannelStore,
    'transaction' | 'getChannel' | 'insertGrant' | 'getGrant' | 'revokeGrant'
  >;
  readonly deps: OriginalGrantCreationDependencies;
  readonly privateSuspendOriginalGrants: (documentId: string, tx: DbTransaction) => void;
  readonly privateRefreshOriginalAuthority: (documentId: string, actor: DocGrantActor) => void;
  readonly privateNow: () => string;
  readonly privateAccess: (
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ) => { id: string; scope: string };
  readonly configure: (
    documentId: string,
    declaration: CanvasChannelDeclaration,
    actor: DocGrantActor,
    selectedOpenerAgentId?: string
  ) => void;
  readonly privateConfigure: (
    documentId: string,
    declaration: CanvasChannelDeclaration,
    actor: DocGrantActor,
    selectedOpenerAgentId?: string
  ) => void;
  readonly prepare: (
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    tx: DbTransaction
  ) => PreparedDocGrant;
  readonly privatePrepare: (
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    tx: DbTransaction,
    source?: OriginalCheckboxGrantPreparation
  ) => PreparedDocGrant;
  readonly privateExisting: (
    prepared: PreparedDocGrant,
    tx: DbTransaction
  ) => DocGrantRow | undefined;
  readonly grant: (
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    approvalToken?: string
  ) => DocGrantResult;
  readonly privateGrant: (
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    approvalToken?: string,
    source?: OriginalCheckboxGrantPreparation
  ) => DocGrantResult;
  readonly revoke: (documentId: string, grantId: string, actor: DocGrantActor) => void;
  readonly privateRevoke: (documentId: string, grantId: string, actor: DocGrantActor) => void;
  readonly originalGrantInsertions: WeakMap<
    DbTransaction,
    {
      grants: DocChannelGrants;
      store: DocChannelStore;
      documentId: string;
      actor: DocGrantActor;
      grant: DocGrantRow;
      approval: typeof approvals.$inferSelect | null;
    }
  >;
  readonly originalReviewedReplayRoutes: WeakMap<
    DocChannelGrantRevalidation,
    (
      documentId: string,
      actor: DocGrantActor,
      tx: DbTransaction,
      grantId: string,
      observed?: DocOriginalWriteObservation,
      inputs?: readonly { type: string; payload: unknown }[],
      room?: CurrentRoomOperation,
      engine?: CurrentDocOperationEngineCore
    ) => { grant: DocGrantRow; route: CanvasChannelRoute }
  >;
  readonly originalReplayRouting: WeakMap<
    DocChannelGrantRevalidation,
    (
      documentId: string,
      actor: DocGrantActor,
      tx: DbTransaction,
      room?: CurrentRoomOperation,
      engine?: CurrentDocOperationEngineCore,
      observed?: DocOriginalWriteObservation
    ) => import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting
  >;
  readonly currentGrantBindings: WeakMap<
    DocChannelGrantRevalidation,
    CurrentGrantConstructorBinding
  >;
  readonly originalTokenGrantPreparations: WeakMap<
    import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation,
    {
      owner: DocChannelGrantRevalidation;
      documentId: string;
      manifest: DocAppManifest | undefined;
      observed: OriginalTokenWriteObservation;
    }
  >;
  readonly originalTokenGrantPreparers: WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      prepare: (
        documentId: string,
        observed: OriginalTokenWriteObservation
      ) => import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation;
    }
  >;
  readonly originalTokenManifestReads: WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      read: (documentId: string) => string | null;
      source: (documentId: string, tx: DbTransaction) => DocAppManifest | undefined;
      closed: () => void;
    }
  >;
  readonly originalRelayGrantReads: WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      calls: Readonly<
        Pick<DocChannelGrantRevalidation, 'refreshGrantedAuthority' | 'revalidateBatchGrant'>
      >;
    }
  >;
  readonly currentGrantEngines: WeakMap<
    DocChannelGrantRevalidation,
    { db: Db; store: DocChannelStore }
  >;
  readonly originalPreparedGrantCalls: WeakMap<
    DocChannelGrants,
    {
      db: Db;
      store: DocChannelStore;
      grant: (
        helper: OriginalCheckboxGrantPreparation,
        request: DocRouteGrantRequest,
        actor: DocGrantActor,
        token?: string
      ) => DocGrantResult;
    }
  >;
  readonly originalGrantMutations: WeakMap<
    DocChannelGrants,
    {
      configure: (
        documentId: string,
        declaration: CanvasChannelDeclaration,
        actor: DocGrantActor,
        opener?: string
      ) => void;
      grant: (
        request: DocRouteGrantRequest,
        actor: DocGrantActor,
        token?: string
      ) => DocGrantResult;
      revoke: (documentId: string, grantId: string, actor: DocGrantActor) => void;
    }
  >;
  readonly PLATFORM_LIMITS: OriginalGrantPlatformLimits;
  readonly APPROVE_CAPABILITY: 'ui.approve_doc_route';
}
