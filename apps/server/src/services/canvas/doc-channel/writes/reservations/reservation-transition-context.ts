import type { DbTransaction } from '@dorkos/db';
import type { DocChannelStore, DocEventRow, DocBatchRow, DocWriteIntentRow } from '../../store.js';
import type { CheckboxReservationBinding, CheckboxReservationSubject } from '../authority.js';
import type { VerifiedCheckboxProjection } from '../completion.js';
import type { CheckboxReservationPolicy } from './reservation-policy-census.js';
import type { OriginalPreparedCheckboxConversion } from './reservation-bridge.js';

/** Original transaction-local reservation obligations; declaration alone never establishes membership. */
export interface OriginalReservationScope {
  binding: CheckboxReservationBinding;
  store?: DocChannelStore;
  failed: boolean;
  cause?: unknown;
  conversionAttempted: boolean;
  preparedConversion?: OriginalPreparedCheckboxConversion;
  obligation?: {
    projection: VerifiedCheckboxProjection;
    event: DocEventRow;
    policy: CheckboxReservationPolicy;
    documentLabel: string;
    priorBatch: DocBatchRow | null;
  };
  outboxStarted?: boolean;
  rowObligation?: {
    row: DocWriteIntentRow;
    terminal: boolean;
    effect?: boolean;
    prepared?: boolean;
  };
  staged?: { store: DocChannelStore; projection: VerifiedCheckboxProjection; receivedAt: string };
}
/** Original private bridge state ports; no key or registrar is published. */
export interface OriginalReservationTransitionView {
  readonly binding: CheckboxReservationBinding;
  readonly store: DocChannelStore;
  readonly guarded: <T>(
    binding: CheckboxReservationBinding,
    tx: DbTransaction,
    work: (scope: OriginalReservationScope) => T
  ) => T;
  readonly captureSubject: (subject: CheckboxReservationSubject) => CheckboxReservationSubject;
}
