import { type CanvasChannelDeclaration } from '@dorkos/shared/canvas-channel-schemas';
import { type DocRouteGrantRequest } from './grant-policy.js';
import type { DbTransaction } from '@dorkos/db';
import {
  type DocGrantRow,
  requireDocChannelStoreDatabase,
  requireOriginalDocGrantStore,
  requireOriginalDocumentRelayStore,
} from './store.js';
import { CompiledCanvasAppManifest } from '@dorkos/shared/canvas-app-manifest';
import { createOriginalDocAppManifestReader } from './app-manifest.js';
import {
  DocRouteGrantError,
  type DocGrantActor,
  type DocOriginalWriteObservation,
} from './grant-policy.js';
import { captureCurrentDocConfiguration } from './current/current-operation-data.js';
import type {
  CurrentGrantSourceClaims,
  DocGrantCurrentServices,
} from './current/current-operation-types.js';
import {
  createIsolatedGrantCustodyMaps,
  type OriginalGrantCustodyMaps,
} from './grant/grant-original-custody-maps.js';
import {
  createOriginalGrantPublicDispatch,
  type OriginalGrantPublicDispatch,
} from './grant/grant-public-dispatch.js';
import { installOriginalGrantCallbacks } from './grant/grant-constructor-bindings.js';
import type {
  OriginalGrantRevalidationView,
  OriginalGrantCreationView,
} from './grant/grant-private-views.js';
import type { PreparedDocGrant, DocGrantResult } from './grant/grant-private-contracts.js';
import * as grant_token_current from './grant/grant-token-current.js';
import * as grant_live_current from './grant/grant-live-current.js';
import * as grant_write_relay_current from './grant/grant-write-relay-current.js';
import * as grant_document_dependencies from './grant/grant-document-dependencies.js';
import * as grant_replay_routing from './grant/grant-replay-routing.js';
import * as grant_channel_configuration from './grant/grant-channel-configuration.js';
import * as grant_route_preparation from './grant/grant-route-preparation.js';
import * as grant_route_approval from './grant/grant-route-approval.js';

import { OriginalGrantRevalidationDispatch } from './grant/grant-revalidation-dispatch-base.js';
import {
  projectOriginalGrantRevalidationView,
  projectOriginalGrantCreationView,
} from './grant/grant-view-projection.js';

export type { DocGrantedRoute } from './current/current-operation-types.js';
export type {
  OriginalCurrentDocumentGrantDependencies,
  PreparedDocGrant,
  DocGrantResult,
} from './grant/grant-private-contracts.js';
const originalGrantCustodyMaps = createIsolatedGrantCustodyMaps();
const { currentGrantEngines, originalPreparedGrantCalls, originalGrantMutations } =
  originalGrantCustodyMaps;
const grantFreeze = Object.freeze;
const originalCustodyKey = grantFreeze({});
const custodyViews = new WeakMap<object, Readonly<OriginalGrantCustodyMaps>>();
const baseViews = new WeakMap<object, OriginalGrantRevalidationView>();
const creationViews = new WeakMap<object, OriginalGrantCreationView>();
const grantApply = Reflect.apply;
const grantGet = WeakMap.prototype.get;
const grantSet = WeakMap.prototype.set;
grantApply(grantSet, custodyViews, [originalCustodyKey, originalGrantCustodyMaps]);
/** Exact private root membership maps; public engine/database objects are not selectors. */
export function readOriginalGrantCustody(owner: object): Readonly<OriginalGrantCustodyMaps> {
  const view = grantApply(grantGet, custodyViews, [owner]) as
    Readonly<OriginalGrantCustodyMaps> | undefined;
  if (!view) throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  return view;
}
/** Genuine constructor-private revalidation view, before any native effect. */
export function readOriginalGrantRevalidationView(owner: object): OriginalGrantRevalidationView {
  const view = grantApply(grantGet, baseViews, [owner]) as
    OriginalGrantRevalidationView | undefined;
  if (!view) throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  return view;
}
/** Genuine constructor-private grant mutation view, before any native effect. */
export function readOriginalGrantCreationView(owner: object): OriginalGrantCreationView {
  const view = grantApply(grantGet, creationViews, [owner]) as
    OriginalGrantCreationView | undefined;
  if (!view) throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
  return view;
}
/** Original constructor-owned public grant entrypoints. */
const originalGrantExplicitPublicBindings: Readonly<OriginalGrantPublicDispatch> =
  createOriginalGrantPublicDispatch(originalCustodyKey);
/** Original public function reference with its exact named declaration contract. */
export const documentDependenciesBeforeOriginalGrantInsertion: OriginalGrantPublicDispatch['documentDependenciesBeforeOriginalGrantInsertion'] =
  originalGrantExplicitPublicBindings.documentDependenciesBeforeOriginalGrantInsertion;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalCurrentDocReplayRouting: OriginalGrantPublicDispatch['readOriginalCurrentDocReplayRouting'] =
  originalGrantExplicitPublicBindings.readOriginalCurrentDocReplayRouting;
/** Original public function reference with its exact named declaration contract. */
export const prepareCurrentDocGrantRoutes: OriginalGrantPublicDispatch['prepareCurrentDocGrantRoutes'] =
  originalGrantExplicitPublicBindings.prepareCurrentDocGrantRoutes;
/** Original public function reference with its exact named declaration contract. */
export const prepareCurrentDocCheckboxGrantRoutes: OriginalGrantPublicDispatch['prepareCurrentDocCheckboxGrantRoutes'] =
  originalGrantExplicitPublicBindings.prepareCurrentDocCheckboxGrantRoutes;
/** Original public function reference with its exact named declaration contract. */
export const auditCurrentDocGrantRows: OriginalGrantPublicDispatch['auditCurrentDocGrantRows'] =
  originalGrantExplicitPublicBindings.auditCurrentDocGrantRows;
/** Original public function reference with its exact named declaration contract. */
export const refreshCurrentDocGrantAuthority: OriginalGrantPublicDispatch['refreshCurrentDocGrantAuthority'] =
  originalGrantExplicitPublicBindings.refreshCurrentDocGrantAuthority;
/** Original public function reference with its exact named declaration contract. */
export const readCurrentOriginalRoomGrantSource: OriginalGrantPublicDispatch['readCurrentOriginalRoomGrantSource'] =
  originalGrantExplicitPublicBindings.readCurrentOriginalRoomGrantSource;
/** Original public function reference with its exact named declaration contract. */
export const captureCurrentDocumentGrantDependencies: OriginalGrantPublicDispatch['captureCurrentDocumentGrantDependencies'] =
  originalGrantExplicitPublicBindings.captureCurrentDocumentGrantDependencies;
/** Original public function reference with its exact named declaration contract. */
export const requireCurrentDocumentGrantFinal: OriginalGrantPublicDispatch['requireCurrentDocumentGrantFinal'] =
  originalGrantExplicitPublicBindings.requireCurrentDocumentGrantFinal;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalTokenDocumentManifest: OriginalGrantPublicDispatch['readOriginalTokenDocumentManifest'] =
  originalGrantExplicitPublicBindings.readOriginalTokenDocumentManifest;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalTokenDocumentManifestClosed: OriginalGrantPublicDispatch['requireOriginalTokenDocumentManifestClosed'] =
  originalGrantExplicitPublicBindings.requireOriginalTokenDocumentManifestClosed;
/** Original public function reference with its exact named declaration contract. */
export const prepareOriginalTokenGrantInput: OriginalGrantPublicDispatch['prepareOriginalTokenGrantInput'] =
  originalGrantExplicitPublicBindings.prepareOriginalTokenGrantInput;
/** Original public function reference with its exact named declaration contract. */
export const requireOriginalDocumentRelayGrants: OriginalGrantPublicDispatch['requireOriginalDocumentRelayGrants'] =
  originalGrantExplicitPublicBindings.requireOriginalDocumentRelayGrants;
/** Original public function reference with its exact named declaration contract. */
export const requireCurrentDocGrantEngine: OriginalGrantPublicDispatch['requireCurrentDocGrantEngine'] =
  originalGrantExplicitPublicBindings.requireCurrentDocGrantEngine;
/** Original public function reference with its exact named declaration contract. */
export const grantOriginalPreparedCheckboxRoute: OriginalGrantPublicDispatch['grantOriginalPreparedCheckboxRoute'] =
  originalGrantExplicitPublicBindings.grantOriginalPreparedCheckboxRoute;
/** Original public function reference with its exact named declaration contract. */
export const configureOriginalDocChannel: OriginalGrantPublicDispatch['configureOriginalDocChannel'] =
  originalGrantExplicitPublicBindings.configureOriginalDocChannel;
/** Original public function reference with its exact named declaration contract. */
export const approveOriginalDocRoute: OriginalGrantPublicDispatch['approveOriginalDocRoute'] =
  originalGrantExplicitPublicBindings.approveOriginalDocRoute;
/** Original public function reference with its exact named declaration contract. */
export const revokeOriginalDocRoute: OriginalGrantPublicDispatch['revokeOriginalDocRoute'] =
  originalGrantExplicitPublicBindings.revokeOriginalDocRoute;
/** Original public function reference with its exact named declaration contract. */
export const readOriginalReviewedDocReplayRoute: OriginalGrantPublicDispatch['readOriginalReviewedDocReplayRoute'] =
  originalGrantExplicitPublicBindings.readOriginalReviewedDocReplayRoute;
const originalTokenPayloadValidate = CompiledCanvasAppManifest.prototype.validate;
const APPROVE_CAPABILITY = 'ui.approve_doc_route';
const PLATFORM_LIMITS = { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 };
/** Shared synchronous current-authority checks for ingestion and background dispatch. */
export class DocChannelGrantRevalidation extends OriginalGrantRevalidationDispatch {
  readonly #grantKey: object;
  readonly #relayStore: ReturnType<typeof requireOriginalDocGrantStore> &
    ReturnType<typeof requireOriginalDocumentRelayStore>;

  readonly #tokenManifestReader = createOriginalDocAppManifestReader();
  readonly #fixedServices: OriginalGrantRevalidationView['fixedServices'];
  readonly #fixedClaims = new WeakMap<DbTransaction, CurrentGrantSourceClaims>();
  /** Use current canonical authority ports without reusing an opener turn's expired proof. */
  constructor(protected readonly services: DocGrantCurrentServices) {
    const originalKey = grantFreeze({});
    super(originalKey);
    this.#grantKey = originalKey;
    const fixed = captureCurrentDocConfiguration(services);
    if (fixed.db.$client.inTransaction)
      throw new Error('Current grant construction requires an inactive database.');
    this.#relayStore = Object.freeze({
      ...requireOriginalDocGrantStore(fixed.store, fixed.db),
      ...requireOriginalDocumentRelayStore(fixed.store),
    });
    this.#fixedServices = Object.freeze({
      db: fixed.db,
      store: fixed.store,
      authority: captureCurrentDocConfiguration(fixed.authority),
      now: fixed.now,
      originalManifestReader: this.#tokenManifestReader,
    });

    const createOriginalView = (
      owner: DocChannelGrantRevalidation
    ): Readonly<OriginalGrantRevalidationView> =>
      projectOriginalGrantRevalidationView(
        grantFreeze<OriginalGrantRevalidationView>({
          originalOwner: this,
          get services() {
            return owner.services;
          },
          originalTokenPayloadValidate,
          get relayStore() {
            return owner.#relayStore;
          },
          get tokenManifestReader() {
            return owner.#tokenManifestReader;
          },
          get fixedServices() {
            return owner.#fixedServices;
          },
          get fixedClaims() {
            return owner.#fixedClaims;
          },
          privatePrepareTokenManifest: (documentId, observed) =>
            grant_token_current.privatePrepareTokenManifest(owner.#grantKey, documentId, observed),
          privatePrepareTokenCurrent: (input, authorization, tx) =>
            grant_token_current.privatePrepareTokenCurrent(
              owner.#grantKey,
              input,
              authorization,
              tx
            ),
          privateReadTokenManifestOutsideSql: (documentId) =>
            grant_token_current.privateReadTokenManifestOutsideSql(owner.#grantKey, documentId),
          get now() {
            return owner.now;
          },
          get access() {
            return owner.access;
          },
          get refreshManifest() {
            return owner.refreshManifest;
          },
          get refreshAuthority() {
            return owner.refreshAuthority;
          },
          get refreshGrantedAuthority() {
            return owner.refreshGrantedAuthority;
          },
          get manifest() {
            return owner.manifest;
          },
          get suspend() {
            return owner.suspend;
          },
          get validateEventPayload() {
            return owner.validateEventPayload;
          },
          get revalidateGrant() {
            return owner.revalidateGrant;
          },
          get verifyCurrentGrant() {
            return owner.verifyCurrentGrant;
          },
          get revalidateOriginalWriteGrant() {
            return owner.revalidateOriginalWriteGrant;
          },
          get revalidateBatchGrant() {
            return owner.revalidateBatchGrant;
          },
          get getEffectiveLimits() {
            return owner.getEffectiveLimits;
          },
          get getCurrentRoutes() {
            return owner.getCurrentRoutes;
          },
          privateRelayRefresh: (grantId) =>
            grant_write_relay_current.privateRelayRefresh(owner.#grantKey, grantId),
          privateRelayBatch: (batch, tx) =>
            grant_write_relay_current.privateRelayBatch(owner.#grantKey, batch, tx),
          privateFixedNow: () => grant_write_relay_current.privateFixedNow(owner.#grantKey),
          privateFixedAccess: (documentId, actor, tx) =>
            grant_write_relay_current.privateFixedAccess(owner.#grantKey, documentId, actor, tx),
          privateDocumentFinal: (documentId, grantIds, tx) =>
            grant_document_dependencies.privateDocumentFinal(
              owner.#grantKey,
              documentId,
              grantIds,
              tx
            ),
          privateDocumentDependencies: (documentId, actor, grantIds, tx, observed) =>
            grant_document_dependencies.privateDocumentDependencies(
              owner.#grantKey,
              documentId,
              actor,
              grantIds,
              tx,
              observed
            ),
          privateReplayRouting: (documentId, actor, tx, room, engine, observed) =>
            grant_replay_routing.privateReplayRouting(
              owner.#grantKey,
              documentId,
              actor,
              tx,
              room,
              engine,
              observed
            ),
          privateSourceRows: (documentId, tx) =>
            grant_document_dependencies.privateSourceRows(owner.#grantKey, documentId, tx),
          privatePrepareCurrent: (authorization, tx, observed) =>
            grant_document_dependencies.privatePrepareCurrent(
              owner.#grantKey,
              authorization,
              tx,
              observed
            ),
          privateAuditCurrent: (authorization, tx) =>
            grant_document_dependencies.privateAuditCurrent(owner.#grantKey, authorization, tx),
          privateOriginalRoomSource: (authorization, tx, routeId) =>
            grant_document_dependencies.privateOriginalRoomSource(
              owner.#grantKey,
              authorization,
              tx,
              routeId
            ),
          privateReadCurrentChannel: (documentId, tx) =>
            grant_document_dependencies.privateReadCurrentChannel(owner.#grantKey, documentId, tx),
          privateRefreshCurrentAuthority: (documentId, actor) =>
            grant_document_dependencies.privateRefreshCurrentAuthority(
              owner.#grantKey,
              documentId,
              actor
            ),
          ...originalGrantCustodyMaps,
        }),
        originalGrantCustodyMaps
      );
    grantApply(grantSet, baseViews, [this.#grantKey, createOriginalView(this)]);
    installOriginalGrantCallbacks(this.#grantKey, fixed, services);
  }

  private refreshManifest(documentId: string, tx: DbTransaction): unknown {
    return grant_live_current.refreshManifest(this.#grantKey, documentId, tx);
  }
  private verifyCurrentGrant(
    documentId: string,
    grantId: string,
    scope: string,
    tx: DbTransaction,
    observed?: DocOriginalWriteObservation
  ): DocGrantRow {
    return grant_live_current.verifyCurrentGrant(
      this.#grantKey,
      documentId,
      grantId,
      scope,
      tx,
      observed
    );
  }
}

/** Exact grants; declaration changes and approvals never replay previously accepted input. */
export class DocChannelGrants extends DocChannelGrantRevalidation {
  readonly #grantKey = grantFreeze({});
  /** Build over the same SQLite connection as the existing one-use approval service. */
  readonly #store: OriginalGrantCreationView['store'];
  readonly #deps: OriginalGrantCreationView['deps'];
  constructor(deps: OriginalGrantCreationView['deps']) {
    const fixed = captureCurrentDocConfiguration(deps);
    super(fixed);
    this.#deps = fixed;
    this.#store = requireOriginalDocGrantStore(fixed.store, fixed.db);
    if (fixed.db.$client.inTransaction)
      throw new Error('Current grant construction requires an inactive database.');
    requireDocChannelStoreDatabase(fixed.store, fixed.db);
    fixed.approvals.assertTransactionDatabase(fixed.db);
    currentGrantEngines.set(this, Object.freeze({ db: fixed.db, store: fixed.store }));
    originalGrantMutations.set(this, {
      configure: (id, declaration, actor, opener) =>
        grant_channel_configuration.privateConfigure(
          this.#grantKey,
          id,
          declaration,
          actor,
          opener
        ),
      grant: (request, actor, token) =>
        grant_route_approval.privateGrant(this.#grantKey, request, actor, token),
      revoke: (id, grantId, actor) =>
        grant_channel_configuration.privateRevoke(this.#grantKey, id, grantId, actor),
    });
    originalPreparedGrantCalls.set(this, {
      db: fixed.db,
      store: fixed.store,
      grant: (helper, request, actor, token) =>
        grant_route_approval.privateGrant(this.#grantKey, request, actor, token, helper),
    });

    const createOriginalView = (owner: DocChannelGrants): Readonly<OriginalGrantCreationView> =>
      projectOriginalGrantCreationView(
        grantFreeze<OriginalGrantCreationView>({
          originalOwner: this,
          get store() {
            return owner.#store;
          },
          get deps() {
            return owner.#deps;
          },
          privateSuspendOriginalGrants: (documentId, tx) =>
            grant_channel_configuration.privateSuspendOriginalGrants(
              owner.#grantKey,
              documentId,
              tx
            ),
          privateRefreshOriginalAuthority: (documentId, actor) =>
            grant_channel_configuration.privateRefreshOriginalAuthority(
              owner.#grantKey,
              documentId,
              actor
            ),
          privateNow: () => grant_channel_configuration.privateNow(owner.#grantKey),
          privateAccess: (documentId, actor, tx) =>
            grant_channel_configuration.privateAccess(owner.#grantKey, documentId, actor, tx),
          get configure() {
            return owner.configure;
          },
          privateConfigure: (documentId, declaration, actor, selectedOpenerAgentId) =>
            grant_channel_configuration.privateConfigure(
              owner.#grantKey,
              documentId,
              declaration,
              actor,
              selectedOpenerAgentId
            ),
          get prepare() {
            return owner.prepare;
          },
          privatePrepare: (request, actor, tx, source) =>
            grant_route_preparation.privatePrepare(owner.#grantKey, request, actor, tx, source),
          privateExisting: (prepared, tx) =>
            grant_route_preparation.privateExisting(owner.#grantKey, prepared, tx),
          get grant() {
            return owner.grant;
          },
          privateGrant: (request, actor, approvalToken, source) =>
            grant_route_approval.privateGrant(
              owner.#grantKey,
              request,
              actor,
              approvalToken,
              source
            ),
          get revoke() {
            return owner.revoke;
          },
          privateRevoke: (documentId, grantId, actor) =>
            grant_channel_configuration.privateRevoke(owner.#grantKey, documentId, grantId, actor),
          ...originalGrantCustodyMaps,
          PLATFORM_LIMITS,
          APPROVE_CAPABILITY,
        }),
        originalGrantCustodyMaps
      );
    grantApply(grantSet, creationViews, [this.#grantKey, createOriginalView(this)]);
  }

  /** Replace declarations as data, invalidating old authority without routing old events. */
  configure(
    documentId: string,
    declaration: CanvasChannelDeclaration,
    actor: DocGrantActor,
    selectedOpenerAgentId?: string
  ): void {
    return grant_channel_configuration.configure(
      this.#grantKey,
      documentId,
      declaration,
      actor,
      selectedOpenerAgentId
    );
  }

  /** Resolve the exact binding shown for approval, using only current canonical server identity. */
  prepare(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    tx: DbTransaction
  ): PreparedDocGrant {
    return grant_route_preparation.prepare(this.#grantKey, request, actor, tx);
  }

  /** Enable opener self/log authority or request/consume an exact operator verdict atomically. */
  grant(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    approvalToken?: string
  ): DocGrantResult {
    return grant_route_approval.grant(this.#grantKey, request, actor, approvalToken);
  }

  /** Explicit revoke; a later grant never implicitly retries input saved under this one. */
  revoke(documentId: string, grantId: string, actor: DocGrantActor): void {
    return grant_channel_configuration.revoke(this.#grantKey, documentId, grantId, actor);
  }
}
