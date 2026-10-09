import { captureCurrentIngestIntention } from './current/current-operation-intentions.js';
import { auditCurrentIngestIntention } from './current/current-operation-row-audit.js';
/** Internal page-event acceptance. The host supplies a synchronous, verified authority callback. */
import { randomUUID } from 'node:crypto';
import { type DbTransaction } from '@dorkos/db';
import {
  PageEventSchema,
  matchesCanvasChannelEvent,
  type IngestReceipt,
  type PageEvent,
  type StoredPageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelStore, DocChannelClosedError, appendCurrentDocInput } from './store.js';
import {
  readCurrentDocIngressInput,
  requireCurrentDocEngines,
  assertCurrentDocOperation,
  failCurrentDocOperation,
  type DocChannelAuthorization,
} from './authorization.js';
import { copyCurrentDocData, sameCurrentDocData } from './current/current-operation-data.js';
import { checkboxAuthorityClock } from './writes/authority-snapshot.js';

import { queueInput } from './coalescer.js';
const currentIngestBindings = new WeakMap<
  DocChannelIngest,
  {
    store: DocChannelStore;
    limits: Readonly<DocIngestLimits>;
    clock: (authorization: DocChannelAuthorization, tx: DbTransaction) => string;
    accept: (authorization: DocChannelAuthorization, tx: DbTransaction) => DocIngestResult;
    audit: (authorization: DocChannelAuthorization, tx: DbTransaction) => void;
  }
>();

import { envelopeIdentity } from './envelope.js';
import { DOC_EVENTS_PROMPT_BYTES, docEventsPromptBytes } from './prompt.js';

import { appendInitialDocStatuses } from './initial-status.js';
import { DocIngestRefusal, type DocIngestAuthority, type DocIngestAccess } from './ingest-types.js';
import {
  readCheckboxConversionInput,
  failCheckboxCompletion,
  readPreparedCheckboxConversion,
  type OriginalPreparedCheckboxConversion,
} from './writes/reservations/reservation-bridge.js';
import {
  checkIngestCapacity,
  backfillEnvelopeAccounting,
  DOC_INGEST_LIMITS,
  type DocIngestLimits,
} from './current/accounting.js';

/** Durable accepted input with route receipts; publication can occur only after this returns. */
export interface DocIngestResult {
  receipt: IngestReceipt;
  deliveries: ReturnType<DocChannelStore['listDeliveries']>;
}

const originalCompletions = new WeakMap<
  DocChannelIngest,
  {
    store: DocChannelStore;
    complete: (tx: DbTransaction) => IngestReceipt;
    prepare: (
      authorization: DocChannelAuthorization,
      tx: DbTransaction,
      phase: OriginalPreparedCheckboxConversion
    ) => void;
    finish: (tx: DbTransaction) => void;
  }
>();

/** Fixed genuine constructor path; no caller-provided event, route authority or delegate. */
export function completeOriginalCheckboxOutbox(
  ingest: DocChannelIngest,
  store: DocChannelStore,
  tx: DbTransaction
): IngestReceipt {
  const own = originalCompletions.get(ingest);
  if (!own || own.store !== store)
    throw new Error('Checkbox completion requires its genuine ingest store.');
  return own.complete(tx);
}

/** Fixed original phase capture before append, not a caller-supplied row/count intention. */
export function prepareCurrentCheckboxIngest(
  ingest: DocChannelIngest,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction,
  phase: OriginalPreparedCheckboxConversion
): void {
  const own = originalCompletions.get(ingest);
  if (!own || own.store !== store) throw new Error('Foreign original checkbox ingestor.');
  own.prepare(authorization, tx, phase);
}
/** Recognizes only that original converted/committed scope and repeats its full audit. */
export function finishCurrentCheckboxIngest(
  ingest: DocChannelIngest,
  store: DocChannelStore,
  tx: DbTransaction
): void {
  const own = originalCompletions.get(ingest);
  if (!own || own.store !== store) throw new Error('Foreign original checkbox ingestor.');
  own.finish(tx);
}
/** Synchronous ingest/coalescer entry point, with no HTTP, grant creation or runtime side effects. */
export class DocChannelIngest {
  private readonly limits: DocIngestLimits;
  #clockActive = false;
  readonly #fixedClock: () => Date;
  readonly #fixedLimits: DocIngestLimits;
  readonly #fixedRows = new WeakMap<
    DbTransaction,
    import('./current/current-operation-intentions.js').CurrentIngestIntention
  >();
  readonly #checkboxAuthorization = new WeakMap<DbTransaction, DocChannelAuthorization>();
  /** Build over the shared channel store; lower limits are useful for installation policy and tests. */
  constructor(
    private readonly store: DocChannelStore,
    private readonly clock: () => Date = () => new Date(),
    limits: Partial<DocIngestLimits> = {}
  ) {
    originalCompletions.set(this, {
      store,
      complete: (tx) => this.#completeOriginal(tx),
      prepare: (authorization, tx, phase) => this.#prepareCheckbox(authorization, tx, phase),
      finish: (tx) => this.#finishCheckbox(tx),
    });
    this.limits = { ...DOC_INGEST_LIMITS };
    for (const key of Object.keys(this.limits) as (keyof DocIngestLimits)[]) {
      const value = limits[key] ?? this.limits[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > this.limits[key])
        throw new RangeError('Invalid ingest limit.');
      this.limits[key] = value;
    }
    this.#fixedClock = clock;
    this.#fixedLimits = Object.freeze({ ...this.limits });
    currentIngestBindings.set(this, {
      store,
      limits: this.#fixedLimits,
      clock: (authorization, tx) => this.#clockCurrent(authorization, tx),
      accept: (authorization, tx) => this.#acceptCurrent(authorization, tx),
      audit: (authorization, tx) => this.#auditCurrent(authorization, tx),
    });
  }

  /** Parse strict upstream data and commit acceptance only after current authority is rechecked. */
  accept(raw: unknown, authority: DocIngestAuthority): DocIngestResult {
    const parsed = PageEventSchema.safeParse(raw);
    if (!parsed.success) throw new DocIngestRefusal('INVALID_DOC_EVENT', 400);
    const event = parsed.data;
    const identity = envelopeIdentity(event);
    const now = this.clock().toISOString();
    try {
      return this.store.transaction((tx) =>
        this.acceptInTransaction(event, identity, now, authority, tx)
      );
    } catch (error) {
      if (isSqliteStorageError(error)) throw new DocIngestRefusal('DOC_EVENT_STORAGE_FAILURE', 507);
      throw error;
    }
  }

  private acceptInTransaction(
    event: PageEvent,
    identity: ReturnType<typeof envelopeIdentity>,
    now: string,
    authority: DocIngestAuthority,
    tx: DbTransaction
  ): DocIngestResult {
    const access = authority(tx);
    const channel = this.store.getChannel(access.documentId, tx);
    if (!channel || channel.closedAt !== null) throw new DocChannelClosedError(access.documentId);
    if (channel.scope !== access.scope) throw new DocIngestRefusal('DOC_IDENTITY_CHANGED', 409);
    const existing = this.store.getEvent(access.documentId, event.id, tx);
    if (existing) {
      if (existing.envelopeHash !== identity.hash)
        throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
      return {
        receipt: { id: event.id, status: 'duplicate', docSeq: existing.docSeq },
        deliveries: this.store.listDeliveries(access.documentId, event.id, tx),
      };
    }
    if (identity.bytes > Math.min(access.envelopeBytes ?? 16384, 16384))
      throw new DocIngestRefusal('DOC_EVENT_TOO_LARGE', 413);
    try {
      const validation: unknown = access.validatePayload?.(event.type, event.payload);
      if (
        validation &&
        (typeof validation === 'object' || typeof validation === 'function') &&
        'then' in validation
      ) {
        void Promise.resolve(validation).catch(() => {});
        throw new Error('Document payload validation must be synchronous.');
      }
    } catch {
      throw new DocIngestRefusal('INVALID_DOC_EVENT_PAYLOAD', 422);
    }
    const matching = access.routes.filter(({ route }) =>
      matchesCanvasChannelEvent(route.on, event.type)
    );
    // Even one input must fit the actual future renderer, including server labels and escaping.
    for (const { route, grantId } of matching) {
      if (!grantId || route.to === 'log' || route.turn.mode === 'none') continue;
      if (
        docEventsPromptBytes({
          documentId: access.documentId,
          documentLabel: access.documentLabel,
          scope: access.scope,
          batchId: randomUUID(),
          routeId: route.id,
          grantId,
          events: [
            { id: event.id, type: event.type, payload: event.payload, docSeq: channel.nextDocSeq },
          ],
        }) > DOC_EVENTS_PROMPT_BYTES
      )
        throw new DocIngestRefusal('DOC_EVENT_CONTEXT_TOO_LARGE', 413);
    }
    backfillEnvelopeAccounting(this.store, tx);
    checkIngestCapacity(
      tx,
      access.documentId,
      now,
      identity.bytes,
      access.eventsPerMinute,
      this.limits,
      matching.some(
        ({ route, grantId, grantRevision }) =>
          !!grantId && !!grantRevision && route.to !== 'log' && route.turn.mode !== 'none'
      )
    );
    const saved = this.store.appendEvent(
      {
        documentId: access.documentId,
        eventId: event.id,
        direction: 'upstream',
        type: event.type,
        payload: event.payload,
        envelopeHash: identity.hash,
        envelopeBytes: identity.bytes,
        coalesceKey: event.coalesceKey ?? null,
        clientTs: event.ts ?? null,
        receivedAt: now,
        provenance: access.provenance,
      },
      tx
    );
    return this.#routeAccepted(saved, access, now, tx);
  }

  #fixedAcceptInTransaction(
    event: StoredPageEvent,
    identity: ReturnType<typeof envelopeIdentity>,
    now: string,
    authorization: DocChannelAuthorization,
    tx: DbTransaction
  ): DocIngestResult {
    const input = readCurrentDocIngressInput(authorization, this.store, tx);
    const access: DocIngestAccess = input.access ?? {
      documentId: input.documentId,
      scope: input.scope,
      documentLabel: input.documentLabel,
      routes: [],
      provenance: { transport: 'http', trust: 'app_untrusted' },
    };
    const channel = this.store.getChannel(access.documentId, tx);
    if (!channel || channel.closedAt !== null) throw new DocChannelClosedError(access.documentId);
    if (channel.scope !== access.scope) throw new DocIngestRefusal('DOC_IDENTITY_CHANGED', 409);
    const existing = this.store.getEvent(access.documentId, event.id, tx);
    if (existing) {
      if (existing.envelopeHash !== identity.hash)
        throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
      return {
        receipt: { id: event.id, status: 'duplicate', docSeq: existing.docSeq },
        deliveries: this.store.listDeliveries(access.documentId, event.id, tx),
      };
    }
    if (identity.bytes > Math.min(access.envelopeBytes ?? 16384, 16384))
      throw new DocIngestRefusal('DOC_EVENT_TOO_LARGE', 413);
    try {
      const validation: unknown = access.validatePayload?.(event.type, event.payload);
      if (
        validation &&
        (typeof validation === 'object' || typeof validation === 'function') &&
        'then' in validation
      ) {
        void Promise.resolve(validation).catch(() => {});
        throw new Error('Document payload validation must be synchronous.');
      }
    } catch {
      throw new DocIngestRefusal('INVALID_DOC_EVENT_PAYLOAD', 422);
    }
    const matching = access.routes.filter(({ route }) =>
      matchesCanvasChannelEvent(route.on, event.type)
    );
    // Even one input must fit the actual future renderer, including server labels and escaping.
    for (const { route, grantId } of matching) {
      if (!grantId || route.to === 'log' || route.turn.mode === 'none') continue;
      if (
        docEventsPromptBytes({
          documentId: access.documentId,
          documentLabel: access.documentLabel,
          scope: access.scope,
          batchId: randomUUID(),
          routeId: route.id,
          grantId,
          events: [
            { id: event.id, type: event.type, payload: event.payload, docSeq: channel.nextDocSeq },
          ],
        }) > DOC_EVENTS_PROMPT_BYTES
      )
        throw new DocIngestRefusal('DOC_EVENT_CONTEXT_TOO_LARGE', 413);
    }
    backfillEnvelopeAccounting(this.store, tx);
    checkIngestCapacity(
      tx,
      access.documentId,
      now,
      identity.bytes,
      access.eventsPerMinute,
      this.#fixedLimits,
      matching.some(
        ({ route, grantId, grantRevision }) =>
          !!grantId && !!grantRevision && route.to !== 'log' && route.turn.mode !== 'none'
      )
    );
    assertCurrentDocOperation(authorization, this.store, tx);
    const saved = appendCurrentDocInput(this.store, authorization, tx);
    return this.#routeAccepted(saved, access, now, tx);
  }

  #clockCurrent(authorization: DocChannelAuthorization, tx: DbTransaction): string {
    requireCurrentDocEngines(authorization, this.store, tx, this);
    if (this.#clockActive)
      return failCurrentDocOperation(
        this.store,
        tx,
        new Error('Current ingest clock cannot reenter.')
      );
    this.#clockActive = true;
    try {
      return Date.prototype.toISOString.call(new Date(checkboxAuthorityClock(this.#fixedClock)));
    } catch (cause) {
      return failCurrentDocOperation(this.store, tx, cause);
    } finally {
      this.#clockActive = false;
    }
  }
  #acceptCurrent(authorization: DocChannelAuthorization, tx: DbTransaction): DocIngestResult {
    try {
      requireCurrentDocEngines(authorization, this.store, tx, this);
      const input = readCurrentDocIngressInput(authorization, this.store, tx);
      if (!input.now || this.#fixedRows.has(tx))
        throw new Error('Current ingestor is missing its captured clock or was reused.');
      this.#fixedRows.set(tx, captureCurrentIngestIntention(tx, input));
      const result = this.#fixedAcceptInTransaction(
        input.event,
        envelopeIdentity(input.event),
        input.now,
        authorization,
        tx
      );
      this.#auditCurrent(authorization, tx);
      return result;
    } catch (cause) {
      return failCurrentDocOperation(this.store, tx, cause);
    }
  }
  #auditCurrent(authorization: DocChannelAuthorization, tx: DbTransaction): void {
    try {
      requireCurrentDocEngines(authorization, this.store, tx, this);
      const input = readCurrentDocIngressInput(authorization, this.store, tx);
      const own = this.#fixedRows.get(tx);
      if (!own) throw new Error('Current ingestor original projection is absent.');
      auditCurrentIngestIntention(this.store, authorization, tx, input, own);
    } catch (cause) {
      return failCurrentDocOperation(this.store, tx, cause);
    }
  }

  #prepareCheckbox(
    authorization: DocChannelAuthorization,
    tx: DbTransaction,
    phase: OriginalPreparedCheckboxConversion
  ): void {
    requireCurrentDocEngines(authorization, this.store, tx, this);
    if (this.#fixedRows.has(tx) || this.#checkboxAuthorization.has(tx))
      throw new Error('Original checkbox ingest scope cannot be reused.');
    const original = readPreparedCheckboxConversion(this.store, tx, phase);
    const input = readCurrentDocIngressInput(authorization, this.store, tx);
    if (
      !input.now ||
      input.now !== original.receivedAt ||
      !sameCurrentDocData(input.event, original.event) ||
      !sameCurrentDocData(input.access, original.access)
    )
      throw new Error('Original checkbox source differs from its genuine prepared phase.');
    const own = captureCurrentIngestIntention(tx, input);
    if (own.duplicate) throw new Error('Original checkbox phase already has an event.');
    own.checkbox = { original: copyCurrentDocData(original.originalIntent), completed: false };
    this.#fixedRows.set(tx, own);
    this.#checkboxAuthorization.set(tx, authorization);
  }
  #finishCheckbox(tx: DbTransaction): void {
    const authorization = this.#checkboxAuthorization.get(tx);
    const own = this.#fixedRows.get(tx);
    if (!authorization || !own?.checkbox?.receipt || own.checkbox.completed)
      throw new Error('Original checkbox completion phase is unavailable.');
    own.checkbox.completed = true;
    this.#auditCurrent(authorization, tx);
  }
  #completeOriginal(tx: DbTransaction): IngestReceipt {
    try {
      const { event, access } = readCheckboxConversionInput(this.store, tx);
      const authorization = this.#checkboxAuthorization.get(tx);
      let originalAccess = access;
      if (authorization) {
        const input = readCurrentDocIngressInput(authorization, this.store, tx);
        if (!input.access || !sameCurrentDocData(input.access, access))
          throw new Error('Original checkbox converted access differs from its current scope.');
        // Queue intentions require the exact owner-retained access and decision identities.
        // The conversion reader returns equal DATA, which cannot replace those identities.
        originalAccess = input.access;
      }
      const result = this.#routeAccepted(event, originalAccess, event.receivedAt, tx);
      if (authorization) {
        const own = this.#fixedRows.get(tx);
        if (!own?.checkbox || own.checkbox.receipt)
          throw new Error('Original checkbox receipt scope changed.');
        own.checkbox.receipt = copyCurrentDocData(result.receipt);
        this.#auditCurrent(authorization, tx);
      }
      return result.receipt;
    } catch (cause) {
      return failCheckboxCompletion(this.store, tx, cause);
    }
  }

  #routeAccepted(
    saved: import('./store.js').DocEventRow,
    access: DocIngestAccess,
    now: string,
    tx: DbTransaction
  ): DocIngestResult {
    const matching = access.routes.filter(({ route }) =>
      matchesCanvasChannelEvent(route.on, saved.type)
    );
    for (const decision of matching) {
      const { route } = decision;
      if (
        route.to === 'log' ||
        route.turn.mode === 'none' ||
        !decision.grantId ||
        !decision.grantRevision
      ) {
        const current = this.#fixedRows.get(tx);
        if (current && !current.duplicate)
          current.deliveries.push(
            copyCurrentDocData({
              documentId: saved.documentId,
              eventId: saved.eventId,
              routeId: route.id,
              batchId: null,
              deliveryKind: null,
              roomAdmissionId: null,
              status: route.to === 'log' || route.turn.mode === 'none' ? 'routed' : 'saved',
              reason:
                route.to === 'log' || route.turn.mode === 'none'
                  ? 'no_turn'
                  : (decision.reason ?? 'approval_required'),
              turnId: null,
              ackOutcome: null,
              ackEvidence: null,
              acknowledgedAt: null,
              acknowledgedBy: null,
              updatedAt: now,
            })
          );
        this.store.insertDelivery(
          {
            documentId: saved.documentId,
            eventId: saved.eventId,
            routeId: route.id,
            status: route.to === 'log' || route.turn.mode === 'none' ? 'routed' : 'saved',
            reason:
              route.to === 'log' || route.turn.mode === 'none'
                ? 'no_turn'
                : (decision.reason ?? 'approval_required'),
            updatedAt: now,
          },
          tx
        );
      } else queueInput(this.store, tx, access, decision, saved, now);
    }
    const deliveries = this.store.listDeliveries(access.documentId, saved.eventId, tx);
    appendInitialDocStatuses(this.store, tx, saved, deliveries, now);
    return {
      receipt: { id: saved.eventId, status: 'recorded', docSeq: saved.docSeq },
      deliveries,
    };
  }
}

/** Drizzle can wrap the native SQLite failure from accounting query execution. */
export function isSqliteStorageError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    if ('code' in current && typeof current.code === 'string' && current.code.startsWith('SQLITE_'))
      return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Fixed genuine private clock phase; never reads a mutable public ingestor method. */
export function captureCurrentDocIngestClock(
  ingest: DocChannelIngest,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): string {
  const own = currentIngestBindings.get(ingest);
  if (!own || own.store !== store) throw new Error('Current ingestor store is foreign.');
  return own.clock(authorization, tx);
}
/** Closed original input path; event/access/time derive only from the genuine current operation. */
export function acceptCurrentDocEventInTransaction(
  ingest: DocChannelIngest,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): DocIngestResult {
  const own = currentIngestBindings.get(ingest);
  if (!own || own.store !== store) throw new Error('Current ingestor store is foreign.');
  return own.accept(authorization, tx);
}
/** Final fixed original event and outbox audit; no caller checker or new grant is accepted. */
export function auditCurrentDocIngestRows(
  ingest: DocChannelIngest,
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  tx: DbTransaction
): void {
  const own = currentIngestBindings.get(ingest);
  if (!own || own.store !== store) throw new Error('Current ingestor store is foreign.');
  own.audit(authorization, tx);
}

/** Constructor provenance check only; no callback or connection is returned. */
export function requireCurrentDocIngestEngine(
  ingest: DocChannelIngest,
  store: DocChannelStore
): void {
  const own = currentIngestBindings.get(ingest);
  if (!own || own.store !== store)
    throw new Error('Current document operation requires its genuine ingestor constructor.');
}

/** Read original immutable platform limits as DATA; this does not admit or reserve work. */
export function readOriginalDocIngestLimits(ingest: DocChannelIngest, store: DocChannelStore) {
  const own = currentIngestBindings.get(ingest);
  if (!own || own.store !== store) throw new Error('Current ingestor store is foreign.');
  return own.limits;
}
