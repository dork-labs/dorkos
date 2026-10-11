/** Durable physical checkbox effects through genuine current authority and fixed completion. */
import { type Db, type DbTransaction } from '@dorkos/db';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelActor } from '../authorization.js';
import {
  DocChannelStore,
  requireDocChannelStoreDatabase,
  type DocWriteIntentRow,
} from '../store.js';
import { findCheckboxIntent, quarantineCheckboxIntent } from './write-recovery.js';
import {
  CanonicalFileWriteCoordinator,
  type CanonicalWriteLease,
  requireOriginalCanonicalWriteLease,
} from './canonical-writer.js';
import {
  assertCheckboxReplacement,
  readCheckboxSource,
  readOriginalCheckboxFileCloseFailure,
} from './checkbox-file.js';
import {
  CheckboxWriteFence,
  CheckboxFenceUnavailableError,
  hasRecognizedCheckboxUnresolved,
} from './checkbox-fence.js';
import {
  DocCheckboxAuthority,
  readOriginalCheckboxAuthorityCloseFailure,
  type CheckboxReservationSubject,
} from './authority.js';
import { createOriginalCheckboxCompletion } from './completion.js';
import type { DocIngestLimits } from '../current/accounting.js';
import type { DocChannelService } from '../service.js';
import { requireInstallationOriginalCheckboxWriter } from './installation-file-writes.js';
import {
  CheckboxEvidenceError,
  validateCheckboxEvidence,
  freezeCheckboxData,
  preEffectCheckboxConflict,
  sync,
  type CheckboxRequest,
  type CheckboxReceipt,
  type VerifiedCheckboxAuthority,
  type CheckboxServiceOptions,
} from './checkbox-evidence.js';
import { runOriginalCheckboxToggleCurrent } from './checkbox/checkbox-toggle-current.js';
import { runOriginalCheckboxRecoverCurrent } from './checkbox/checkbox-recover-current.js';
import type { OriginalCheckboxWriteOperationContext } from './checkbox/checkbox-operation-context.js';
export {
  VerifiedCheckboxAuthoritySchema,
  type CheckboxRequest,
  type CheckboxReceipt,
  type VerifiedCheckboxAuthority,
  type CheckboxServiceOptions,
} from './checkbox-evidence.js';
export { UNRESOLVED_CHECKBOX_STATUSES } from './checkbox-evidence.js';

const checkboxOperationOwners = new WeakMap<object, OriginalCheckboxWriteOperationContext>();
const checkboxOperationGet = WeakMap.prototype.get;
const checkboxOperationSet = WeakMap.prototype.set;
const checkboxOperationApply = Reflect.apply;
/** Recognize only the inaccessible constructor key; public writer, DB and copied views cannot issue operations. */
export function readOriginalCheckboxWriteOperationContext(
  engineOwner: object
): OriginalCheckboxWriteOperationContext {
  const context: OriginalCheckboxWriteOperationContext | undefined = checkboxOperationApply(
    checkboxOperationGet,
    checkboxOperationOwners,
    [engineOwner]
  );
  if (!context) throw new CheckboxEvidenceError('Foreign original checkbox operation owner.');
  return context;
}

const originalCheckboxWriters = new WeakMap<
  DocCheckboxWriteService,
  {
    db: Db;
    store: DocChannelStore;
    coordinator: CanonicalFileWriteCoordinator;
    native: boolean;
    completion: ReturnType<typeof createOriginalCheckboxCompletion>;
    stop: () => Promise<void>;
    toggle: (raw: unknown, actor: DocChannelActor) => Promise<CheckboxReceipt>;
    recover: (id: string) => Promise<CheckboxReceipt>;
  }
>();
/** Fixed installation child lookup; no supplied shutdown callback or independent coordinator. */
export function requireOriginalCheckboxWriterAssembly(
  writer: DocCheckboxWriteService,
  db: Db,
  store: DocChannelStore,
  coordinator: CanonicalFileWriteCoordinator
): Readonly<{ stop: () => Promise<void> }> {
  const own = originalCheckboxWriters.get(writer);
  if (!own || own.db !== db || own.store !== store || own.coordinator !== coordinator)
    throw new CheckboxEvidenceError('Foreign original checkbox installation child.');
  return Object.freeze({ stop: own.stop });
}
/** Actual constructor recognition only; copied writer/receipt rows cannot supply this tuple. */
export function requireOriginalCheckboxWriterCompletion(
  writer: DocCheckboxWriteService,
  completion: object,
  store: DocChannelStore,
  coordinator: CanonicalFileWriteCoordinator
): void {
  const own = originalCheckboxWriters.get(writer);
  if (
    !own ||
    own.store !== store ||
    own.completion !== completion ||
    own.coordinator !== coordinator
  )
    throw new CheckboxEvidenceError('Original checkbox writer completion custody changed.');
  if (own.native) requireInstallationOriginalCheckboxWriter(writer, own.db, store, coordinator);
}
/** Fixed owning constructor shutdown, independent of mutable public methods. */
export function stopOriginalCheckboxWriter(writer: DocCheckboxWriteService): Promise<void> {
  const own = originalCheckboxWriters.get(writer);
  if (!own) throw new CheckboxEvidenceError('Foreign original checkbox writer.');
  return own.stop();
}
/** Toggle through the installed checkbox writer's captured original implementation. */
export function toggleOriginalCheckboxWriter(
  writer: DocCheckboxWriteService,
  raw: unknown,
  actor: DocChannelActor
): Promise<CheckboxReceipt> {
  const own = originalCheckboxWriters.get(writer);
  if (!own) throw new CheckboxEvidenceError('Foreign original checkbox writer.');
  return own.toggle(raw, actor);
}
/** Recover an intent through the checkbox writer's captured original implementation. */
export function recoverOriginalCheckboxWriter(
  writer: DocCheckboxWriteService,
  id: string
): Promise<CheckboxReceipt> {
  const own = originalCheckboxWriters.get(writer);
  if (!own) throw new CheckboxEvidenceError('Foreign original checkbox writer.');
  return own.recover(id);
}

/** No caller-controlled authority checker, host acceptance callback or default delivery policy. */
export class DocCheckboxWriteService {
  readonly #operationKey: object;

  readonly #writeFence: CheckboxWriteFence;
  readonly #db: Db;
  readonly #store: DocChannelStore;
  readonly #coordinator: CanonicalFileWriteCoordinator;
  readonly #authority: DocCheckboxAuthority;
  readonly #options: CheckboxServiceOptions;
  get db(): Db {
    return this.#db;
  }
  get store(): DocChannelStore {
    return this.#store;
  }
  get writeFence(): CheckboxWriteFence {
    return this.#writeFence;
  }
  #stopped = false;
  #stopPromise: Promise<void> | undefined;
  #closeFailed = false;
  #firstCloseFailure: unknown;
  readonly #active = new Set<Promise<unknown>>();
  readonly #completion: ReturnType<typeof createOriginalCheckboxCompletion>;
  constructor(
    db: Db,
    store: DocChannelStore,
    coordinator: CanonicalFileWriteCoordinator,
    authority: DocCheckboxAuthority,
    delivery: {
      policyLimits: DocIngestLimits;
      notifyCommitted: (documentId: string) => undefined;
      service?: DocChannelService;
    },
    options: CheckboxServiceOptions = {}
  ) {
    requireDocChannelStoreDatabase(store, db);
    this.#db = db;
    this.#store = store;
    this.#coordinator = coordinator;
    this.#authority = authority;
    this.#options = options;
    this.#completion = createOriginalCheckboxCompletion({
      authority,
      store,
      ...delivery,
      ...(delivery.service ? { writer: this, coordinator } : {}),
    });
    this.#writeFence = new CheckboxWriteFence(db, store);
    originalCheckboxWriters.set(this, {
      db,
      store,
      coordinator,
      native: !!delivery.service,
      completion: this.#completion,
      stop: () => this.#stopOriginal(),
      toggle: (raw, actor) => this.#toggleOriginal(raw, actor),
      recover: (id) => this.#recoverOriginal(id),
    });
    const operationKey = {};
    this.#operationKey = operationKey;
    const operationView: OriginalCheckboxWriteOperationContext = {
      authority: this.#authority,
      completion: this.#completion,
      coordinator: this.#coordinator,
      db: this.#db,
      store: this.#store,
      writeFence: this.#writeFence,
      authorityRefused: (...args) => this.#authorityRefused(...args),
      boundary: (...args) => this.#boundary(...args),
      checkpoint: (...args) => this.#checkpoint(...args),
      complete: (...args) => this.#complete(...args),
      duplicate: (...args) => this.#duplicate(...args),
      find: (...args) => this.#find(...args),
      live: (...args) => this.#live(...args),
      preEffectConflict: (...args) => this.#preEffectConflict(...args),
      quarantine: (...args) => this.#quarantine(...args),
      readSource: (...args) => this.#readSource(...args),
      receipt: (...args) => this.#receipt(...args),
      retainCloseFailure: (...args) => this.#retainCloseFailure(...args),
      time: (...args) => this.#time(...args),
      track: <T>(work: () => Promise<T>): Promise<T> => this.#track(work),
      validate: (...args) => this.#validate(...args),
    };
    checkboxOperationApply(checkboxOperationSet, checkboxOperationOwners, [
      operationKey,
      Object.freeze(operationView),
    ]);
  }
  async toggle(raw: unknown, actor: DocChannelActor): Promise<CheckboxReceipt> {
    return this.#toggleOriginal(raw, actor);
  }
  async #toggleOriginal(raw: unknown, actor: DocChannelActor): Promise<CheckboxReceipt> {
    const request = freezeCheckboxData(CanvasChannelCheckboxRequestSchema.parse(raw));
    return this.#track(() => this.#toggleCurrent(request, actor));
  }
  /** Host must drain every owned filesystem/SQL continuation before disposing its database. */
  stop(): Promise<void> {
    return this.#stopOriginal();
  }
  #stopOriginal(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#stopPromise = Promise.allSettled([...this.#active]).then(() => {
      this.#retainAuthorityCloseFailure();
      if (this.#closeFailed) throw this.#firstCloseFailure;
    });
    return this.#stopPromise;
  }
  #track<T>(work: () => Promise<T>): Promise<T> {
    this.#retainAuthorityCloseFailure();
    if (this.#closeFailed) return Promise.reject(this.#firstCloseFailure);
    if (this.#stopped) return Promise.reject(new Error('Checkbox writes are stopped.'));
    const promise = Promise.resolve().then(work);
    this.#active.add(promise);
    void promise.then(
      () => this.#active.delete(promise),
      () => this.#active.delete(promise)
    );
    return promise;
  }
  assertAvailable(): void {
    this.#boundary();
  }
  #boundary(): void {
    this.#retainAuthorityCloseFailure();
    if (this.#closeFailed) throw this.#firstCloseFailure;
    if (this.#stopped || this.#db.$client.inTransaction)
      throw new Error('Checkbox writes are not available.');
  }
  #time(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }
  find(documentId: string, eventId: string, tx?: DbTransaction): DocWriteIntentRow | undefined {
    return this.#find(documentId, eventId, tx);
  }
  #find(documentId: string, eventId: string, tx?: DbTransaction): DocWriteIntentRow | undefined {
    return findCheckboxIntent(this.#store, this.#db, documentId, eventId, tx);
  }
  fenced(_path: string): boolean {
    try {
      return hasRecognizedCheckboxUnresolved(this.#writeFence, this.#db, this.#store);
    } catch (cause) {
      if (cause instanceof CheckboxFenceUnavailableError) return true;
      throw cause;
    }
  }
  #live(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority
  ): Extract<CheckboxReservationSubject, { kind: 'live' }> {
    return { kind: 'live', request, actor, approved };
  }
  async #toggleCurrent(request: CheckboxRequest, actor: DocChannelActor): Promise<CheckboxReceipt> {
    return runOriginalCheckboxToggleCurrent(this.#operationKey, request, actor);
  }
  async #preEffectConflict(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority,
    digest: string
  ): Promise<CheckboxReceipt> {
    this.#authority.transaction((tx) =>
      this.#authority.requireAccess(request.documentId, actor, tx)
    );
    const original = preEffectCheckboxConflict(request, approved, digest, this.#time());
    const freshSnapshot = await this.#authority.refreshCurrent(request, actor, approved);
    this.#boundary();
    return this.#authority.transaction((tx) => {
      const existing = this.#find(request.documentId, request.eventId, tx);
      if (existing) return this.#duplicate(existing, digest, actor, tx);
      return this.#completion.insertConflictInTransaction(
        {
          candidate: original.intent,
          liveSubject: this.#live(request, actor, approved),
          freshSnapshot,
        },
        tx
      );
    });
  }
  #duplicate(
    row: DocWriteIntentRow,
    digest: string,
    actor: DocChannelActor,
    tx?: DbTransaction
  ): CheckboxReceipt {
    return this.#completion.readDuplicate(
      { intentId: row.intentId, documentId: row.documentId, eventId: row.eventId, digest, actor },
      tx
    );
  }
  receipt(row: DocWriteIntentRow): CheckboxReceipt {
    return this.#receipt(row);
  }
  #receipt(row: DocWriteIntentRow): CheckboxReceipt {
    const evidence = this.#validate(row);
    return evidence.receipt ?? { status: 'in_doubt', eventId: row.eventId, action: 'review' };
  }
  validate(row: DocWriteIntentRow): ReturnType<typeof validateCheckboxEvidence> {
    return this.#validate(row);
  }
  #validate(row: DocWriteIntentRow): ReturnType<typeof validateCheckboxEvidence> {
    return validateCheckboxEvidence(row);
  }
  /** Fresh full fences bracket the complete readonly filesystem proof; every await checks lifetime. */
  #retainAuthorityCloseFailure(): void {
    const failure = readOriginalCheckboxAuthorityCloseFailure(
      this.#authority,
      this.#db,
      this.#store
    );
    if (failure) this.#retainCloseFailure(failure.cause);
  }
  #retainCloseFailure(cause: unknown): void {
    if (!this.#closeFailed) {
      this.#closeFailed = true;
      this.#firstCloseFailure = cause;
    }
  }
  async #readSource(
    approved: VerifiedCheckboxAuthority,
    assertCurrent: () => void
  ): ReturnType<typeof readCheckboxSource> {
    assertCurrent();
    const boundary = () => this.#boundary();
    try {
      const source = await readCheckboxSource(approved, boundary);
      assertCurrent();
      return source;
    } finally {
      const failure = readOriginalCheckboxFileCloseFailure(boundary);
      if (failure) this.#retainCloseFailure(failure.cause);
    }
  }
  async #complete(
    row: DocWriteIntentRow,
    subject: CheckboxReservationSubject,
    assertFs: () => void,
    lease: CanonicalWriteLease
  ): Promise<CheckboxReceipt> {
    const approved = this.#validate(row).authority;
    const freshSnapshot =
      subject.kind === 'live'
        ? await this.#authority.refreshCurrent(subject.request, subject.actor, approved)
        : await this.#authority.refreshRecoveryCurrent(row, approved);
    const verified = await this.#readSource(approved, assertFs);
    assertCheckboxReplacement(row, verified);
    assertFs();
    requireOriginalCanonicalWriteLease(this.#coordinator, lease, {
      canonicalPath: row.canonicalPath,
      device: verified.device,
      inode: verified.inode,
    });
    return this.#completion.complete({ intentId: row.intentId, subject, freshSnapshot, lease });
  }
  #quarantine(expected: DocWriteIntentRow, reason: string): void {
    try {
      quarantineCheckboxIntent(this.#store, expected, reason, this.#time());
    } catch {
      /* Original corrupt/unavailable evidence stays unresolved and conservatively fenced. */
    }
  }
  /** Recovery verifies the recorded effect only; no marker write, new approval or new input UUID. */
  recover(id: string): Promise<CheckboxReceipt> {
    return this.#recoverOriginal(id);
  }
  #recoverOriginal(id: string): Promise<CheckboxReceipt> {
    return runOriginalCheckboxRecoverCurrent(this.#operationKey, id);
  }
  #authorityRefused(error: unknown): boolean {
    try {
      const result = sync(this.#authority.isAuthorityRefusal(error));
      return typeof result === 'boolean' && result;
    } catch {
      return false;
    }
  }
  async #checkpoint(
    point: Parameters<NonNullable<CheckboxServiceOptions['checkpoint']>>[0],
    row: DocWriteIntentRow
  ): Promise<void> {
    this.#boundary();
    await this.#options.checkpoint?.(point, row);
    this.#boundary();
  }
}
