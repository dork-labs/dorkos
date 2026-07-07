/**
 * DorkOS admin console feature (cloud-account-management, DOR-193) — the
 * operator surface over the Better Auth `admin` plugin: user list + search,
 * ban/unban, set role, revoke sessions, impersonate, and hard-delete, plus a
 * recent-activity view of the audit log. Kept as an isolated slice (and the
 * identity/db core stays app-agnostic) so this can extract to a separate
 * `apps/admin` on a trigger — see ADR `260707-122350`.
 *
 * @module features/admin
 */
export { AdminAction } from './ui/AdminAction';
export { AdminSearch } from './ui/AdminSearch';
export { ImpersonationBanner } from './ui/ImpersonationBanner';
export { RecentAudit } from './ui/RecentAudit';
export { UserRow } from './ui/UserRow';
