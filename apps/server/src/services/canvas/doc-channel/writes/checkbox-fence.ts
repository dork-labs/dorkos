/** Derived current admission over the sole durable intent ledger; never an effect ledger. */
import { asc, gt, sql, canvasDocWriteIntents, type Db } from '@dorkos/db';
import {
  DocChannelCorruptionError,
  type DocChannelStore,
  type DocWriteIntentRow,
} from '../store.js';
import type { CanonicalFileIdentity } from './canonical-writer.js';
import { CheckboxPhysicalIdentitySchema, validateCheckboxEvidence } from './checkbox-evidence.js';

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

/** Caller resolves/rechecks identity under shared tree/file admission before every effect. */
export class CheckboxWriteFence {
  constructor(
    private readonly db: Db,
    private readonly store: DocChannelStore
  ) {}

  readiness(): { ready: true } | { ready: false; reason: CheckboxFenceUnavailableError['reason'] } {
    try {
      this.scan();
      return { ready: true };
    } catch (error) {
      if (!(error instanceof CheckboxFenceUnavailableError)) throw error;
      return { ready: false, reason: error.reason };
    }
  }
  assertAdmission(identity: CanonicalFileIdentity): void {
    if (this.scan(identity)) throw new CheckboxWriteFencedError();
  }
  /** Trusted owner only: validate its current row while excluding its own recovery fence. */
  assertOwnedIntentAdmission(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void {
    if (this.scan(identity, intent)) throw new CheckboxWriteFencedError();
  }
  /** Evidence-only recovery may inspect fenced bytes; it must never reapply a filesystem effect. */
  assertRecoveryRead(identity: CanonicalFileIdentity, intent: DocWriteIntentRow): void {
    this.scan(identity, intent, false, true);
  }
  /** Conservative diagnostic when the caller has not supplied an actual physical identity. */
  hasUnresolved(): boolean {
    return this.scan(undefined, undefined, true);
  }
  /** Refuse conservatively when a diagnostic caller supplies no current physical identity. */
  conservativelyFenced(): boolean {
    try {
      return this.hasUnresolved();
    } catch (error) {
      if (error instanceof CheckboxFenceUnavailableError) return true;
      throw error;
    }
  }
  private scan(
    identity?: CanonicalFileIdentity,
    ownedIntent?: DocWriteIntentRow,
    any = false,
    evidenceOnly = false
  ): boolean {
    if (this.db.$client.inTransaction) throw new CheckboxFenceUnavailableError('transaction');
    if (identity) {
      try {
        CheckboxPhysicalIdentitySchema.parse({ device: identity.device, inode: identity.inode });
        if (!identity.canonicalPath) throw new Error('missing path');
      } catch {
        throw new CheckboxFenceUnavailableError('missing');
      }
    }
    try {
      return this.db.$client.transaction(() => {
        if (ownedIntent) {
          const current = this.store.getWriteIntent(ownedIntent.intentId);
          if (!current) throw new CheckboxFenceUnavailableError('missing');
          try {
            validateCheckboxEvidence(current);
          } catch {
            throw new CheckboxFenceUnavailableError('corrupt');
          }
          if (JSON.stringify(current) !== JSON.stringify(ownedIntent))
            throw new CheckboxFenceUnavailableError('missing');
        }
        let cursor: string | undefined;
        let fenced = false;
        for (;;) {
          const rows = this.db
            .select()
            .from(canvasDocWriteIntents)
            .where(
              sql`${canvasDocWriteIntents.status} NOT IN ('committed','no_op','conflict')
              ${cursor ? sql`AND ${gt(canvasDocWriteIntents.intentId, cursor)}` : sql``}`
            )
            .orderBy(asc(canvasDocWriteIntents.intentId))
            .limit(100)
            .all();
          for (const selected of rows) {
            const row = selected;
            let evidence: ReturnType<typeof validateCheckboxEvidence>;
            try {
              evidence = validateCheckboxEvidence(row);
            } catch {
              throw new CheckboxFenceUnavailableError('corrupt');
            }
            if (selected.intentId === ownedIntent?.intentId || evidenceOnly) continue;
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
          cursor = rows.at(-1)!.intentId;
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
