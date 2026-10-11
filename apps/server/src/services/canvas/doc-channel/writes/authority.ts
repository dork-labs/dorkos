import {
  accessOriginalCheckboxRows,
  checkOriginalCheckboxRows,
  requireOriginalCheckboxEditor,
  requireOriginalCheckboxGrantDescriptor,
} from './authority/authority-sql-current.js';
import {
  prepareOriginalCheckboxAuthority,
  prepareOriginalCheckboxRecovery,
  refreshOriginalCheckboxAuthority,
  refreshOriginalCheckboxRecovery,
  requireOriginalCheckboxAuthorityCurrent,
  requireOriginalCheckboxRecoveryCurrent,
} from './authority/authority-current-operations.js';
import type { OriginalCheckboxAuthorityOperationView } from './authority/authority-current-context.js';
/** Original operator-approved checkbox authority; filesystem observations precede pure SQL gates. */
import {
  captureCheckboxDependencies,
  isCheckboxAuthorityRefusal,
  readCheckboxPhysicalTitle,
  type CheckboxAuthorityDependencies,
  type CheckboxReservationSubject,
} from './authority/authority-policy.js';
export type {
  CheckboxAuthorityDependencies,
  CheckboxReservationSubject,
} from './authority/authority-policy.js';
import {
  auditCheckboxReservationScope,
  retireCheckboxReservationScope,
} from './reservations/reservation-bridge.js';
import { requireDocChannelStoreDatabase } from '../store.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DbTransaction } from '@dorkos/db';
import type { DocChannelActor } from '../authorization.js';
import { readDocSourceDescriptor } from '../current/doc-source-policy.js';
import type { DocChannelStore, DocWriteIntentRow } from '../store.js';
import type { SynchronousResult } from '../storage/store-transaction.js';
import { type CheckboxRequest, type VerifiedCheckboxAuthority } from './checkbox-evidence.js';
import {
  CheckboxAuthorityRefusal,
  requireSameCheckboxActor,
  CheckboxAuthorityTransactions,
  CheckboxSnapshotRegistry,
  checkboxAuthoritySync,
  checkboxAuthorityClock,
  withCheckboxReadOnlyGate,
  observeCheckboxSource,
  readOriginalCheckboxManifestCloseFailure,
  type CheckboxAuthoritySnapshot,
  type CheckboxSourceObservation,
} from './authority/authority-snapshot.js';

const authorityOperationViews = new WeakMap<object, OriginalCheckboxAuthorityOperationView>();
const authorityOperationApply = Reflect.apply,
  authorityOperationGet = WeakMap.prototype.get,
  authorityOperationSet = WeakMap.prototype.set;
/** Refuse all public authority/Db/context/proxy values before exposing original mutation ports. */
export function readOriginalCheckboxAuthorityOperationView(
  owner: object
): OriginalCheckboxAuthorityOperationView {
  const view = authorityOperationApply(authorityOperationGet, authorityOperationViews, [owner]) as
    OriginalCheckboxAuthorityOperationView | undefined;
  if (!view) throw new Error('Unknown original checkbox authority operation owner.');
  return view;
}

const reservationBindingBrand: unique symbol = Symbol('checkbox-reservation-binding');
export interface CheckboxReservationBinding {
  readonly [reservationBindingBrand]: true;
}
type CheckboxReservationWork<T> = (tx: DbTransaction) => T & SynchronousResult<T>;
interface ReservationBindingOperations {
  access: (documentId: string, actor: DocChannelActor, tx: DbTransaction) => undefined;
  run: <T>(work: CheckboxReservationWork<T>) => T;
  requireScope: (tx: DbTransaction) => void;
  requireExit: (owner: unknown, tx: DbTransaction) => void;
  current: (
    subject: CheckboxReservationSubject,
    snapshot: CheckboxAuthoritySnapshot,
    tx: DbTransaction
  ) => {
    approved: VerifiedCheckboxAuthority;
    currentTime: string;
    documentLabel: string;
    writeObservation: import('../grant-policy.js').DocOriginalWriteObservation;
  };
}
const authorityConstructors = new WeakMap<
  DocCheckboxAuthority,
  {
    db: import('@dorkos/db').Db;
    store: DocChannelStore;
    grants: import('../grants.js').DocChannelGrants;
    observeGrant: (id: string) => Promise<CheckboxSourceObservation>;
    manifestCloseFailure: () => Readonly<{ cause: unknown }> | undefined;
    requireGrantSource: (
      id: string,
      observation: CheckboxSourceObservation,
      tx: DbTransaction
    ) => void;
    bind: () => ReservationBindingOperations;
  }
>();
const reservationBindings = new WeakMap<CheckboxReservationBinding, ReservationBindingOperations>();

/** Bind only genuine constructor identities while inactive; no connection or checker is exposed. */
export function createCheckboxReservationBinding(
  authority: DocCheckboxAuthority,
  store: DocChannelStore
): CheckboxReservationBinding {
  const genuine = authorityConstructors.get(authority);
  if (!genuine || genuine.store !== store)
    throw new Error('Checkbox reservation authority/store mismatch.');
  const token = Object.freeze({ [reservationBindingBrand]: true as const });
  reservationBindings.set(token, genuine.bind());
  return token;
}
/** Execute through the genuine constructor-captured scoped runner, never a public method lookup. */
export function runCheckboxReservationTransaction<T>(
  binding: CheckboxReservationBinding,
  work: CheckboxReservationWork<T>
): T {
  const genuine = reservationBindings.get(binding);
  if (!genuine) throw new Error('Unknown checkbox reservation binding.');
  return genuine.run<T>(work);
}
/** Current private access precedes disclosure; the binding cannot supply its own checker. */
export function requireCheckboxReservationAccess(
  binding: CheckboxReservationBinding,
  documentId: string,
  actor: DocChannelActor,
  tx: DbTransaction
): undefined {
  const genuine = reservationBindings.get(binding);
  if (!genuine) throw new Error('Unknown checkbox reservation binding.');
  return genuine.access(documentId, actor, tx);
}
/** Fixed original-current gate, captured from private implementations at construction. */
export function requireCheckboxReservationSubject(
  binding: CheckboxReservationBinding,
  subject: CheckboxReservationSubject,
  snapshot: CheckboxAuthoritySnapshot,
  tx: DbTransaction
): {
  approved: VerifiedCheckboxAuthority;
  currentTime: string;
  documentLabel: string;
  writeObservation: import('../grant-policy.js').DocOriginalWriteObservation;
} {
  const genuine = reservationBindings.get(binding);
  if (!genuine) throw new Error('Unknown checkbox reservation binding.');
  return genuine.current(subject, snapshot, tx);
}
/** Fixed scope retirement needs the inaccessible A transaction owner, never the returned binding. */
export function requireCheckboxReservationExit(
  binding: CheckboxReservationBinding,
  owner: unknown,
  tx: DbTransaction
): void {
  const genuine = reservationBindings.get(binding);
  if (!genuine) throw new Error('Unknown checkbox reservation binding.');
  genuine.requireExit(owner, tx);
}
/** This exact binding must own the still-active caller scope. */
export function requireCheckboxReservationScope(
  binding: CheckboxReservationBinding,
  tx: DbTransaction
): void {
  const genuine = reservationBindings.get(binding);
  if (!genuine) throw new Error('Unknown checkbox reservation binding.');
  genuine.requireScope(tx);
}
const originalDocPrivateConstructionFreeze = Object.freeze;

/** Fresh-snapshot interface for parent-owned writer migration; old writer ports remain unchanged. */
export class DocCheckboxAuthority {
  readonly #operationKey = originalDocPrivateConstructionFreeze({});
  readonly #snapshots = new CheckboxSnapshotRegistry();
  readonly #reservationObservations = new WeakMap<
    DbTransaction,
    {
      approved: VerifiedCheckboxAuthority;
      observation: import('../grant-policy.js').DocOriginalWriteObservation;
    }
  >();
  readonly #entered = new AsyncLocalStorage<boolean>();
  #manifestCloseFailure: Readonly<{ cause: unknown }> | undefined;
  readonly #transactions: CheckboxAuthorityTransactions;
  #accessEntered = false;
  readonly #deps: Readonly<CheckboxAuthorityDependencies>;
  constructor(input: CheckboxAuthorityDependencies) {
    const deps = captureCheckboxDependencies(input);
    this.#deps = deps;
    this.#transactions = new CheckboxAuthorityTransactions(deps.db);
    requireDocChannelStoreDatabase(deps.store, deps.db);
    if (deps.db.$client.inTransaction)
      throw new Error('Checkbox authority construction requires an inactive database.');
    if (!deps.installationId || typeof deps.now !== 'function')
      throw new Error('Checkbox authority requires explicit installation and clock ports.');
    authorityConstructors.set(this, {
      db: deps.db,
      store: deps.store,
      grants: deps.grants,
      observeGrant: (id) => this.#operation(() => this.#observe(id)),
      manifestCloseFailure: () => this.#manifestCloseFailure,
      requireGrantSource: (id, observation, tx) =>
        requireOriginalCheckboxGrantDescriptor(this.#operationKey, id, observation, tx),
      bind: (): ReservationBindingOperations => {
        if (deps.db.$client.inTransaction)
          throw new Error('Checkbox reservation binding requires an inactive database.');
        return {
          run: <T>(work: CheckboxReservationWork<T>): T => this.#runTransaction<T>(work),
          access: (id, actor, tx) => this.#currentOperation(() => this.#access(id, actor, tx)),
          requireScope: (tx) => this.#transactions.require(tx),
          requireExit: (owner, tx) => {
            if (owner !== this.#transactions)
              throw new Error('Checkbox reservation scope exit is private.');
            this.#transactions.require(tx);
          },
          current: (subject, snapshot, tx) =>
            withCheckboxReadOnlyGate(deps.db, () => {
              const approved =
                subject.kind === 'live'
                  ? this.#requireCurrent(
                      subject.request,
                      subject.actor,
                      subject.approved,
                      snapshot,
                      tx
                    )
                  : this.#requireRecoveryCurrent(subject.intent, subject.approved, snapshot, tx);
              const currentTime = this.#transactions.takeCheckedTime(tx);
              const physical = readCheckboxPhysicalTitle(tx, approved.documentId);
              if (!physical || typeof physical.title !== 'string')
                throw new CheckboxAuthorityRefusal('DOCUMENT_CLOSED');
              const observed = this.#reservationObservations.get(tx);
              this.#reservationObservations.delete(tx);
              if (!observed || observed.approved !== approved)
                throw new CheckboxAuthorityRefusal('ORIGINAL_RESERVATION_OBSERVATION_ABSENT');
              return {
                approved,
                currentTime,
                documentLabel: physical.title,
                writeObservation: observed.observation,
              };
            }),
        };
      },
    });
    const createOriginalView = (
      owner: DocCheckboxAuthority
    ): Readonly<OriginalCheckboxAuthorityOperationView> =>
      originalDocPrivateConstructionFreeze<OriginalCheckboxAuthorityOperationView>({
        deps: this.#deps,
        snapshots: this.#snapshots,
        transactions: this.#transactions,
        reservationObservations: this.#reservationObservations,
        get transaction() {
          const operation = owner.transaction;
          return <T>(work: (tx: DbTransaction) => T & SynchronousResult<T>): T =>
            authorityOperationApply(operation, owner, [work]);
        },
        get refreshRecoveryCurrent() {
          const operation = owner.refreshRecoveryCurrent;
          return (intent: DocWriteIntentRow, approved: VerifiedCheckboxAuthority) =>
            authorityOperationApply(operation, owner, [intent, approved]);
        },
        get requireRecoveryCurrent() {
          const operation = owner.requireRecoveryCurrent;
          return (
            intent: DocWriteIntentRow,
            approved: VerifiedCheckboxAuthority,
            snapshot: CheckboxAuthoritySnapshot,
            tx: DbTransaction
          ) => authorityOperationApply(operation, owner, [intent, approved, snapshot, tx]);
        },
        operation: <T>(run: () => Promise<T>) => this.#operation(run),
        currentOperation: <T>(run: () => T) => this.#currentOperation(run),
        access: (id: string, actor: DocChannelActor, tx: DbTransaction) =>
          this.#access(id, actor, tx),
        checked: (
          id: string,
          grantId: string,
          revision: number,
          observation: CheckboxSourceObservation,
          tx: DbTransaction,
          actor?: DocChannelActor
        ) => this.#checked(id, grantId, revision, observation, tx, actor),
        editor: (
          id: string,
          actor: DocChannelActor | undefined,
          tx: DbTransaction,
          options?: { grantId?: string; time?: number }
        ) => this.#editor(id, actor, tx, options),
        now: () => this.#now(),
        outside: () => this.#outside(),
        observe: (id: string) => this.#observe(id),
      });
    authorityOperationApply(authorityOperationSet, authorityOperationViews, [
      this.#operationKey,
      createOriginalView(this),
    ]);
  }
  /** Open one authoritative caller transaction; foreign, nested and escaped handles gain no authority. */
  transaction<T>(work: (tx: DbTransaction) => T & SynchronousResult<T>): T {
    return this.#runTransaction<T>(work);
  }
  #runTransaction<T>(work: (tx: DbTransaction) => T & SynchronousResult<T>): T {
    return this.#transactions.run<T>((tx) => {
      try {
        const result = work(tx);
        checkboxAuthoritySync(result);
        auditCheckboxReservationScope(tx, this.#transactions);
        return result;
      } finally {
        retireCheckboxReservationScope(tx, this.#transactions);
      }
    });
  }
  /** Conservatively classify checked reductions; unknown IO/storage/recovery causes remain uncertainty. */
  isAuthorityRefusal(error: unknown): boolean {
    return isCheckboxAuthorityRefusal(error);
  }
  /** Verify live principal, including its asynchronous runtime binding, before disclosure. */
  async preflight(documentId: string, actor: DocChannelActor): Promise<void> {
    await this.#operation(async () => {
      const bound = { ...actor };
      this.#outside();
      this.transaction((tx) => this.#access(documentId, bound, tx));
      await this.#deps.authorization.require(documentId, bound, true);
      requireSameCheckboxActor(actor, bound);
      this.transaction((tx) => this.#access(documentId, actor, tx));
    });
  }
  /** Current real caller gate; never mint a recovery actor or expose a retained receipt alone. */
  requireAccess(documentId: string, actor: DocChannelActor, tx: DbTransaction): undefined {
    this.#transactions.require(tx);
    return this.#currentOperation(() => this.#access(documentId, actor, tx));
  }
  #access(documentId: string, actor: DocChannelActor, tx: DbTransaction): undefined {
    this.#transactions.require(tx);
    if (this.#accessEntered) throw new Error('Checkbox authority cannot reenter its access gate.');
    this.#accessEntered = true;
    try {
      return withCheckboxReadOnlyGate(this.#deps.db, () => this.#accessRows(documentId, actor, tx));
    } finally {
      this.#accessEntered = false;
    }
  }
  #accessRows(documentId: string, actor: DocChannelActor, tx: DbTransaction): undefined {
    return accessOriginalCheckboxRows(this.#operationKey, documentId, actor, tx);
  }
  /** Select exactly one actual eligible original consumed operator approval. */
  async prepare(
    request: CheckboxRequest,
    actor: DocChannelActor
  ): Promise<VerifiedCheckboxAuthority> {
    return prepareOriginalCheckboxAuthority(this.#operationKey, request, actor);
  }
  /** Recovery retains the original immutable evidence and original owner; it never chooses a new grant. */
  async prepareRecovery(intent: DocWriteIntentRow): Promise<VerifiedCheckboxAuthority> {
    return prepareOriginalCheckboxRecovery(this.#operationKey, intent);
  }
  /** Last awaited source/root/manifest observation, explicitly supplied to one later SQL boundary. */
  async refreshCurrent(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority
  ): Promise<CheckboxAuthoritySnapshot> {
    return refreshOriginalCheckboxAuthority(this.#operationKey, request, actor, approved);
  }
  /** Fresh observation for the recorded original intent; no synthetic live principal. */
  async refreshRecoveryCurrent(
    intent: DocWriteIntentRow,
    approved: VerifiedCheckboxAuthority
  ): Promise<CheckboxAuthoritySnapshot> {
    return refreshOriginalCheckboxRecovery(this.#operationKey, intent, approved);
  }
  /** Consume once and repeat current SQL rows/approval/editor policies; zero filesystem operations. */
  requireCurrent(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority,
    snapshot: CheckboxAuthoritySnapshot,
    tx: DbTransaction
  ): VerifiedCheckboxAuthority {
    return this.#requireCurrent(request, actor, approved, snapshot, tx);
  }
  #requireCurrent(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority,
    snapshot: CheckboxAuthoritySnapshot,
    tx: DbTransaction
  ): VerifiedCheckboxAuthority {
    return requireOriginalCheckboxAuthorityCurrent(
      this.#operationKey,
      request,
      actor,
      approved,
      snapshot,
      tx
    );
  }
  /** Original owner/current rows gate in the host's completion transaction. */
  requireRecoveryCurrent(
    intent: DocWriteIntentRow,
    approved: VerifiedCheckboxAuthority,
    snapshot: CheckboxAuthoritySnapshot,
    tx: DbTransaction
  ): VerifiedCheckboxAuthority {
    return this.#requireRecoveryCurrent(intent, approved, snapshot, tx);
  }
  #requireRecoveryCurrent(
    intent: DocWriteIntentRow,
    approved: VerifiedCheckboxAuthority,
    snapshot: CheckboxAuthoritySnapshot,
    tx: DbTransaction
  ): VerifiedCheckboxAuthority {
    return requireOriginalCheckboxRecoveryCurrent(
      this.#operationKey,
      intent,
      approved,
      snapshot,
      tx
    );
  }
  #currentOperation<T>(run: () => T): T {
    if (this.#entered.getStore())
      throw new Error('Checkbox authority cannot reenter its current gate.');
    return this.#entered.run(true, () => withCheckboxReadOnlyGate(this.#deps.db, run));
  }
  #checked(
    documentId: string,
    grantId: string,
    revision: number,
    observation: CheckboxSourceObservation,
    tx: DbTransaction,
    actor?: DocChannelActor
  ): VerifiedCheckboxAuthority {
    return checkOriginalCheckboxRows(
      this.#operationKey,
      documentId,
      grantId,
      revision,
      observation,
      tx,
      actor
    );
  }
  #editor(
    documentId: string,
    actor: DocChannelActor | undefined,
    tx: DbTransaction,
    options: { grantId?: string; time?: number } = {}
  ): void {
    return requireOriginalCheckboxEditor(this.#operationKey, documentId, actor, tx, options);
  }
  #now(): Date {
    return new Date(checkboxAuthorityClock(() => this.#deps.now()));
  }
  #outside(): undefined {
    if (this.#deps.db.$client.inTransaction)
      throw new Error('Checkbox filesystem observation requires an outside-SQL boundary.');
    return undefined;
  }
  async #observe(documentId: string): Promise<CheckboxSourceObservation> {
    if (this.#manifestCloseFailure) throw this.#manifestCloseFailure.cause;
    const boundary = () => this.#outside();
    try {
      return await observeCheckboxSource(
        () => readDocSourceDescriptor(this.#deps, documentId),
        boundary
      );
    } finally {
      const failure = readOriginalCheckboxManifestCloseFailure(boundary);
      if (failure && !this.#manifestCloseFailure) this.#manifestCloseFailure = failure;
    }
  }
  #operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.#entered.getStore())
      throw new Error('Checkbox authority cannot reenter its own observation.');
    return this.#entered.run(true, run);
  }
}
export { checkboxDocumentGeneration } from './authority/authority-snapshot.js';

/** Fixed observation uses the original constructor's own dependency set, never a caller source reader. */
export function observeOriginalCheckboxGrantSource(
  authority: DocCheckboxAuthority,
  db: import('@dorkos/db').Db,
  store: DocChannelStore,
  grants: import('../grants.js').DocChannelGrants,
  id: string
): Promise<CheckboxSourceObservation> {
  const own = authorityConstructors.get(authority);
  if (!own || own.db !== db || own.store !== store || own.grants !== grants)
    throw new Error('Foreign original checkbox grant source.');
  return own.observeGrant(id);
}
/** Require the original checkbox grant source retained by its owning assembly. */
export function requireOriginalCheckboxGrantSource(
  authority: DocCheckboxAuthority,
  db: import('@dorkos/db').Db,
  store: DocChannelStore,
  grants: import('../grants.js').DocChannelGrants,
  id: string,
  observation: CheckboxSourceObservation,
  tx: DbTransaction
): void {
  const own = authorityConstructors.get(authority);
  if (!own || own.db !== db || own.store !== store || own.grants !== grants)
    throw new Error('Foreign original checkbox grant source.');
  own.requireGrantSource(id, observation, tx);
}

/** Same original owner close failure DATA; no public method or permission is trusted. */
export function readOriginalCheckboxAuthorityCloseFailure(
  authority: DocCheckboxAuthority,
  db: import('@dorkos/db').Db,
  store: DocChannelStore
): Readonly<{ cause: unknown }> | undefined {
  const own = authorityConstructors.get(authority);
  if (!own || own.db !== db || own.store !== store)
    throw new Error('Foreign original checkbox authority close owner.');
  return own.manifestCloseFailure();
}
