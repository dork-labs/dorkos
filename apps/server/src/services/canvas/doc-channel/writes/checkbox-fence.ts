import {
  readPreparedUnresolvedIntentValues,
  unresolvedIntentDecoders,
} from '../readers/prepared-readers.js';
import { readChecked } from '../storage/store-json.js';
/** Derived current admission over the sole durable intent ledger; never an effect ledger. */
import type { Db } from '@dorkos/db';
import {
  DocChannelCorruptionError,
  requireDocChannelStoreDatabase,
  type DocChannelStore,
  type DocWriteIntentRow,
} from '../store.js';
import type { CanonicalFileIdentity } from './canonical-writer.js';
import {
  CheckboxPhysicalIdentitySchema,
  freezeCheckboxData,
  validateCheckboxEvidence,
} from './checkbox-evidence.js';

/** Missing or untrustworthy current ledger evidence closes write readiness. */
export class CheckboxFenceUnavailableError extends Error {
  constructor(readonly reason: 'legacy' | 'corrupt' | 'missing' | 'transient' | 'transaction') {
    super('Checkbox write admission evidence is unavailable.');
    this.name = 'CheckboxFenceUnavailableError';
  }
}
/** A current physical identity or canonical path intersects an unresolved effect. */
export class CheckboxWriteFencedError extends Error {
  constructor() {
    super('This file has an unresolved checkbox write.');
    this.name = 'CheckboxWriteFencedError';
  }
}

interface FenceOwner {
  db: Db;
  store: DocChannelStore;
  native: Db['$client'];
  admission(identity: CanonicalFileIdentity): void;
  owned(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void;
  recovery(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void;
  unresolved(): boolean;
}
const fenceOwners = new WeakMap<object, FenceOwner>();
/** Native constructor custody, not a caller-supplied ready certificate. */
export function requireCheckboxWriteFence(
  fence: unknown,
  db: Db,
  store: DocChannelStore
): undefined {
  const owner = fence && typeof fence === 'object' ? fenceOwners.get(fence) : undefined;
  if (
    !owner ||
    owner.db !== db ||
    owner.store !== store ||
    owner.native !== db.$client ||
    !owner.native.open
  )
    throw new CheckboxFenceUnavailableError('missing');
  requireDocChannelStoreDatabase(store, db);
  if (owner.native.inTransaction) throw new CheckboxFenceUnavailableError('transaction');
  return undefined;
}
/** Captured private scan; public replacement cannot waive current admission. */
export function assertRecognizedCheckboxAdmission(
  fence: CheckboxWriteFence,
  db: Db,
  store: DocChannelStore,
  identity: CanonicalFileIdentity
): void {
  requireCheckboxWriteFence(fence, db, store);
  fenceOwners.get(fence)!.admission(identity);
  requireCheckboxWriteFence(fence, db, store);
}
/** Read whether the recognized checkbox writer retains unresolved work. */
export function hasRecognizedCheckboxUnresolved(
  fence: CheckboxWriteFence,
  db: Db,
  store: DocChannelStore
): boolean {
  requireCheckboxWriteFence(fence, db, store);
  const result = fenceOwners.get(fence)!.unresolved();
  requireCheckboxWriteFence(fence, db, store);
  return result;
}
/** Require original owned admission for the recognized checkbox writer. */
export function assertRecognizedCheckboxOwnedAdmission(
  fence: CheckboxWriteFence,
  db: Db,
  store: DocChannelStore,
  identity: CanonicalFileIdentity,
  intent: DocWriteIntentRow
): void {
  requireCheckboxWriteFence(fence, db, store);
  fenceOwners.get(fence)!.owned(identity, intent);
  requireCheckboxWriteFence(fence, db, store);
}
/** Require an original recovery read for the recognized checkbox writer. */
export function assertRecognizedCheckboxRecoveryRead(
  fence: CheckboxWriteFence,
  db: Db,
  store: DocChannelStore,
  identity: CanonicalFileIdentity,
  intent: DocWriteIntentRow
): void {
  requireCheckboxWriteFence(fence, db, store);
  fenceOwners.get(fence)!.recovery(identity, intent);
  requireCheckboxWriteFence(fence, db, store);
}

/** Caller resolves/rechecks identity under shared tree/file admission before every effect. */
export class CheckboxWriteFence {
  // Reuse only pure validation of identical complete rows, never ledger or authority decisions.
  // Every scan still reads every unresolved row from the current transaction.
  readonly #validated = new Map<
    string,
    { bytes: string; evidence: ReturnType<typeof validateCheckboxEvidence> }
  >();

  readonly #rawValidated = new Map<
    string,
    {
      values: readonly (string | null)[];
      row: DocWriteIntentRow;
      evidence: ReturnType<typeof validateCheckboxEvidence>;
    }
  >();

  readonly #db: Db;
  readonly #store: DocChannelStore;
  constructor(db: Db, store: DocChannelStore) {
    requireDocChannelStoreDatabase(store, db);
    this.#db = db;
    this.#store = store;
    fenceOwners.set(this, {
      db,
      store,
      native: db.$client,
      admission: (identity) => this.#assertAdmission(identity),
      unresolved: () => this.#hasUnresolved(),
      owned: (identity, intent) => this.#assertOwned(identity, intent),
      recovery: (identity, intent) => this.#assertRecovery(identity, intent),
    });
  }

  readiness(): { ready: true } | { ready: false; reason: CheckboxFenceUnavailableError['reason'] } {
    try {
      this.#scan();
      return { ready: true };
    } catch (error) {
      if (!(error instanceof CheckboxFenceUnavailableError)) throw error;
      return { ready: false, reason: error.reason };
    }
  }
  assertAdmission(identity: CanonicalFileIdentity): void {
    this.#assertAdmission(identity);
  }
  #assertAdmission(identity: CanonicalFileIdentity): void {
    if (this.#scan(identity)) throw new CheckboxWriteFencedError();
  }
  /** Trusted owner only: validate its current row while excluding its own recovery fence. */
  assertOwnedIntentAdmission(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void {
    this.#assertOwned(identity, intent);
  }
  #assertOwned(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void {
    if (this.#scan(identity, intent)) throw new CheckboxWriteFencedError();
  }
  /** Evidence-only recovery may inspect fenced bytes; it must never reapply a filesystem effect. */
  assertRecoveryRead(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void {
    this.#assertRecovery(identity, intent);
  }
  #assertRecovery(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void {
    this.#scan(identity, intent, false, true);
  }
  /** Conservative diagnostic when the caller has not supplied an actual physical identity. */
  hasUnresolved(): boolean {
    return this.#hasUnresolved();
  }
  #hasUnresolved(): boolean {
    return this.#scan(undefined, undefined, true);
  }
  /** Refuse conservatively when a diagnostic caller supplies no current physical identity. */
  conservativelyFenced(): boolean {
    try {
      return this.#hasUnresolved();
    } catch (error) {
      if (error instanceof CheckboxFenceUnavailableError) return true;
      throw error;
    }
  }
  #validate(row: DocWriteIntentRow): ReturnType<typeof validateCheckboxEvidence> {
    const bytes = JSON.stringify(row);
    const previous = this.#validated.get(row.intentId);
    if (previous?.bytes === bytes) return previous.evidence;
    this.#validated.delete(row.intentId);
    const evidence = freezeCheckboxData(validateCheckboxEvidence(row));
    // Large rows are checked normally without retaining an additional large string.
    if (bytes.length <= 65536) {
      if (this.#validated.size === 256)
        this.#validated.delete(this.#validated.keys().next().value!);
      this.#validated.set(row.intentId, { bytes, evidence });
    }
    return evidence;
  }
  #validateRaw(values: unknown[]): {
    row: DocWriteIntentRow;
    evidence: ReturnType<typeof validateCheckboxEvidence>;
  } {
    if (
      values.length !== unresolvedIntentDecoders.length ||
      values.some((value) => value !== null && typeof value !== 'string') ||
      typeof values[0] !== 'string'
    )
      throw new Error('Invalid original intent projection');
    const intentId = values[0];
    // Cache only the original schema's pure decoders. A replaced decoder uses the normal fresh path.
    const original = unresolvedIntentDecoders.every(
      ({ column, decode }) => column.mapFromDriverValue === decode
    );
    const previous = original ? this.#rawValidated.get(intentId) : undefined;
    if (previous && values.every((value, index) => value === previous.values[index]))
      return previous;
    this.#rawValidated.delete(intentId);
    const row = readChecked(
      'canvas_doc_write_intents',
      intentId,
      () =>
        Object.fromEntries(
          unresolvedIntentDecoders.map(({ key, column }, index) => {
            const value = values[index];
            if (value !== null && typeof value !== 'string')
              throw new Error('Invalid original intent cell');
            return [key, value === null ? null : column.mapFromDriverValue(value)];
          })
        ) as DocWriteIntentRow
    );
    const evidence = freezeCheckboxData(validateCheckboxEvidence(row));
    if (
      original &&
      unresolvedIntentDecoders.every(
        ({ column, decode }) => column.mapFromDriverValue === decode
      ) &&
      values.reduce<number>(
        (size, value) => size + (typeof value === 'string' ? value.length : 0),
        0
      ) <= 65536
    ) {
      if (this.#rawValidated.size === 256)
        this.#rawValidated.delete(this.#rawValidated.keys().next().value!);
      const retained = {
        values: Object.freeze(values.map((value) => value as string | null)),
        row: freezeCheckboxData(row),
        evidence,
      };
      this.#rawValidated.set(intentId, retained);
      return retained;
    }
    return { row, evidence };
  }
  #scan(
    identity?: CanonicalFileIdentity,
    ownedIntent?: DocWriteIntentRow,
    any = false,
    evidenceOnly = false
  ): boolean {
    requireCheckboxWriteFence(this, this.#db, this.#store);
    if (identity) {
      try {
        CheckboxPhysicalIdentitySchema.parse({ device: identity.device, inode: identity.inode });
        if (!identity.canonicalPath) throw new Error('missing path');
      } catch {
        throw new CheckboxFenceUnavailableError('missing');
      }
    }
    try {
      return this.#db.$client.transaction(() => {
        if (ownedIntent) {
          const current = this.#store.getWriteIntent(ownedIntent.intentId);
          if (!current) throw new CheckboxFenceUnavailableError('missing');
          try {
            this.#validate(current);
          } catch {
            throw new CheckboxFenceUnavailableError('corrupt');
          }
          if (JSON.stringify(current) !== JSON.stringify(ownedIntent))
            throw new CheckboxFenceUnavailableError('missing');
        }
        let cursor: string | undefined;
        let fenced = false;
        for (;;) {
          const rows = readPreparedUnresolvedIntentValues(this.#db, cursor);
          for (const selected of rows) {
            let row: DocWriteIntentRow;
            let evidence: ReturnType<typeof validateCheckboxEvidence>;
            try {
              ({ row, evidence } = this.#validateRaw(selected));
            } catch {
              throw new CheckboxFenceUnavailableError('corrupt');
            }
            if (row.intentId === ownedIntent?.intentId || evidenceOnly) continue;
            // A replaced original may have one surviving cross-tree alias: no link-count shortcut.
            if (evidence.v === 1 || !evidence.originalIdentity)
              throw new CheckboxFenceUnavailableError('legacy');
            if (
              any ||
              (identity &&
                (row.canonicalPath === identity.canonicalPath ||
                  [evidence.originalIdentity, evidence.tempIdentity].some(
                    (physical) =>
                      physical &&
                      physical.device === identity.device &&
                      physical.inode === identity.inode
                  )))
            )
              fenced = true;
          }
          if (rows.length < 100) return fenced;
          const next = rows.at(-1)![0];
          if (typeof next !== 'string') throw new CheckboxFenceUnavailableError('corrupt');
          cursor = next;
        }
      })();
    } catch (error) {
      if (error instanceof CheckboxFenceUnavailableError) throw error;
      if (error instanceof SyntaxError || error instanceof DocChannelCorruptionError)
        throw new CheckboxFenceUnavailableError('corrupt');
      throw new CheckboxFenceUnavailableError('transient');
    }
  }
}
