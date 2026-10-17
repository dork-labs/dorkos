/** Durable checkbox effects. Production authority and host completion are mandatory ports. */
import { ZodError } from 'zod';
import { open, rename } from 'node:fs/promises';
import { type Db, type DbTransaction } from '@dorkos/db';
import {
  CanvasChannelCheckboxRequestSchema,
  IngestReceiptSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelActor } from '../authorization.js';
import { DocChannelStore, DocChannelCorruptionError, type DocWriteIntentRow } from '../store.js';
import {
  findCheckboxIntent,
  markCheckboxConflict,
  quarantineCheckboxIntent,
} from './write-recovery.js';
import {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentityChangedError,
} from './canonical-writer.js';
import {
  assertCheckboxReplacement,
  cleanCheckboxTemporary,
  readCheckboxSource,
  verifyCheckboxTemporary,
} from './checkbox-file.js';
import { prepareCheckboxBytes, rawByteHash } from './checkbox-bytes.js';
import { CheckboxWriteFence } from './checkbox-fence.js';
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
  type CheckboxAuthorityPorts,
  type CheckboxCompletionPorts,
  type CheckboxServiceOptions,
} from './checkbox-evidence.js';
export {
  VerifiedCheckboxAuthoritySchema,
  type CheckboxRequest,
  type CheckboxReceipt,
  type VerifiedCheckboxAuthority,
  type CheckboxAuthorityPorts,
  type CheckboxCompletionPorts,
  type CheckboxServiceOptions,
} from './checkbox-evidence.js';

export { UNRESOLVED_CHECKBOX_STATUSES } from './checkbox-evidence.js';

/** No default authority, actor, event interpretation, or runtime launch is supplied. */
export class DocCheckboxWriteService {
  readonly writeFence: CheckboxWriteFence;
  private stopped = false;
  private readonly active = new Set<Promise<unknown>>();
  constructor(
    readonly db: Db,
    readonly store: DocChannelStore,
    private readonly coordinator: CanonicalFileWriteCoordinator,
    private readonly authority: CheckboxAuthorityPorts,
    private readonly completion: CheckboxCompletionPorts,
    private readonly options: CheckboxServiceOptions = {}
  ) {
    this.writeFence = new CheckboxWriteFence(db, store);
  }

  toggle(raw: unknown, actor: DocChannelActor): Promise<CheckboxReceipt> {
    return this.track(() =>
      this.toggleCurrent(freezeCheckboxData(CanvasChannelCheckboxRequestSchema.parse(raw)), actor)
    );
  }
  /** Host must await this before DB disposal; stopped work never completes a host event. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.active]);
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Checkbox writes are stopped.'));
    const promise = work();
    this.active.add(promise);
    void promise.then(
      () => this.active.delete(promise),
      () => this.active.delete(promise)
    );
    return promise;
  }
  /** Refuse new recovery reads after stop and all filesystem work inside SQL transactions. */
  assertAvailable(): void {
    this.boundary();
  }
  private boundary(): void {
    if (this.stopped || this.db.$client.inTransaction)
      throw new Error('Checkbox writes are not available.');
  }
  private time(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  find(documentId: string, eventId: string, tx?: DbTransaction): DocWriteIntentRow | undefined {
    return findCheckboxIntent(this.store, this.db, documentId, eventId, tx);
  }
  /** Conservative diagnostic only; mutation admission requires writeFence and current identity. */
  fenced(_path: string): boolean {
    return this.writeFence.conservativelyFenced();
  }
  private async toggleCurrent(
    request: CheckboxRequest,
    actor: DocChannelActor
  ): Promise<CheckboxReceipt> {
    this.boundary();
    await this.authority.preflight(request.documentId, actor);
    this.boundary();
    const digest = rawByteHash(Buffer.from(JSON.stringify(request)));
    const previous = this.find(request.documentId, request.eventId);
    if (previous) return this.duplicate(previous, digest, actor);
    const approved = freezeCheckboxData(
      VerifiedCheckboxAuthoritySchema.parse(await this.authority.prepare(request, actor))
    );
    this.boundary();
    if (approved.documentId !== request.documentId)
      throw new CheckboxEvidenceError('Checkbox document changed.');
    let entered = false;
    return this.coordinator
      .withFiles([approved.binding.canonicalPath], async (identities, lease) => {
        entered = true;
        this.boundary();
        if (identities[0]!.canonicalPath !== approved.binding.canonicalPath)
          throw new Error('Checkbox source changed.');
        const existing = this.find(request.documentId, request.eventId);
        if (existing) return this.duplicate(existing, digest, actor);
        const granted = identities[0]!;
        const assertUnfenced = () => {
          this.boundary();
          this.writeFence.assertAdmission(granted);
        };
        assertUnfenced();
        const file = await readCheckboxSource(approved, assertUnfenced);
        if (file.device !== granted.device || file.inode !== granted.inode)
          throw new CheckboxEvidenceError('Checkbox granted source identity changed.');
        this.boundary();
        let edit: ReturnType<typeof prepareCheckboxBytes> | undefined;
        try {
          edit = prepareCheckboxBytes(file.bytes, request);
        } catch {
          /* Verified no-effect conflict. */
        }
        const { receipt, intent } = observedCheckboxIntent(
          request,
          approved,
          digest,
          this.time(),
          rawByteHash(file.bytes),
          { device: file.device, inode: file.inode },
          edit
        );
        assertUnfenced();
        this.store.transaction((tx) => {
          this.checkCurrent(request, actor, approved, tx);
          this.store.insertWriteIntent(intent, tx);
        });
        if (receipt) return receipt;
        let current = this.store.getWriteIntent(intent.intentId)!;
        const assertOwned = () => {
          this.boundary();
          this.writeFence.assertOwnedIntentAdmission(granted, current);
        };
        let temp: string | undefined;
        let ownedTemp: { device: string; inode: string } | undefined;
        let effectAttempted = false;
        try {
          await this.checkpoint('prepared', current);
          assertOwned();
          const candidate = this.validate(current).tempPath!;
          const handle = await open(candidate, 'wx', file.mode & 0o777);
          temp = candidate;
          try {
            assertOwned();
            const temporary = await handle.stat({ bigint: true });
            ownedTemp = { device: String(temporary.dev), inode: String(temporary.ino) };
            assertOwned();
            const evidence = {
              ...this.validate(current),
              tempIdentity: { device: String(temporary.dev), inode: String(temporary.ino) },
            };
            this.store.transaction((tx) => {
              this.checkCurrent(request, actor, approved, tx);
              if (
                !this.store.transitionWriteIntent(
                  current.intentId,
                  'prepared',
                  { status: 'prepared', updatedAt: this.time(), evidence, errorCode: null },
                  tx
                )
              )
                throw new Error('Checkbox intent changed');
            });
            current = this.store.getWriteIntent(current.intentId)!;
            await handle.writeFile(edit!.after);
            assertOwned();
            await handle.chmod(file.mode & 0o777);
            assertOwned();
            await handle.sync();
          } finally {
            await handle.close();
          }
          await this.checkpoint('staged', current);
          assertOwned();
          const adopted = await lease.reserveReplacement(temp);
          assertOwned();
          const expectedTemp = this.validate(current).tempIdentity!;
          if (
            adopted.canonicalPath !== temp ||
            adopted.device !== expectedTemp.device ||
            adopted.inode !== expectedTemp.inode
          )
            throw new CheckboxEvidenceError('Checkbox replacement identity changed.');
          await verifyCheckboxTemporary(current, assertOwned);
          assertOwned();
          const final = await readCheckboxSource(approved, assertOwned);
          if (
            final.device !== file.device ||
            final.inode !== file.inode ||
            rawByteHash(final.bytes) !== current.beforeHash
          )
            throw new CheckboxEvidenceError('Checkbox source changed before replacement.');
          assertOwned();
          this.store.transaction((tx) => this.checkCurrent(request, actor, approved, tx));
          effectAttempted = true;
          await rename(temp, current.canonicalPath);
          temp = undefined;
          await this.checkpoint('replaced', current);
          assertOwned();
          const written = await readCheckboxSource(approved, assertOwned);
          assertCheckboxReplacement(current, written);
          assertOwned();
          this.store.transaction((tx) => {
            if (
              !this.store.transitionWriteIntent(
                current.intentId,
                'prepared',
                {
                  status: 'replaced',
                  updatedAt: this.time(),
                  errorCode: null,
                  evidence: current.evidence,
                },
                tx
              )
            )
              throw new Error('Checkbox intent changed.');
          });
          current = this.store.getWriteIntent(current.intentId)!;
          await this.checkpoint('verified', current);
          const verified = await readCheckboxSource(approved, assertOwned);
          assertCheckboxReplacement(current, verified);
          assertOwned();
          return this.complete(current, (tx) => this.checkCurrent(request, actor, approved, tx));
        } catch (error) {
          const refused = this.authorityRefused(error);
          if (!effectAttempted && (refused || error instanceof CheckboxEvidenceError)) {
            markCheckboxConflict(this.store, current, this.time(), refused);
          } else if (
            effectAttempted &&
            (current.status !== 'replaced' || refused || error instanceof CheckboxEvidenceError)
          )
            this.quarantine(current.intentId, 'write_unverified');
          throw error;
        } finally {
          if (temp)
            await cleanCheckboxTemporary(
              {
                ...current,
                evidence: {
                  ...this.validate(current),
                  tempIdentity: ownedTemp ?? this.validate(current).tempIdentity,
                },
              },
              () => {
                if (this.db.$client.inTransaction) throw new Error('FS inside SQL');
              }
            ).catch(() => {});
        }
      })
      .catch((error: unknown) => {
        if (entered || !(error instanceof CanonicalFileIdentityChangedError)) throw error;
        this.boundary();
        return this.preEffectConflict(request, actor, approved, digest);
      });
  }
  private preEffectConflict(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority,
    digest: string
  ): CheckboxReceipt {
    return this.store.transaction((tx) => {
      sync(this.authority.requireAccess(request.documentId, actor, tx));
      const existing = this.find(request.documentId, request.eventId, tx);
      if (existing) return this.duplicate(existing, digest, actor);
      this.checkCurrent(request, actor, approved, tx);
      const { receipt, intent } = preEffectCheckboxConflict(request, approved, digest, this.time());
      this.store.insertWriteIntent(intent, tx);
      return receipt;
    });
  }
  private duplicate(
    row: DocWriteIntentRow,
    digest: string,
    actor: DocChannelActor
  ): CheckboxReceipt {
    this.store.transaction((tx) => sync(this.authority.requireAccess(row.documentId, actor, tx)));
    const receipt = this.receipt(row);
    if (row.envelopeHash !== digest)
      return { status: 'conflict', eventId: row.eventId, action: 'reload' };
    return receipt;
  }
  receipt(row: DocWriteIntentRow): CheckboxReceipt {
    const evidence = this.validate(row);
    if (evidence.receipt) return evidence.receipt;
    return { status: 'in_doubt', eventId: row.eventId, action: 'review' };
  }
  validate(row: DocWriteIntentRow): ReturnType<typeof validateCheckboxEvidence> {
    return validateCheckboxEvidence(row);
  }
  private checkCurrent(
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority,
    tx: DbTransaction
  ): undefined {
    requireSameCheckboxAuthority(
      approved,
      sync(this.authority.requireCurrent(request, actor, approved, tx))
    );
    return undefined;
  }
  private complete(
    row: DocWriteIntentRow,
    gate: (tx: DbTransaction) => undefined
  ): CheckboxReceipt {
    const evidence = this.validate(row);
    const receipt = this.store.transaction((tx) => {
      gate(tx);
      const current = this.store.getWriteIntent(row.intentId, tx);
      if (!current || JSON.stringify(current) !== JSON.stringify(row))
        throw new Error('Checkbox intent changed.');
      const ingest = IngestReceiptSchema.parse(
        sync(this.completion.completeVerified(freezeCheckboxData(current), tx))
      );
      if (ingest.id !== row.eventId) throw new Error('Checkbox completion identity changed.');
      const receipt: CheckboxReceipt = {
        status: 'changed',
        receipt: ingest,
        fileVersion: row.afterHash,
      };
      if (
        !this.store.transitionWriteIntent(
          row.intentId,
          row.status,
          {
            status: 'committed',
            updatedAt: this.time(),
            errorCode: null,
            evidence: { ...evidence, receipt },
          },
          tx
        )
      )
        throw new Error('Checkbox completion raced.');
      return receipt;
    });
    try {
      sync(this.completion.notifyCommitted?.(row.documentId));
    } catch {
      /* Hints cannot undo commit. */
    }
    return receipt;
  }
  quarantine(id: string, reason: string): void {
    quarantineCheckboxIntent(this.store, id, reason, this.time());
  }
  /** Recovery verifies evidence only. It never writes a marker or creates a new input identity. */
  recover(id: string): Promise<CheckboxReceipt> {
    return this.track(async () => {
      this.boundary();
      let row: DocWriteIntentRow | undefined;
      try {
        row = freezeCheckboxData(this.store.getWriteIntent(id));
        if (!row) throw new Error('Checkbox intent is absent.');
        this.validate(row);
      } catch (error) {
        if (
          error instanceof CheckboxEvidenceError ||
          error instanceof ZodError ||
          error instanceof DocChannelCorruptionError
        )
          this.quarantine(id, 'corrupt_evidence');
        throw error;
      }
      if (
        !UNRESOLVED_CHECKBOX_STATUSES.includes(
          row.status as (typeof UNRESOLVED_CHECKBOX_STATUSES)[number]
        )
      )
        return this.receipt(row);
      if (row.status === 'in_doubt') return this.receipt(row);
      const expected = this.validate(row).authority;
      let current: VerifiedCheckboxAuthority;
      try {
        current = VerifiedCheckboxAuthoritySchema.parse(
          await this.authority.prepareRecovery(freezeCheckboxData(row))
        );
        this.boundary();
        requireSameCheckboxAuthority(expected, current);
      } catch (error) {
        if (error instanceof CheckboxEvidenceError || this.authorityRefused(error))
          this.quarantine(id, 'recovery_authority_refused');
        throw error;
      }
      return this.coordinator
        .withFiles<CheckboxReceipt>([row.canonicalPath], async (identities) => {
          this.boundary();
          const fresh = this.store.getWriteIntent(id)!;
          this.validate(fresh);
          if (fresh.status === 'committed') return this.receipt(fresh);
          if (fresh.status !== row.status) throw new Error('Checkbox recovery raced.');
          const assertRecoveryFence = () => {
            this.boundary();
            this.writeFence.assertRecoveryRead(identities[0]!, fresh);
          };
          assertRecoveryFence();
          const file = await readCheckboxSource(current, assertRecoveryFence);
          if (file.device !== identities[0]!.device || file.inode !== identities[0]!.inode)
            throw new CheckboxEvidenceError('Checkbox recovery source identity changed.');
          this.boundary();
          const hash = rawByteHash(file.bytes);
          const evidence = this.validate(fresh);
          this.store.transaction((tx) =>
            requireSameCheckboxAuthority(
              expected,
              sync(this.authority.requireRecoveryCurrent(fresh, current, tx))
            )
          );
          await cleanCheckboxTemporary(fresh, assertRecoveryFence);
          assertRecoveryFence();
          this.boundary();
          if (hash === row.beforeHash)
            return { status: 'in_doubt', eventId: row.eventId, action: 'review' };
          if (hash !== row.afterHash || row.beforeHash === row.afterHash) {
            this.quarantine(id, 'unknown_file_state');
            return { status: 'in_doubt', eventId: row.eventId, action: 'review' };
          }
          const before = Buffer.from(file.bytes);
          before[evidence.markerOffset!] = evidence.beforeMarker!;
          try {
            assertCheckboxReplacement(fresh, file);
            const edit = prepareCheckboxBytes(
              before,
              CanvasChannelCheckboxRequestSchema.parse(fresh.input)
            );
            if (edit.markerOffset !== evidence.markerOffset || !edit.after.equals(file.bytes))
              throw new Error('Reconstructed source differs');
          } catch {
            this.quarantine(id, 'corrupt_file_evidence');
            return { status: 'in_doubt', eventId: row.eventId, action: 'review' };
          }
          try {
            return this.complete(fresh, (tx) => {
              requireSameCheckboxAuthority(
                expected,
                sync(this.authority.requireRecoveryCurrent(fresh, current, tx))
              );
              return undefined;
            });
          } catch (error) {
            if (error instanceof CheckboxEvidenceError || this.authorityRefused(error))
              this.quarantine(id, 'recovery_authority_refused');
            throw error;
          }
        })
        .catch((error: unknown) => {
          if (error instanceof CheckboxEvidenceError || this.authorityRefused(error))
            this.quarantine(id, 'recovery_authority_refused');
          throw error;
        });
    });
  }
  private authorityRefused(error: unknown): boolean {
    try {
      const result = sync(this.authority.isAuthorityRefusal(error));
      return typeof result === 'boolean' && result;
    } catch {
      return false;
    }
  }
  private async checkpoint(
    point: Parameters<NonNullable<CheckboxServiceOptions['checkpoint']>>[0],
    row: DocWriteIntentRow
  ): Promise<void> {
    this.boundary();
    await this.options.checkpoint?.(point, row);
    this.boundary();
  }
}
