/**
 * What the connected-app routes share when a person's change gives access:
 * the words the front-door bar uses for them, and the one shape of grant
 * change that can be told apart as taking access away (DOR-4355).
 *
 * A change that gives an agent or a mini app more waits for the owner to
 * confirm it's them (`routes/front-door-step-up.ts`); one that takes access
 * away stays immediate. Where the direction can't be told, the change waits.
 *
 * @module routes/connector-step-up
 */
import type { ConnectorReconciliationApplyRequest } from '@dorkos/shared/connector-schemas';

/** What a refused connected-app change names, as the front-door bar words it. */
export const CONNECTED_APPS = 'connected apps';

/**
 * Whether a grant change can only take access away: it names at least one
 * agent or the every-agent share, and each one it names ends up with no
 * actions and no level. A change that names nobody is "confirm who can use it
 * as it stands", which settles the review and can turn suspended grants back
 * on (Security M1 on DOR-4355 M3), so it waits. Anything else may give more
 * than an agent holds now, which this route can't see, so it waits too.
 *
 * The service checks the rest inside its write: the review must already be
 * settled, with nothing for a hosted service to re-send
 * (`ReconciliationNeedsConfirmationError`).
 *
 * @param request - The validated grant change.
 */
export function onlyRemovesAccess(request: ConnectorReconciliationApplyRequest): boolean {
  const empty = (selection: { operationRevisionIds: string[]; level?: unknown }) =>
    selection.operationRevisionIds.length === 0 && selection.level === undefined;
  const namesSomeone = request.grants.length > 0 || request.everyAgent !== undefined;
  return (
    namesSomeone &&
    request.grants.every(empty) &&
    (request.everyAgent === undefined || empty(request.everyAgent))
  );
}
