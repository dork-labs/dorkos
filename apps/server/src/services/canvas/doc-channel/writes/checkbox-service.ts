/** Durable physical checkbox effects through genuine current authority and fixed completion. */
import { ZodError } from 'zod';
import { open, rename } from 'node:fs/promises';
import { type Db, type DbTransaction } from '@dorkos/db';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelActor } from '../authorization.js';
import {
  DocChannelStore,
  DocChannelCorruptionError,
  requireDocChannelStoreDatabase,
  type DocWriteIntentRow,
} from '../store.js';
import { findCheckboxIntent, quarantineCheckboxIntent } from './write-recovery.js';
import {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentityChangedError,
  type CanonicalWriteLease,
  requireOriginalCanonicalWriteLease,
  withRecognizedCanonicalFiles,
} from './canonical-writer.js';
import {
  assertCheckboxReplacement,
  cleanCheckboxTemporary,
  readCheckboxSource,
  readOriginalCheckboxFileCloseFailure,
  verifyCheckboxTemporary,
} from './checkbox-file.js';
import { prepareCheckboxBytes, rawByteHash } from './checkbox-bytes.js';
import {
  CheckboxWriteFence,
  CheckboxFenceUnavailableError,
  hasRecognizedCheckboxUnresolved,
  assertRecognizedCheckboxAdmission,
  assertRecognizedCheckboxOwnedAdmission,
  assertRecognizedCheckboxRecoveryRead,
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
  UNRESOLVED_CHECKBOX_STATUSES,
  VerifiedCheckboxAuthoritySchema,
  CheckboxEvidenceError,
  validateCheckboxEvidence,
  freezeCheckboxData,
  requireSameCheckboxAuthority,
  preEffectCheckboxConflict,
  observedCheckboxIntent,
  sync,
  type CheckboxRequest,
  type CheckboxReceipt,
  type VerifiedCheckboxAuthority,
  type CheckboxServiceOptions,
} from './checkbox-evidence.js';
export {
  VerifiedCheckboxAuthoritySchema,
  type CheckboxRequest,
  type CheckboxReceipt,
  type VerifiedCheckboxAuthority,
  type CheckboxServiceOptions,
} from './checkbox-evidence.js';
export { UNRESOLVED_CHECKBOX_STATUSES } from './checkbox-evidence.js';

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
    this.#boundary();
    await this.#authority.preflight(request.documentId, actor);
    this.#boundary();
    const digest = rawByteHash(Buffer.from(JSON.stringify(request)));
    const previous = this.#find(request.documentId, request.eventId);
    if (previous) return this.#duplicate(previous, digest, actor);
    const approved = freezeCheckboxData(
      VerifiedCheckboxAuthoritySchema.parse(await this.#authority.prepare(request, actor))
    );
    this.#boundary();
    let entered = false;
    return withRecognizedCanonicalFiles(
      this.#coordinator,
      [approved.binding.canonicalPath],
      async (identities, lease) => {
        entered = true;
        this.#boundary();
        const existing = this.#find(request.documentId, request.eventId);
        if (existing) return this.#duplicate(existing, digest, actor);
        const granted = identities[0]!;
        if (granted.canonicalPath !== approved.binding.canonicalPath)
          throw new CheckboxEvidenceError('Checkbox source changed.');
        const assertUnfenced = () => {
          this.#boundary();
          assertRecognizedCheckboxAdmission(this.#writeFence, this.#db, this.#store, granted);
        };
        const file = await this.#readSource(approved, assertUnfenced);
        if (file.device !== granted.device || file.inode !== granted.inode)
          throw new CheckboxEvidenceError('Checkbox granted source identity changed.');
        let edit: ReturnType<typeof prepareCheckboxBytes> | undefined;
        try {
          edit = prepareCheckboxBytes(file.bytes, request);
        } catch {
          /* A parser/version refusal has no physical effect. */
        }
        const observed = observedCheckboxIntent(
          request,
          approved,
          digest,
          this.#time(),
          rawByteHash(file.bytes),
          { device: file.device, inode: file.inode },
          edit
        );
        const freshSnapshot = await this.#authority.refreshCurrent(request, actor, approved);
        const checked = await this.#readSource(approved, assertUnfenced);
        if (
          checked.device !== file.device ||
          checked.inode !== file.inode ||
          checked.rootIdentity !== file.rootIdentity ||
          rawByteHash(checked.bytes) !== rawByteHash(file.bytes)
        )
          throw new CheckboxEvidenceError('Checkbox observed source changed.');
        const subject = this.#live(request, actor, approved);
        const terminal = this.#authority.transaction((tx) => {
          const raced = this.#find(request.documentId, request.eventId, tx);
          if (raced) return this.#duplicate(raced, digest, actor, tx);
          const input = { candidate: observed.intent, liveSubject: subject, freshSnapshot };
          if (observed.receipt?.status === 'no_op')
            return this.#completion.insertNoOpInTransaction(input, tx);
          if (observed.receipt?.status === 'conflict')
            return this.#completion.insertConflictInTransaction(input, tx);
          this.#completion.insertPreparedInTransaction(input, tx);
          return undefined;
        });
        if (terminal) return terminal;
        let current = this.#store.getWriteIntent(observed.intent.intentId)!;
        const assertOwned = () => {
          this.#boundary();
          assertRecognizedCheckboxOwnedAdmission(
            this.#writeFence,
            this.#db,
            this.#store,
            granted,
            current
          );
        };
        let temp: string | undefined, ownedTemp: { device: string; inode: string } | undefined;
        try {
          await this.#checkpoint('prepared', current);
          assertOwned();
          const candidate = this.#validate(current).tempPath!;
          const handle = await open(candidate, 'wx', file.mode & 0o777);
          temp = candidate;
          // Join this scope to its captured cleanup before returning or reporting failure.
          const drainOriginalCleanup = async () => {
            try {
              await handle.close();
            } catch (cause) {
              this.#retainCloseFailure(cause);
              throw cause;
            }
          };
          try {
            assertOwned();
            const temporary = await handle.stat({ bigint: true });
            ownedTemp = { device: String(temporary.dev), inode: String(temporary.ino) };
            const stagedSnapshot = await this.#authority.refreshCurrent(request, actor, approved);
            assertOwned();
            current = this.#authority.transaction((tx) =>
              this.#completion.stageInTransaction(
                {
                  expected: current,
                  subject,
                  freshSnapshot: stagedSnapshot,
                  replacement: ownedTemp!,
                },
                tx
              )
            );
            await handle.writeFile(edit!.after);
            assertOwned();
            await handle.chmod(file.mode & 0o777);
            assertOwned();
            await handle.sync();
          } finally {
            await drainOriginalCleanup();
          }
          await this.#checkpoint('staged', current);
          const adopted = await lease.reserveReplacement(temp);
          assertOwned();
          const expectedTemp = this.#validate(current).tempIdentity!;
          if (
            adopted.canonicalPath !== temp ||
            adopted.device !== expectedTemp.device ||
            adopted.inode !== expectedTemp.inode
          )
            throw new CheckboxEvidenceError('Checkbox replacement identity changed.');
          // Authority observation precedes the final real source and owned-temp byte/path proofs.
          const renameSnapshot = await this.#authority.refreshCurrent(request, actor, approved);
          const final = await this.#readSource(approved, assertOwned);
          if (
            final.device !== file.device ||
            final.inode !== file.inode ||
            final.rootIdentity !== file.rootIdentity ||
            rawByteHash(final.bytes) !== current.beforeHash
          )
            throw new CheckboxEvidenceError('Checkbox source changed before replacement.');
          try {
            await verifyCheckboxTemporary(current, assertOwned);
          } finally {
            const failure = readOriginalCheckboxFileCloseFailure(assertOwned);
            if (failure) this.#retainCloseFailure(failure.cause);
          }
          assertOwned();
          this.#completion.requireEffect({
            expected: current,
            subject,
            freshSnapshot: renameSnapshot,
          });
          await rename(temp, current.canonicalPath);
          temp = undefined;
          await this.#checkpoint('replaced', current);
          const written = await this.#readSource(approved, assertOwned);
          assertCheckboxReplacement(current, written);
          const replacedSnapshot = await this.#authority.refreshCurrent(request, actor, approved);
          const rechecked = await this.#readSource(approved, assertOwned);
          assertCheckboxReplacement(current, rechecked);
          assertOwned();
          current = this.#authority.transaction((tx) =>
            this.#completion.replaceInTransaction(
              { expected: current, subject, freshSnapshot: replacedSnapshot },
              tx
            )
          );
          await this.#checkpoint('verified', current);
          return await this.#complete(current, subject, assertOwned, lease);
        } catch (error) {
          // Lost current authority never manufactures a no-effect conflict or frees the reservation.
          if (this.#authorityRefused(error) || error instanceof CheckboxEvidenceError)
            this.#quarantine(current, 'write_unverified');
          throw error;
        } finally {
          if (temp)
            await cleanCheckboxTemporary(
              {
                ...current,
                evidence: {
                  ...this.#validate(current),
                  tempIdentity: ownedTemp ?? this.#validate(current).tempIdentity,
                },
              },
              () => {
                if (this.#db.$client.inTransaction) throw new Error('FS inside SQL');
              }
            ).catch(() => {
              /* Unknown/unowned cleanup remains fenced; never unlink a substituted inode. */
            });
        }
      }
    ).catch(async (error: unknown) => {
      if (entered || !(error instanceof CanonicalFileIdentityChangedError)) throw error;
      this.#boundary();
      return this.#preEffectConflict(request, actor, approved, digest);
    });
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
    return this.#track(async () => {
      this.#boundary();
      const row = freezeCheckboxData(this.#store.getWriteIntent(id));
      if (!row) throw new Error('Checkbox intent is absent.');
      this.#validate(row);
      if (
        !UNRESOLVED_CHECKBOX_STATUSES.includes(
          row.status as (typeof UNRESOLVED_CHECKBOX_STATUSES)[number]
        ) ||
        row.status === 'in_doubt'
      )
        return this.#receipt(row);
      const approved = this.#validate(row).authority;
      try {
        const prepared = await this.#authority.prepareRecovery(row);
        requireSameCheckboxAuthority(approved, prepared);
        this.#boundary();
        return await withRecognizedCanonicalFiles<CheckboxReceipt>(
          this.#coordinator,
          [row.canonicalPath],
          async (identities, lease) => {
            this.#boundary();
            let current = this.#store.getWriteIntent(id)!;
            this.#validate(current);
            if (current.status === 'committed') return this.#receipt(current);
            if (JSON.stringify(current) !== JSON.stringify(row))
              throw new CheckboxEvidenceError('Checkbox recovery raced.');
            const assertFs = () => {
              this.#boundary();
              assertRecognizedCheckboxRecoveryRead(
                this.#writeFence,
                this.#db,
                this.#store,
                identities[0]!,
                current
              );
            };
            const snapshot = await this.#authority.refreshRecoveryCurrent(current, approved);
            const file = await this.#readSource(approved, assertFs);
            if (file.device !== identities[0]!.device || file.inode !== identities[0]!.inode)
              throw new CheckboxEvidenceError('Checkbox recovery source identity changed.');
            this.#authority.transaction((tx) =>
              this.#authority.requireRecoveryCurrent(current, approved, snapshot, tx)
            );
            await cleanCheckboxTemporary(current, assertFs);
            assertFs();
            const checked = await this.#readSource(approved, assertFs);
            const hash = rawByteHash(checked.bytes);
            if (hash === current.beforeHash) return this.#receipt(current);
            if (hash !== current.afterHash || current.beforeHash === current.afterHash) {
              this.#quarantine(current, 'unknown_file_state');
              return this.#receipt(this.#store.getWriteIntent(id) ?? current);
            }
            const evidence = this.#validate(current),
              before = Buffer.from(checked.bytes);
            before[evidence.markerOffset!] = evidence.beforeMarker!;
            assertCheckboxReplacement(current, checked);
            let edit: ReturnType<typeof prepareCheckboxBytes>;
            try {
              edit = prepareCheckboxBytes(
                before,
                CanvasChannelCheckboxRequestSchema.parse(current.input)
              );
            } catch (cause) {
              throw new CheckboxEvidenceError('Checkbox reconstructed source differs.', { cause });
            }
            if (edit.markerOffset !== evidence.markerOffset || !edit.after.equals(checked.bytes))
              throw new CheckboxEvidenceError('Checkbox reconstructed source differs.');
            if (current.status === 'prepared') {
              const replacedSnapshot = await this.#authority.refreshRecoveryCurrent(
                current,
                approved
              );
              const verified = await this.#readSource(approved, assertFs);
              assertCheckboxReplacement(current, verified);
              assertFs();
              current = this.#authority.transaction((tx) =>
                this.#completion.replaceInTransaction(
                  {
                    expected: current,
                    subject: { kind: 'recovery', intent: current, approved },
                    freshSnapshot: replacedSnapshot,
                  },
                  tx
                )
              );
            }
            // Changed-row recovery obtains a NEW full-row snapshot, never the prepared token.
            return this.#complete(
              current,
              { kind: 'recovery', intent: current, approved },
              assertFs,
              lease
            );
          }
        );
      } catch (error) {
        if (
          error instanceof CheckboxEvidenceError ||
          error instanceof ZodError ||
          error instanceof DocChannelCorruptionError ||
          this.#authorityRefused(error)
        )
          this.#quarantine(row, 'recovery_authority_unavailable');
        throw error;
      }
    });
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
