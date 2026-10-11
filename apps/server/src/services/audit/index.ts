/**
 * The audit log (spec `audit-trail`): one append-only, hash-chained record of
 * every action on this server. Start at `audit-log.ts`.
 *
 * @module services/audit
 */
export { AuditLog } from './audit-log.js';
export type { AuditInput, AuditObserver } from './audit-log.js';
export { auditDomain } from './audit-capabilities.js';
export { wireAuditTrail } from './wire-audit-trail.js';
export { auditCapabilityDeps, wireSessionVisibility } from './wire-session-visibility.js';
export type { WireAuditTrailDeps } from './wire-audit-trail.js';
