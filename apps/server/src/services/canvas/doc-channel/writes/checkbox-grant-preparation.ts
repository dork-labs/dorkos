import { CanvasChannelCheckboxBindingSchema } from '@dorkos/shared/canvas-channel-schemas';
/** Actual installation child owns the one FILE observation consumed by the original grant transaction. */
import type { Db, DbTransaction } from '@dorkos/db';
import {
  DocRouteGrantRequestSchema,
  type DocRouteGrantRequest,
  type DocGrantActor,
} from '../grant-policy.js';
import {
  grantOriginalPreparedCheckboxRoute,
  type DocChannelGrants,
  type DocGrantResult,
} from '../grants.js';
import { captureCurrentHttpDocActor, type DocChannelActor } from '../authorization.js';
import {
  captureServiceCurrentDocument,
  requireServiceCurrentDocument,
  requireServiceOriginalDocumentInTransaction,
  requireServiceOriginalCheckboxGrantDependencies,
  type DocChannelService,
} from '../service.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../store.js';
import type { OriginalCurrentDocumentData } from '../current/current-operation-types.js';
import { readDocAppManifest, type DocAppManifest } from '../app-manifest.js';
import {
  observeOriginalCheckboxGrantSource,
  requireOriginalCheckboxGrantSource,
  type DocCheckboxAuthority,
} from './authority.js';
import { freezeCheckboxData } from './checkbox-evidence.js';
import type { CheckboxSourceObservation } from './authority-snapshot.js';
import {
  withRecognizedCanonicalFiles,
  requireOriginalCanonicalWriteLease,
  type CanonicalFileWriteCoordinator,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from './canonical-writer.js';
import { requireInstallationOriginalCheckboxGrantPreparation } from './installation-file-writes.js';

interface Stage {
  request: DocRouteGrantRequest;
  actor: DocChannelActor;
  document: OriginalCurrentDocumentData;
  observation: CheckboxSourceObservation;
  manifest: DocAppManifest | undefined;
  lease: CanonicalWriteLease;
  identity: CanonicalFileIdentity;
  tx?: DbTransaction;
  resolved: boolean;
  entered: boolean;
}
interface Owner {
  db: Db;
  store: DocChannelStore;
  coordinator: CanonicalFileWriteCoordinator;
  grants: DocChannelGrants;
  stop: () => Promise<void>;
  grant: (raw: unknown, actor: DocChannelActor, token?: string) => Promise<DocGrantResult>;
  stage: (
    grants: DocChannelGrants,
    tx: DbTransaction,
    request?: DocRouteGrantRequest,
    actor?: DocGrantActor
  ) => Stage;
  enter: (grants: DocChannelGrants, request: DocRouteGrantRequest, actor: DocGrantActor) => void;
  resolve: (documentId: string, tx?: DbTransaction) => DocRouteGrantRequest['write'] | null;
}
const owners = new WeakMap<OriginalCheckboxGrantPreparation, Owner>();
/** Require the original checkbox grant preparation's exact constructor dependencies. */
export function requireOriginalCheckboxGrantPreparationAssembly(
  helper: OriginalCheckboxGrantPreparation,
  db: Db,
  store: DocChannelStore,
  coordinator: CanonicalFileWriteCoordinator
): Readonly<{ stop: () => Promise<void> }> {
  const own = owners.get(helper);
  if (!own || own.db !== db || own.store !== store || own.coordinator !== coordinator)
    throw new Error('Foreign original checkbox grant preparation.');
  return Object.freeze({ stop: own.stop });
}
/** Confirm the exact installed preparation still owns this original grant service. */
export function requireOriginalCheckboxGrantPreparationGrants(
  helper: OriginalCheckboxGrantPreparation,
  grants: DocChannelGrants
): void {
  const own = owners.get(helper);
  if (!own || own.grants !== grants) throw new Error('Foreign original checkbox grant service.');
}
/** Prepare and grant the original source-bound checkbox route. */
export function grantOriginalCheckboxRoute(
  helper: OriginalCheckboxGrantPreparation,
  raw: unknown,
  actor: DocChannelActor,
  approvalToken?: string
): Promise<DocGrantResult> {
  const own = owners.get(helper);
  if (!own) throw new Error('Unknown original checkbox grant preparation.');
  return own.grant(raw, actor, approvalToken);
}
/** Lookup only: without the actual private active preparation, a write DTO cannot obtain a binding. */
export function resolveOriginalCheckboxGrantBinding(
  helper: OriginalCheckboxGrantPreparation,
  documentId: string,
  tx?: DbTransaction
): DocRouteGrantRequest['write'] | null {
  const own = owners.get(helper);
  if (!own) throw new Error('Unknown original checkbox grant preparation.');
  return own.resolve(documentId, tx);
}
/** Require the original checkbox grant transaction and retained source stage. */
export function requireOriginalCheckboxGrantTransaction(
  helper: OriginalCheckboxGrantPreparation,
  grants: DocChannelGrants,
  tx: DbTransaction,
  request?: DocRouteGrantRequest,
  actor?: DocGrantActor
): void {
  const own = owners.get(helper);
  if (!own) throw new Error('Unknown original checkbox grant preparation.');
  own.stage(grants, tx, request, actor);
}
/** Enter the original source-bound checkbox grant operation. */
export function enterOriginalCheckboxGrantOperation(
  helper: OriginalCheckboxGrantPreparation,
  grants: DocChannelGrants,
  request: DocRouteGrantRequest,
  actor: DocGrantActor
): void {
  const own = owners.get(helper);
  if (!own) throw new Error('Unknown original checkbox grant preparation.');
  own.enter(grants, request, actor);
}
/** Read the manifest retained by the original checkbox grant preparation. */
export function readOriginalCheckboxGrantManifest(
  helper: OriginalCheckboxGrantPreparation,
  grants: DocChannelGrants,
  tx: DbTransaction
): DocAppManifest | undefined {
  const own = owners.get(helper);
  if (!own) throw new Error('Unknown original checkbox grant preparation.');
  return own.stage(grants, tx).manifest;
}
/** Own source observation and transaction staging for original checkbox grants. */
export class OriginalCheckboxGrantPreparation {
  readonly #active = new Set<Promise<unknown>>();
  #stopped = false;
  #stopPromise: Promise<void> | undefined;
  #stage: Stage | undefined;
  readonly #db: Db;
  readonly #store: DocChannelStore;
  readonly #coordinator: CanonicalFileWriteCoordinator;
  readonly #authority: DocCheckboxAuthority;
  readonly #service: DocChannelService;
  readonly #grants: DocChannelGrants;
  constructor(
    db: Db,
    store: DocChannelStore,
    coordinator: CanonicalFileWriteCoordinator,
    authority: DocCheckboxAuthority,
    service: DocChannelService,
    grants: DocChannelGrants
  ) {
    requireDocChannelStoreDatabase(store, db);
    requireServiceOriginalCheckboxGrantDependencies(service, store, grants);
    this.#db = db;
    this.#store = store;
    this.#coordinator = coordinator;
    this.#authority = authority;
    this.#service = service;
    this.#grants = grants;
    owners.set(this, {
      db,
      store,
      coordinator,
      grants,
      stop: () => this.#stop(),
      grant: (raw, actor, token) => this.#grant(raw, actor, token),
      stage: (g, tx, r, a) => this.#requireStage(g, tx, r, a),
      enter: (g, r, a) => this.#enter(g, r, a),
      resolve: (id, tx) => this.#resolve(id, tx),
    });
  }
  #live(): void {
    if (this.#stopped) throw new Error('Original checkbox grant preparation stopped.');
    requireInstallationOriginalCheckboxGrantPreparation(
      this,
      this.#db,
      this.#store,
      this.#coordinator
    );
  }
  #stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#stopPromise = Promise.allSettled([...this.#active]).then(() => undefined);
    return this.#stopPromise;
  }
  #grant(raw: unknown, rawActor: DocChannelActor, approvalToken?: string): Promise<DocGrantResult> {
    this.#live();
    // Page/caller write fields are rejected; the exact binding comes solely from physical observation.
    const request = freezeCheckboxData(DocRouteGrantRequestSchema.omit({ write: true }).parse(raw));
    const actor = captureCurrentHttpDocActor(rawActor);
    const work = Promise.resolve().then(() => this.#prepare(request, actor, approvalToken));
    this.#active.add(work);
    void work.then(
      () => this.#active.delete(work),
      () => this.#active.delete(work)
    );
    return work;
  }
  async #prepare(
    request: Omit<DocRouteGrantRequest, 'write'>,
    actor: DocChannelActor,
    approvalToken?: string
  ): Promise<DocGrantResult> {
    this.#live();
    if (this.#db.$client.inTransaction)
      throw new Error('Original FILE grant requires inactive SQL.');
    const document = await captureServiceCurrentDocument(
      this.#service,
      request.documentId,
      actor,
      []
    );
    this.#live();
    const first = await observeOriginalCheckboxGrantSource(
      this.#authority,
      this.#db,
      this.#store,
      this.#grants,
      request.documentId
    );
    this.#live();
    return withRecognizedCanonicalFiles(
      this.#coordinator,
      [first.canonicalPath],
      async (identities, lease) => {
        this.#live();
        await requireServiceCurrentDocument(this.#service, document.authority);
        this.#live();
        const final = await observeOriginalCheckboxGrantSource(
          this.#authority,
          this.#db,
          this.#store,
          this.#grants,
          request.documentId
        );
        this.#live();
        if (
          JSON.stringify(first) !== JSON.stringify(final) ||
          final.fileIdentity !== `${identities[0]!.device}:${identities[0]!.inode}`
        )
          throw new Error('Original FILE grant source changed while waiting.');
        const manifest = readDocAppManifest(final.root.canonicalPath);
        if ((manifest?.hash ?? null) !== final.manifestHash)
          throw new Error('Original FILE grant manifest changed.');
        if (this.#stage || this.#db.$client.inTransaction)
          throw new Error('Original FILE grant cannot reenter.');
        const binding = freezeCheckboxData(
          CanvasChannelCheckboxBindingSchema.parse({
            operation: 'checkbox-toggle' as const,
            sourceIdentity: final.descriptor.sourceIdentity!,
            resolvedCwd: final.descriptor.resolvedCwd!,
            treeKind: final.descriptor.treeKind,
            canonicalPath: final.canonicalPath,
          })
        );
        const fullRequest = freezeCheckboxData({ ...request, write: binding });
        const stage: Stage = {
          request: fullRequest,
          actor,
          document,
          observation: final,
          manifest,
          lease,
          identity: identities[0]!,
          resolved: false,
          entered: false,
        };
        this.#stage = stage;
        try {
          const result = grantOriginalPreparedCheckboxRoute(
            this.#grants,
            this.#db,
            this.#store,
            this,
            fullRequest,
            actor,
            approvalToken
          );
          if (!stage.resolved)
            throw new Error('Original FILE grant did not consume its fixed source stage.');
          requireOriginalCanonicalWriteLease(this.#coordinator, lease, stage.identity);
          return result;
        } finally {
          if (this.#stage === stage) this.#stage = undefined;
        }
      }
    );
  }
  #enter(grants: DocChannelGrants, request: DocRouteGrantRequest, actor: DocGrantActor): void {
    this.#live();
    const stage = this.#stage;
    if (
      !stage ||
      stage.entered ||
      grants !== this.#grants ||
      request !== stage.request ||
      actor !== stage.actor ||
      this.#db.$client.inTransaction
    )
      throw new Error('Original FILE grant operation already entered or foreign.');
    requireOriginalCanonicalWriteLease(this.#coordinator, stage.lease, stage.identity);
    stage.entered = true;
  }
  #requireStage(
    grants: DocChannelGrants,
    tx: DbTransaction,
    request?: DocRouteGrantRequest,
    actor?: DocGrantActor
  ): Stage {
    this.#live();
    const stage = this.#stage;
    if (
      !stage ||
      !stage.entered ||
      grants !== this.#grants ||
      !this.#db.$client.inTransaction ||
      (stage.tx && stage.tx !== tx) ||
      (request && request !== stage.request) ||
      (actor && actor.principal !== stage.actor.principal)
    )
      throw new Error('Foreign original FILE grant transaction.');
    stage.tx = tx;
    requireOriginalCanonicalWriteLease(this.#coordinator, stage.lease, stage.identity);
    requireServiceOriginalDocumentInTransaction(this.#service, stage.document.authority, tx);
    requireOriginalCheckboxGrantSource(
      this.#authority,
      this.#db,
      this.#store,
      this.#grants,
      stage.request.documentId,
      stage.observation,
      tx
    );
    return stage;
  }
  #resolve(documentId: string, tx?: DbTransaction): DocRouteGrantRequest['write'] | null {
    if (!this.#stage) return null;
    if (!tx || documentId !== this.#stage.request.documentId)
      throw new Error('Foreign original FILE grant binding read.');
    const stage = this.#requireStage(this.#grants, tx);
    stage.resolved = true;
    return stage.request.write!;
  }
}
