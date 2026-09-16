/**
 * The **control-plane** half of the apps/site Neon Postgres schema.
 *
 * `drizzle.control-plane.config.ts` points at this file, so exactly the tables
 * reachable from here are what `drizzle-control-plane/` migrates: the Better
 * Auth account tables and their plugin tables, the device-link `instance`
 * registry, the `audit_log`, and the managed-connector tables.
 *
 * Every foreign key in the site's schema lives inside this half. Nothing here
 * references anything in `public-schema.ts`, and nothing there references
 * anything here — that isolation is the reason the two migration histories can
 * run independently over one database.
 *
 * @module db/control-plane-schema
 */
export { account, apikey, deviceCode, session, user, verification } from './auth-schema';
export { managedConnectorAuthConfigResolution } from './managed-auth-config-schema';
export { instance, type Instance, type NewInstance } from './instance-schema';
export { auditLog, type AuditLogEntry, type NewAuditLogEntry } from './audit-schema';
export {
  connectorTenant,
  managedConnectorAuthFlow,
  managedConnectorAuthorityCommand,
  managedConnectorConnection,
  managedConnectorExecutionAttempt,
  managedConnectorGrant,
  managedConnectorOperationRevision,
  managedConnectorProvider,
} from './managed-connectors-schema';
export {
  managedConnectorEventCapacity,
  managedConnectorEventDefinition,
  managedConnectorEventBinding,
  managedConnectorEventSubscription,
  managedConnectorEventInbox,
} from './managed-connector-events-schema';
