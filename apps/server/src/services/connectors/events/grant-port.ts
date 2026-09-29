/** Private owner-review event consent, independent of executable operation grants. */
import type {
  ConnectorReceiveScope,
  ConnectorEventGrantSelection,
} from '@dorkos/shared/connector-event-schemas';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';

/** Exact owner decision; reviewId comes from the durable owner-review state machine. */
export interface ConnectorEventGrantReview {
  reviewId: string;
  scopes: ConnectorReceiveScope[];
  manageExistingTriggers?: boolean;
}
/** Ready means every exact receive generation remains authorized and, when managed, acknowledged. */
export type ConnectorEventGrantResult =
  | {
      state: 'ready';
      selections: ConnectorEventGrantSelection[];
      appliedEventScopeHash: string;
    }
  | { state: 'pending' | 'unavailable'; selections: ConnectorEventGrantSelection[] };
/** Private port consumed by agent request approval; never registered as a public agent tool. */
export interface ConnectorEventGrantPort {
  describe(
    owner: ConnectorOwnerAuthority,
    scopes: ConnectorReceiveScope[]
  ): Array<{ definitionId: string; eventType: string }>;
  /** Final synchronous current-authority check; false must prevent dispatch. */
  ready(
    owner: ConnectorOwnerAuthority,
    selections: ConnectorEventGrantSelection[],
    appliedEventScopeHash: string
  ): boolean;
  approve(
    owner: ConnectorOwnerAuthority,
    review: ConnectorEventGrantReview,
    signal: AbortSignal
  ): Promise<ConnectorEventGrantResult>;
  /**
   * Take back everything an approval prepared or switched on under one review:
   * stop each of its subscription generations and forget its consent, so no
   * update arrives for an answer that was taken back and a different pick can
   * be approved under the same review. Synchronous, so a caller can run it in
   * the same transaction as its own state change. Idempotent.
   */
  withdraw(owner: ConnectorOwnerAuthority, reviewId: string, now: string): void;
}
/** Existing managed authority outbox adapter; true requires the exact stored event-scope ACK. */
export interface ManagedEventConsentAuthority {
  reconcile(subscriptionId: string, scopeVersion: number, signal: AbortSignal): Promise<boolean>;
  ready(subscriptionId: string, scopeVersion: number): boolean;
}
/** Staging half the event grant service needs to take a review back durably. */
export interface ManagedEventConsentStaging {
  /**
   * Durably stage the hosted command for one exact local generation, in the
   * caller's transaction, for the outbox's recovery to deliver. Synchronous.
   */
  stage(subscriptionId: string, scopeVersion: number): void;
}
