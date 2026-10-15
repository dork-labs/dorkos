import type { CurrentRoomOperation } from '../operations/room-current-operation.js';
import type { CurrentDocOperationEngineCore } from '../current/current-operation-types.js';
import type { OriginalCheckboxGrantPreparation } from '../writes/checkbox/checkbox-grant-preparation.js';
import type { CanvasChannelDeclaration } from '@dorkos/shared/canvas-channel-schemas';
import type { DocRouteGrantRequest } from '../grant-policy.js';
import type { approvals, Db, DbTransaction } from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelStore, DocGrantRow } from '../store.js';
import type { DocAppManifest } from '../app-manifest.js';
import type { DocGrantActor, DocOriginalWriteObservation } from '../grant-policy.js';
import type { CurrentGrantConstructorBinding } from '../current/current-operation-types.js';
import type { DocChannelGrants, DocChannelGrantRevalidation } from '../grant-revalidation.js';
import type { OriginalTokenWriteObservation, DocGrantResult } from './grant-private-contracts.js';

/** Nameable exact original native membership map shapes. */
export interface OriginalGrantCustodyMaps {
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
/** Allocate unrelated maps; only the grant root retains its actual map instance. */
export function createIsolatedGrantCustodyMaps(): Readonly<OriginalGrantCustodyMaps> {
  const originalGrantInsertions = new WeakMap<
    DbTransaction,
    {
      grants: DocChannelGrants;
      store: DocChannelStore;
      documentId: string;
      actor: DocGrantActor;
      grant: DocGrantRow;
      approval: typeof approvals.$inferSelect | null;
    }
  >();
  const originalReviewedReplayRoutes = new WeakMap<
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
  >();
  const originalReplayRouting = new WeakMap<
    DocChannelGrantRevalidation,
    (
      documentId: string,
      actor: DocGrantActor,
      tx: DbTransaction,
      room?: CurrentRoomOperation,
      engine?: CurrentDocOperationEngineCore,
      observed?: DocOriginalWriteObservation
    ) => import('@dorkos/shared/canvas-channel-schemas').CanvasChannelRouting
  >();
  const currentGrantBindings = new WeakMap<
    DocChannelGrantRevalidation,
    CurrentGrantConstructorBinding
  >();
  const originalTokenGrantPreparations = new WeakMap<
    import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation,
    {
      owner: DocChannelGrantRevalidation;
      documentId: string;
      manifest: DocAppManifest | undefined;
      observed: OriginalTokenWriteObservation;
    }
  >();
  const originalTokenGrantPreparers = new WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      prepare: (
        documentId: string,
        observed: OriginalTokenWriteObservation
      ) => import('../current/current-operation-types.js').OriginalDocTokenGrantPreparation;
    }
  >();
  const originalTokenManifestReads = new WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      read: (documentId: string) => string | null;
      source: (documentId: string, tx: DbTransaction) => DocAppManifest | undefined;
      closed: () => void;
    }
  >();
  const originalRelayGrantReads = new WeakMap<
    DocChannelGrantRevalidation,
    {
      db: Db;
      store: DocChannelStore;
      calls: Readonly<
        Pick<DocChannelGrantRevalidation, 'refreshGrantedAuthority' | 'revalidateBatchGrant'>
      >;
    }
  >();
  const currentGrantEngines = new WeakMap<
    DocChannelGrantRevalidation,
    { db: Db; store: DocChannelStore }
  >();
  const originalPreparedGrantCalls = new WeakMap<
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
  >();
  const originalGrantMutations = new WeakMap<
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
  >();
  return Object.freeze({
    originalGrantInsertions,
    originalReviewedReplayRoutes,
    originalReplayRouting,
    currentGrantBindings,
    originalTokenGrantPreparations,
    originalTokenGrantPreparers,
    originalTokenManifestReads,
    originalRelayGrantReads,
    currentGrantEngines,
    originalPreparedGrantCalls,
    originalGrantMutations,
  });
}
