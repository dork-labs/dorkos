import { registerOriginalEngineViews } from './current-view-registration-facet.js';
import type { OriginalEngineViewRegistrationFacet } from './current-view-registration-context.js';
import { createOriginalEngineCoreProjection } from './projection/current-core-projection-facet.js';
import type { OriginalEngineCoreProjectionFacet } from './projection/current-core-projection-context.js';
import { createIsolatedCurrentTokenCustody } from './current-isolated-token-custody.js';
import { createPrivateEngineDelegateCalls } from './current-private-delegate-calls.js';
import { createPrivateCurrentEngineState } from './current-private-state.js';
import { createIsolatedEngineFacetCustody } from './current-isolated-facet-custody.js';

// Registration stays in this original constructor module; no issuer or registry is exported.
const originalFacetApply = Reflect.apply;
const originalFacetGet = WeakMap.prototype.get;
const originalFacetSet = WeakMap.prototype.set;
const originalFacetFreeze = Object.freeze;
const originalCoreProjectionFacets = new WeakMap<object, OriginalEngineViewRegistrationFacet>();
/** Read only the actual constructor's private core projection ports; public cores and proxies refuse. */
export function readOriginalEngineCoreProjectionFacet(
  owner: object
): OriginalEngineCoreProjectionFacet {
  const facet = originalFacetApply(originalFacetGet, originalCoreProjectionFacets, [owner]);
  if (!facet) throw new DocChannelNotFoundError();
  return facet;
}
/** Guard the original private constructor's registration ports; no caller context is accepted. */
export function readOriginalEngineViewRegistrationFacet(
  owner: object
): OriginalEngineViewRegistrationFacet {
  const facet = originalFacetApply(originalFacetGet, originalCoreProjectionFacets, [owner]);
  if (!facet) throw new DocChannelNotFoundError();
  return facet;
}
const originalEngineFacetCustody = createIsolatedEngineFacetCustody(
  originalFacetApply,
  originalFacetGet,
  originalFacetSet,
  DocChannelNotFoundError
);
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalRoomRetirementFacet =
  originalEngineFacetCustody.readOriginalRoomRetirementFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalDocumentCaptureFacet =
  originalEngineFacetCustody.readOriginalDocumentCaptureFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalRoomProducerFacet =
  originalEngineFacetCustody.readOriginalRoomProducerFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalCurrentEntryFacet =
  originalEngineFacetCustody.readOriginalCurrentEntryFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalEditorSaveSelectionFacet =
  originalEngineFacetCustody.readOriginalEditorSaveSelectionFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalTokenNativeInputFacet =
  originalEngineFacetCustody.readOriginalTokenNativeInputFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalTokenIssuanceFacet =
  originalEngineFacetCustody.readOriginalTokenIssuanceFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalMountedPresenceFacet =
  originalEngineFacetCustody.readOriginalMountedPresenceFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalEventAdmissionFacet =
  originalEngineFacetCustody.readOriginalEventAdmissionFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalPresenceExpiryFacet =
  originalEngineFacetCustody.readOriginalPresenceExpiryFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalReadProjectionFacet =
  originalEngineFacetCustody.readOriginalReadProjectionFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalExpiredReplayFacet =
  originalEngineFacetCustody.readOriginalExpiredReplayFacet;
/** Recognize only the actual private engine before disclosing its original facet ports. */
export const readOriginalTokenStreamFacet = originalEngineFacetCustody.readOriginalTokenStreamFacet;

const originalCurrentTokenCustody = createIsolatedCurrentTokenCustody();
/** Original active private stage custody only; no registration authority is exported. */
export const consumeOriginalDocPresenceAppend =
  originalCurrentTokenCustody.consumeOriginalDocPresenceAppend;
/** Original active private stage custody only; no registration authority is exported. */
export const consumeOriginalDocTokenIssuanceInsideCurrent =
  originalCurrentTokenCustody.consumeOriginalDocTokenIssuanceInsideCurrent;
/** Original active private stage custody only; no registration authority is exported. */
export const requireOriginalDocTokenIssuanceAuthenticationEntry =
  originalCurrentTokenCustody.requireOriginalDocTokenIssuanceAuthenticationEntry;
/** Original active private stage custody only; no registration authority is exported. */
export const readOriginalDocTokenIssuanceAuthenticationMessage =
  originalCurrentTokenCustody.readOriginalDocTokenIssuanceAuthenticationMessage;
/** Original active private stage custody only; no registration authority is exported. */
export const consumeOriginalDocTokenRevocationInsideCurrent =
  originalCurrentTokenCustody.consumeOriginalDocTokenRevocationInsideCurrent;

import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';

import { DocChannelTokenStore } from '../tokens/token-store.js';

const MaintenanceDate = Date;
const maintenanceNow = Date.now;
const maintenanceParse = Date.parse;
const tokenStreamDelay = setTimeout,
  tokenStreamCancel = clearTimeout;
const tokenScalarJson = JSON.stringify;
const tokenOwnDescriptor = Object.getOwnPropertyDescriptor;
const tokenOwnKeys = Object.keys;
const tokenUtf8Bytes = Buffer.byteLength;
const maintenanceIso = Date.prototype.toISOString;

/** Document authorization resolves private identity before disclosing channel data. */
import { type Db, type DbTransaction } from '@dorkos/db';

import { type CanvasDocumentStore } from '../../canvas-document-store.js';

import { type DocChannelStore } from '../store.js';

import { type DocChannelGrants } from '../grants.js';

import { captureCurrentDocConfiguration } from './current-operation-data.js';

import {
  type CurrentOperationScope,
  type CurrentDocOperationEngineCore,
} from './current-operation-types.js';

import {
  DocChannelNotFoundError,
  requireCurrentDocEngineOrigin,
  type DocChannelAuthorization,
  type DocChannelAuthorityPorts,
} from '../authorization.js';

export type { CurrentOperationScope, CurrentDocOperationEngineCore };
class CurrentDocOperationEngine {
  readonly #state = createPrivateCurrentEngineState();
  readonly #delegates = createPrivateEngineDelegateCalls(this);
  constructor(
    authorization: DocChannelAuthorization,
    db: Db,
    documents: CanvasDocumentStore,
    ports: DocChannelAuthorityPorts,
    scopes: WeakMap<DbTransaction, CurrentOperationScope>
  ) {
    this.#state.authorization = authorization;
    this.#state.db = db;
    this.#state.nativePrepare = db.$client.prepare.bind(db.$client);
    this.#state.scopes = scopes;
    this.#state.fixedPorts = captureCurrentDocConfiguration(ports);
    originalFacetApply(originalFacetSet, originalCoreProjectionFacets, [
      this,
      originalFacetFreeze<OriginalEngineViewRegistrationFacet>({
        state: this.#state,
        custody: originalEngineFacetCustody,
        tokenCustody: originalCurrentTokenCustody,
        freeze: originalFacetFreeze,
        tokenStreamDelay,
        tokenStreamCancel,
        MaintenanceDate,
        maintenanceNow,
        maintenanceParse,
        maintenanceIso,
        tokenScalarJson,
        tokenOwnDescriptor,
        tokenOwnKeys,
        tokenUtf8Bytes,
        retainTokenManifestOwner: (grants, store) => this.#retainTokenManifestOwner(grants, store),
        originalTokenStore: () => this.#originalTokenStore(),
        schedulePresence: () => this.#schedulePresence(),
        delegates: this.#delegates,
        queuePresence: <T>(operation: () => Promise<T>) => this.#queuePresence(operation),
        trackTokenOperation: <T>(operation: () => Promise<T>) =>
          this.#trackTokenOperation(operation),
        stopRoomPump: () => this.#stopRoomPump(),
      }),
    ]);
    this.#state.core = createOriginalEngineCoreProjection(this);

    registerOriginalEngineViews(this);
  }

  #trackTokenOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#state.roomPumpStopped) return Promise.reject(new DocChannelNotFoundError());
    // Registration precedes any source/clock/member callback in the real operation.
    const pending = Promise.resolve().then(operation);
    this.#state.activeTokenOperations.add(pending);
    void pending.then(
      () => this.#state.activeTokenOperations.delete(pending),
      () => this.#state.activeTokenOperations.delete(pending)
    );
    return pending;
  }
  #retainTokenManifestOwner(grants: DocChannelGrants, store: DocChannelStore): void {
    for (let index = 0; index < this.#state.tokenManifestOwners.length; index++) {
      const own = this.#state.tokenManifestOwners[index]!;
      if (own.grants === grants) {
        if (own.store !== store) throw new DocChannelNotFoundError();
        return;
      }
    }
    Object.defineProperty(
      this.#state.tokenManifestOwners,
      String(this.#state.tokenManifestOwners.length),
      {
        value: { grants, store },
        enumerable: true,
        writable: true,
        configurable: true,
      }
    );
  }
  #originalTokenStore(): DocChannelTokenStore {
    requireCurrentDocEngineOrigin(this.#state.authorization, this.#state.core, this.#state.db);
    if (
      this.#state.roomPumpStopped ||
      this.#state.db.$client.inTransaction ||
      this.#state.currentEntry
    )
      throw new DocChannelNotFoundError();
    requireServerNativeDatabaseQueryCustody(this.#state.db);
    return (this.#state.tokenStore ??= new DocChannelTokenStore(this.#state.db));
  }

  #queuePresence<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#state.presenceTail;
    const pending = this.#trackTokenOperation(async () => {
      await prior;
      if (this.#state.roomPumpStopped) throw new DocChannelNotFoundError();
      return operation();
    });
    this.#state.presenceTail = pending.then(
      () => {},
      () => {}
    );
    return pending;
  }

  #schedulePresence(): void {
    if (this.#state.presenceTimer !== undefined) {
      originalFacetApply(this.#state.presenceClearTimeout, this, [this.#state.presenceTimer]);
      this.#state.presenceTimer = undefined;
    }
    if (this.#state.roomPumpStopped) return;
    const next = this.#state.presenceLedger.next(new Set(this.#state.presenceFailures.keys()));
    if (!next) return;
    this.#state.presenceTimer = originalFacetApply(this.#state.presenceSetTimeout, this, [
      () => {
        this.#state.presenceTimer = undefined;
        if (this.#state.roomPumpStopped) return;
        const work = this.#queuePresence(async () => {
          // Prior queued work may have positively removed the final mount or replaced
          // its surviving caller. Read only after that original operation has settled.
          const own = this.#state.presenceDocuments.get(next.documentId);
          if (!own) {
            if (this.#state.presenceLedger.hasDocument(next.documentId))
              throw new Error('Original presence expiry context is unavailable.');
            this.#schedulePresence();
            return;
          }
          const retirement = this.#delegates.retireKnownPresence(next.documentId);
          if (retirement.retired) {
            this.#schedulePresence();
            return;
          }
          return this.#delegates.expirePresenceNative(next.documentId, own, retirement.callers);
        });
        void work.catch((cause) => {
          if (!this.#state.presenceFailure) this.#state.presenceFailure = { cause };
          if (!this.#state.presenceFailures.has(next.documentId))
            this.#state.presenceFailures.set(next.documentId, { cause });
          this.#schedulePresence();
        });
      },
      Math.max(0, next.at - originalFacetApply(this.#state.presenceNow, this, [])),
    ]);
  }
  #stopRoomPump(): Promise<void> {
    if (this.#state.roomStop) return this.#state.roomStop;
    // Own the memo before configured construction callbacks can enter this method.
    this.#state.roomStop = new Promise<void>((resolve, reject) => {
      this.#state.resolveRoomStop = resolve;
      this.#state.rejectRoomStop = reject;
    });
    void this.#state.roomStop.catch(() => {}); // Original returned promise retains its failure.
    this.#state.roomPumpStopped = true;
    try {
      if (this.#state.presenceTimer !== undefined)
        originalFacetApply(this.#state.presenceClearTimeout, this, [this.#state.presenceTimer]);
      this.#state.presenceTimer = undefined;
    } catch (cause) {
      if (!this.#state.presenceFailure) this.#state.presenceFailure = { cause };
    }
    for (const state of this.#state.liveTokenStreams) this.#delegates.retireTokenStream(state);
    if (this.#state.roomConstruction !== 'constructing') this.#delegates.finishRoomStop();
    return this.#state.roomStop;
  }

  core(): CurrentDocOperationEngineCore {
    return this.#state.core;
  }
}
/** Fixed implementation factory only; it cannot attach its result to an existing authorization. */
export function createCurrentDocOperationEngine(
  authorization: DocChannelAuthorization,
  db: Db,
  documents: CanvasDocumentStore,
  ports: DocChannelAuthorityPorts,
  scopes: WeakMap<DbTransaction, CurrentOperationScope>
): CurrentDocOperationEngineCore {
  return new CurrentDocOperationEngine(authorization, db, documents, ports, scopes).core();
}
