/**
 * Build the audit trail at startup (spec `audit-trail`): the log, the account
 * ids, the copy of every Activity event, and the startup chain check, in one
 * call so the wiring can be tested rather than read off `index.ts`.
 *
 * @module services/audit/wire-audit-trail
 */
import type { Db } from '@dorkos/db';
import type { ActivityService } from '../activity/activity-service.js';
import { AccountIds } from './account-ids.js';
import { createActivityTee } from './activity-tee.js';
import { AuditLog } from './audit-log.js';
import { initAuditTrail } from './audit-trail.js';

/** What the audit trail needs from the rest of startup. */
export interface WireAuditTrailDeps {
  /** The consolidated database. */
  db: Db;
  /** The Activity feed, whose every event is copied into the log. */
  activity: Pick<ActivityService, 'observe'>;
  /** This install's stable id (`lib/instance-id.ts`). */
  installId: string;
  /** The account that owns this install, or `null` while nobody has one. */
  readOwnerAccount: () => { id: string; name: string } | null;
}

/**
 * Build the audit log, tee Activity into it, check the recent end of the
 * chain, and make it reachable through `recordAudit`. A broken chain is logged and kept as evidence; it never stops startup.
 *
 * @param deps - The database, the Activity feed, and who owns this install.
 * @returns The log and the account-id resolver.
 */
export function wireAuditTrail(deps: WireAuditTrailDeps): {
  log: AuditLog;
  accounts: AccountIds;
} {
  const log = new AuditLog(deps.db);
  const accounts = new AccountIds({
    db: deps.db,
    installId: deps.installId,
    readOwnerAccount: deps.readOwnerAccount,
  });
  deps.activity.observe(createActivityTee(log, accounts));
  log.verifyTail();
  // Reachable server-wide from here on, for the choke points no caller can
  // hand a log to (the MCP gate, config writes, package changes, sign-ins).
  initAuditTrail({ log, accounts });
  return { log, accounts };
}
