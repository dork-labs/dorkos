import type { DbTransaction } from '@dorkos/db';
import type {
  DocGrantActor,
  DocGrantTarget,
  DocOriginalWriteObservation,
} from '../grant-policy.js';
import type { DocGrantRow, DocBatchRow } from '../store.js';
import type { DocAppManifest } from '../app-manifest.js';
import type { DocGrantedRoute } from '../current/current-operation-types.js';
import type { grantCoreGetEffectiveLimits } from './grant-current-core.js';
import * as grant_live_current from './grant-live-current.js';
import * as grant_write_relay_current from './grant-write-relay-current.js';

/** Original synchronous forwarding family; the actual constructor supplies an inaccessible opaque key. */
export class OriginalGrantRevalidationDispatch {
  readonly #originalKey: object;
  /** Retain only an opaque selector; every effect first checks actual-root membership. */
  constructor(originalKey: object) {
    this.#originalKey = originalKey;
  }
  protected now(): string {
    return grant_live_current.now(this.#originalKey);
  }
  protected access(
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): { id: string; scope: string } {
    return grant_live_current.access(this.#originalKey, documentId, actor, tx);
  }
  /**
   * Commit observed manifest suspension before opening an acceptance transaction.
   * Call again after a final MANIFEST_CHANGED refusal if the app raced this preflight.
   * A payload refusal or admission rollback cannot undo this explicit refresh.
   */
  refreshAuthority(documentId: string, actor: DocGrantActor): void {
    return grant_live_current.refreshAuthority(this.#originalKey, documentId, actor);
  }
  /** Refresh durable background authority without reusing an expired opener-turn principal. */
  refreshGrantedAuthority(grantId: string): void {
    return grant_live_current.refreshGrantedAuthority(this.#originalKey, grantId);
  }
  protected manifest(documentId: string, tx: DbTransaction): DocAppManifest | undefined {
    return grant_live_current.manifest(this.#originalKey, documentId, tx);
  }
  protected suspend(documentId: string, tx: DbTransaction): void {
    return grant_live_current.suspend(this.#originalKey, documentId, tx);
  }
  /** Validate declared app payloads inside acceptance's transaction; undeclared types stay log-only. */
  validateEventPayload(
    documentId: string,
    type: string,
    payload: unknown,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): void {
    return grant_live_current.validateEventPayload(
      this.#originalKey,
      documentId,
      type,
      payload,
      actor,
      tx
    );
  }
  /** Recheck hashes, current origin/target, expiry and revocation before a final admission effect. */
  revalidateGrant(
    documentId: string,
    grantId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): DocGrantRow {
    return grant_live_current.revalidateGrant(this.#originalKey, documentId, grantId, actor, tx);
  }
  /** Pure original write grant check: supplied observation replaces ONLY legacy filesystem ports. */
  revalidateOriginalWriteGrant(
    documentId: string,
    grantId: string,
    revision: number,
    scope: string,
    observed: DocOriginalWriteObservation,
    tx: DbTransaction
  ): DocGrantRow {
    return grant_write_relay_current.revalidateOriginalWriteGrant(
      this.#originalKey,
      documentId,
      grantId,
      revision,
      scope,
      observed,
      tx
    );
  }

  /**
   * Background dispatch uses persisted server grant evidence, never an expired
   * opener-turn proof or a freshly minted broad operator identity.
   */
  revalidateBatchGrant(
    batch: DocBatchRow,
    tx: DbTransaction
  ): { grant: DocGrantRow; target: DocGrantTarget } {
    return grant_write_relay_current.revalidateBatchGrant(this.#originalKey, batch, tx);
  }
  /** Effective document ingress caps; an app manifest can only lower platform caps. */
  getEffectiveLimits(
    documentId: string,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): ReturnType<typeof grantCoreGetEffectiveLimits> {
    return grant_live_current.getEffectiveLimits(this.#originalKey, documentId, actor, tx);
  }
  /** Return current granted or saved-only route outcomes; never enqueue or replay old input. */
  getCurrentRoutes(
    documentId: string,
    type: string | undefined,
    actor: DocGrantActor,
    tx?: DbTransaction
  ): DocGrantedRoute[] {
    return grant_live_current.getCurrentRoutes(this.#originalKey, documentId, type, actor, tx);
  }
}
