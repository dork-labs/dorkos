/**
 * Plain words for connection access, shared by the connectors entity's views.
 *
 * @module entities/connectors/lib/access-copy
 */
import { connectionAccessWords, serviceNameFromToolkit } from '@dorkos/shared/connector-schemas';

/**
 * A service's display name from its toolkit id when no catalog name is at hand:
 * `gmail` → `Gmail`, `google_calendar` → `Google Calendar`. The server's
 * Activity entries use the same shared rule, so both name an app the same way.
 */
export const serviceName = serviceNameFromToolkit;

/**
 * What a set of classifications lets an agent do, in words (shared with the
 * server's Activity entries): `read and write`, `read, write and high-risk
 * actions`.
 */
export const accessLevelWords = connectionAccessWords;
