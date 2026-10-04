/** Original operator-approved checkbox authority; filesystem observations precede pure SQL gates. */
import {
  captureCheckboxDependencies,
  isCheckboxAuthorityRefusal,
  requireCheckboxEditor,
  readCheckboxCurrentRows,
  readCheckboxPhysicalId,
  readCheckboxPhysicalTitle,
  type CheckboxAuthorityDependencies,
  type CheckboxReservationSubject,
} from './authority-policy.js';
export type {
  CheckboxAuthorityDependencies,
  CheckboxReservationSubject,
} from './authority-policy.js';
import {
  auditCheckboxReservationScope,
  retireCheckboxReservationScope,
} from './reservation-bridge.js';
import { requireDocChannelStoreDatabase } from '../store.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, isNull, eq, canvasDocGrants, type DbTransaction } from '@dorkos/db';
import {
  CanvasChannelCheckboxRequestSchema,
  matchesCanvasChannelEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import type { DocChannelActor } from '../authorization.js';
import {
  readDocSourceDescriptor,
  sameDocOwnerAuthority,
  docInstallationOwner,
} from '../doc-source-policy.js';
import type { DocChannelStore, DocWriteIntentRow } from '../store.js';
import type { SynchronousResult } from '../store-transaction.js';
import {
  VerifiedCheckboxAuthoritySchema,
  requireSameCheckboxAuthority,
  validateCheckboxEvidence,
  type CheckboxRequest,
  type VerifiedCheckboxAuthority,
} from './checkbox-evidence.js';
import {
  CheckboxAuthorityRefusal,
  CheckboxAuthorityTransactions,
  requireSameCheckboxActor,
  CheckboxSnapshotRegistry,
  checkboxAuthoritySync,
  checkboxAuthorityClock,
  withCheckboxReadOnlyGate,
  observeCheckboxSource,
  type CheckboxAuthoritySnapshot,
  type CheckboxSourceObservation,
} from './authority-snapshot.js';

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
  ) => { approved: VerifiedCheckboxAuthority; currentTime: string; documentLabel: string };
}
const authorityConstructors = new WeakMap<
  DocCheckboxAuthority,
  { store: DocChannelStore; bind: () => ReservationBindingOperations }
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
): { approved: VerifiedCheckboxAuthority; currentTime: string; documentLabel: string } {
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
/** Fresh-snapshot interface for parent-owned writer migration; old writer ports remain unchanged. */
export class DocCheckboxAuthority {
  readonly #snapshots = new CheckboxSnapshotRegistry();
  readonly #entered = new AsyncLocalStorage<boolean>();
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
      store: deps.store,
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
              return { approved, currentTime, documentLabel: physical.title };
            }),
        };
      },
    });
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
    const time = this.#now().getTime();
    if (
      !sameDocOwnerAuthority(
        actor.principal.claims.owner,
        docInstallationOwner(this.#deps.installationId)
      )
    )
      throw new CheckboxAuthorityRefusal('ORIGINAL_OWNER_CHANGED');
    const physical = readCheckboxPhysicalId(tx, documentId);
    const channel = this.#deps.store.getChannel(documentId, tx);
    if (!physical || !channel || channel.closedAt !== null)
      throw new CheckboxAuthorityRefusal('DOCUMENT_CLOSED');
    checkboxAuthoritySync(this.#deps.authorization.requireCurrent(documentId, actor, true, tx));
    this.#editor(documentId, actor, tx, { time });
    return undefined;
  }
  /** Select exactly one actual eligible original consumed operator approval. */
  async prepare(
    request: CheckboxRequest,
    actor: DocChannelActor
  ): Promise<VerifiedCheckboxAuthority> {
    return this.#operation(async () => {
      const parsed = CanvasChannelCheckboxRequestSchema.parse(request);
      const bound = { ...actor };
      this.#outside();
      this.transaction((tx) => this.#access(parsed.documentId, bound, tx));
      await this.#deps.authorization.require(parsed.documentId, bound, true);
      const observation = await this.#observe(parsed.documentId);
      requireSameCheckboxActor(actor, bound);
      return this.transaction((tx) =>
        withCheckboxReadOnlyGate(this.#deps.db, () => {
          this.#access(parsed.documentId, actor, tx);
          const time = this.#now().getTime();
          const candidates = tx
            .select()
            .from(canvasDocGrants)
            .where(
              and(
                eq(canvasDocGrants.documentId, parsed.documentId),
                isNull(canvasDocGrants.revokedAt)
              )
            )
            .all()
            .filter(
              (grant) =>
                (grant.writeOperation as { operation?: unknown } | null)?.operation ===
                  'checkbox-toggle' &&
                grant.allowedTypes.some((type) =>
                  matchesCanvasChannelEvent(type, 'md.task.toggled')
                ) &&
                Date.parse(grant.expiresAt ?? '') > time
            );
          if (candidates.length !== 1)
            throw new CheckboxAuthorityRefusal('ORIGINAL_WRITE_GRANT_AMBIGUOUS');
          const original = candidates[0]!;
          return this.#checked(
            parsed.documentId,
            original.grantId,
            original.revision,
            observation,
            tx,
            actor
          );
        })
      );
    });
  }
  /** Recovery retains the original immutable evidence and original owner; it never chooses a new grant. */
  async prepareRecovery(intent: DocWriteIntentRow): Promise<VerifiedCheckboxAuthority> {
    const approved = validateCheckboxEvidence(intent).authority;
    const snapshot = await this.refreshRecoveryCurrent(intent, approved);
    return this.transaction((tx) => this.requireRecoveryCurrent(intent, approved, snapshot, tx));
  }
  /** Last awaited source/root/manifest observation, explicitly supplied to one later SQL boundary. */
  async refreshCurrent(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority
  ): Promise<CheckboxAuthoritySnapshot> {
    return this.#operation(async () => {
      const parsed = CanvasChannelCheckboxRequestSchema.parse(request);
      const original = VerifiedCheckboxAuthoritySchema.parse(approved);
      const bound = { ...actor };
      this.#outside();
      this.transaction((tx) => this.#access(parsed.documentId, bound, tx));
      await this.#deps.authorization.require(parsed.documentId, bound, true);
      const observation = await this.#observe(parsed.documentId);
      requireSameCheckboxActor(actor, bound);
      this.transaction((tx) => {
        this.#access(parsed.documentId, actor, tx);
        requireSameCheckboxAuthority(
          original,
          this.#checked(
            parsed.documentId,
            original.grantId,
            original.grantRevision,
            observation,
            tx,
            actor
          )
        );
      });
      return this.#snapshots.issue({
        subject: hashApprovalInput(parsed),
        approved: original,
        actor: actor.principal,
        surface: actor.surface,
        observation,
      });
    });
  }
  /** Fresh observation for the recorded original intent; no synthetic live principal. */
  async refreshRecoveryCurrent(
    intent: DocWriteIntentRow,
    approved: VerifiedCheckboxAuthority
  ): Promise<CheckboxAuthoritySnapshot> {
    return this.#operation(async () => {
      const evidence = validateCheckboxEvidence(intent);
      requireSameCheckboxAuthority(
        evidence.authority,
        VerifiedCheckboxAuthoritySchema.parse(approved)
      );
      this.#outside();
      const observation = await this.#observe(intent.documentId);
      this.transaction((tx) =>
        withCheckboxReadOnlyGate(this.#deps.db, () => {
          this.#editor(intent.documentId, undefined, tx, { grantId: approved.grantId });
          requireSameCheckboxAuthority(
            approved,
            this.#checked(
              intent.documentId,
              approved.grantId,
              approved.grantRevision,
              observation,
              tx
            )
          );
        })
      );
      return this.#snapshots.issue({
        subject: hashApprovalInput(intent),
        approved: VerifiedCheckboxAuthoritySchema.parse(approved),
        observation,
      });
    });
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
    this.#transactions.require(tx);
    return this.#currentOperation(() => {
      const data = this.#snapshots.consume(snapshot);
      if (
        data.subject !== hashApprovalInput(CanvasChannelCheckboxRequestSchema.parse(request)) ||
        data.actor !== actor.principal ||
        data.surface !== actor.surface
      )
        throw new CheckboxAuthorityRefusal('SNAPSHOT_SUBJECT_CHANGED');
      requireSameCheckboxAuthority(data.approved, VerifiedCheckboxAuthoritySchema.parse(approved));
      this.#access(request.documentId, actor, tx);
      const result = this.#checked(
        request.documentId,
        approved.grantId,
        approved.grantRevision,
        data.observation,
        tx,
        actor
      );
      requireSameCheckboxAuthority(data.approved, result);
      return result;
    });
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
    this.#transactions.require(tx);
    return this.#currentOperation(() => {
      const data = this.#snapshots.consume(snapshot);
      if (data.actor || data.subject !== hashApprovalInput(intent))
        throw new CheckboxAuthorityRefusal('SNAPSHOT_SUBJECT_CHANGED');
      requireSameCheckboxAuthority(validateCheckboxEvidence(intent).authority, approved);
      requireSameCheckboxAuthority(data.approved, approved);
      this.#editor(intent.documentId, undefined, tx, { grantId: approved.grantId });
      const result = this.#checked(
        intent.documentId,
        approved.grantId,
        approved.grantRevision,
        data.observation,
        tx
      );
      requireSameCheckboxAuthority(data.approved, result);
      return result;
    });
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
    return withCheckboxReadOnlyGate(this.#deps.db, () => {
      const time = this.#now().getTime();
      this.#transactions.captureCheckedTime(tx, new Date(time).toISOString());
      return readCheckboxCurrentRows(
        this.#deps,
        documentId,
        grantId,
        revision,
        observation,
        tx,
        actor,
        time
      );
    });
  }
  #editor(
    documentId: string,
    actor: DocChannelActor | undefined,
    tx: DbTransaction,
    options: { grantId?: string; time?: number } = {}
  ): void {
    const time = options.time ?? this.#now().getTime();
    requireCheckboxEditor(this.#deps, documentId, actor, tx, { grantId: options.grantId, time });
  }
  #now(): Date {
    return new Date(checkboxAuthorityClock(() => this.#deps.now()));
  }
  #outside(): undefined {
    if (this.#deps.db.$client.inTransaction)
      throw new Error('Checkbox filesystem observation requires an outside-SQL boundary.');
    return undefined;
  }
  #observe(documentId: string): Promise<CheckboxSourceObservation> {
    return observeCheckboxSource(
      () => readDocSourceDescriptor(this.#deps, documentId),
      () => this.#outside()
    );
  }
  #operation<T>(run: () => Promise<T>): Promise<T> {
    if (this.#entered.getStore())
      throw new Error('Checkbox authority cannot reenter its own observation.');
    return this.#entered.run(true, run);
  }
}
export { checkboxDocumentGeneration } from './authority-snapshot.js';
