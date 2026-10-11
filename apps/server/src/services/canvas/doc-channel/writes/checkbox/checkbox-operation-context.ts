import type { Db, DbTransaction } from '@dorkos/db';
import type { DocChannelActor } from '../../authorization.js';
import type { DocChannelStore, DocWriteIntentRow } from '../../store.js';
import type { CanonicalFileWriteCoordinator, CanonicalWriteLease } from '../canonical-writer.js';
import type { readCheckboxSource } from '../checkbox-file.js';
import type { CheckboxWriteFence } from '../checkbox-fence.js';
import type { DocCheckboxAuthority, CheckboxReservationSubject } from '../authority.js';
import type { createOriginalCheckboxCompletion } from '../completion.js';
import type {
  validateCheckboxEvidence,
  CheckboxRequest,
  CheckboxReceipt,
  VerifiedCheckboxAuthority,
  CheckboxServiceOptions,
} from '../checkbox-evidence.js';
/** Constructor-owned ports; inaccessible operation keys are the only route to this view. */
export interface OriginalCheckboxWriteOperationContext {
  readonly authority: DocCheckboxAuthority;
  readonly completion: ReturnType<typeof createOriginalCheckboxCompletion>;
  readonly coordinator: CanonicalFileWriteCoordinator;
  readonly db: Db;
  readonly store: DocChannelStore;
  readonly writeFence: CheckboxWriteFence;
  readonly authorityRefused: (error: unknown) => boolean;
  readonly boundary: () => void;
  readonly checkpoint: (
    point: Parameters<NonNullable<CheckboxServiceOptions['checkpoint']>>[0],
    row: DocWriteIntentRow
  ) => Promise<void>;
  readonly complete: (
    row: DocWriteIntentRow,
    subject: CheckboxReservationSubject,
    assertFs: () => void,
    lease: CanonicalWriteLease
  ) => Promise<CheckboxReceipt>;
  readonly duplicate: (
    row: DocWriteIntentRow,
    digest: string,
    actor: DocChannelActor,
    tx?: DbTransaction
  ) => CheckboxReceipt;
  readonly find: (
    documentId: string,
    eventId: string,
    tx?: DbTransaction
  ) => DocWriteIntentRow | undefined;
  readonly live: (
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority
  ) => Extract<CheckboxReservationSubject, { kind: 'live' }>;
  readonly preEffectConflict: (
    request: CheckboxRequest,
    actor: DocChannelActor,
    approved: VerifiedCheckboxAuthority,
    digest: string
  ) => Promise<CheckboxReceipt>;
  readonly quarantine: (expected: DocWriteIntentRow, reason: string) => void;
  readonly readSource: (
    approved: VerifiedCheckboxAuthority,
    assertCurrent: () => void
  ) => ReturnType<typeof readCheckboxSource>;
  readonly receipt: (row: DocWriteIntentRow) => CheckboxReceipt;
  readonly retainCloseFailure: (cause: unknown) => void;
  readonly time: () => string;
  readonly track: <T>(work: () => Promise<T>) => Promise<T>;
  readonly validate: (row: DocWriteIntentRow) => ReturnType<typeof validateCheckboxEvidence>;
}
