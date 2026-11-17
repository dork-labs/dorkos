/**
 * The typed refusals of the grant review service, apart from the service so
 * the HTTP boundary and the service share one list (moved out of
 * `reconciliation-service.ts` unchanged, which is over its line cap).
 *
 * @module services/connectors/reconciliation/reconciliation-error
 */

/** Stable refusal codes returned by the reconciliation HTTP boundary. */
export type ConnectorReconciliationErrorCode =
  | 'connection_not_found'
  | 'operations_unsupported'
  | 'catalog_incomplete'
  | 'preview_stale'
  | 'invalid_selection'
  | 'every_agent_unavailable';

/** A secret-free, typed reconciliation refusal. */
export class ConnectorReconciliationError extends Error {
  /**
   * Construct one typed refusal.
   *
   * @param code - Stable refusal category.
   * @param message - Operator-facing safe explanation.
   */
  constructor(
    readonly code: ConnectorReconciliationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ConnectorReconciliationError';
  }
}

/**
 * Thrown inside the apply transaction, before anything is written, when a
 * save the route sent as "only takes access away" would also settle the
 * review: the connection isn't already settled, or the hosted service may
 * re-send refused grant changes (Security M1 on DOR-4355 M3). The route then
 * holds the save for the owner to confirm.
 */
export class ReconciliationNeedsConfirmationError extends Error {
  constructor() {
    super('This change also settles the review, so the owner confirms it.');
    this.name = 'ReconciliationNeedsConfirmationError';
  }
}
