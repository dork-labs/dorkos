import type { DbTransaction } from '@dorkos/db';
import type { DocChannelActor } from '../../authorization.js';
import type { CheckboxAuthorityDependencies } from './authority-policy.js';
import type { VerifiedCheckboxAuthority } from '../checkbox-evidence.js';
import type {
  CheckboxSourceObservation,
  CheckboxSnapshotRegistry,
  CheckboxAuthorityTransactions,
} from './authority-snapshot.js';
import type { DocCheckboxAuthority } from '../authority.js';
/** Original fixed cells and private callbacks; only a constructor-private key can retrieve them. */
export interface OriginalCheckboxAuthorityOperationView {
  readonly deps: Readonly<CheckboxAuthorityDependencies>;
  readonly snapshots: CheckboxSnapshotRegistry;
  readonly transactions: CheckboxAuthorityTransactions;
  readonly reservationObservations: WeakMap<
    DbTransaction,
    {
      approved: VerifiedCheckboxAuthority;
      observation: import('../../grant-policy.js').DocOriginalWriteObservation;
    }
  >;
  readonly transaction: DocCheckboxAuthority['transaction'];
  readonly refreshRecoveryCurrent: DocCheckboxAuthority['refreshRecoveryCurrent'];
  readonly requireRecoveryCurrent: DocCheckboxAuthority['requireRecoveryCurrent'];
  operation<T>(run: () => Promise<T>): Promise<T>;
  currentOperation<T>(run: () => T): T;
  access(documentId: string, actor: DocChannelActor, tx: DbTransaction): undefined;
  checked(
    documentId: string,
    grantId: string,
    revision: number,
    observation: CheckboxSourceObservation,
    tx: DbTransaction,
    actor?: DocChannelActor
  ): VerifiedCheckboxAuthority;
  editor(
    documentId: string,
    actor: DocChannelActor | undefined,
    tx: DbTransaction,
    options?: { grantId?: string; time?: number }
  ): void;
  now(): Date;
  outside(): undefined;
  observe(documentId: string): Promise<CheckboxSourceObservation>;
}
