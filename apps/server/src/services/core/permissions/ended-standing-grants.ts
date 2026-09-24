/**
 * Ending live standing permissions at upgrade (spec `agent-permissions` D13,
 * phase 2).
 *
 * Standing permissions were time-boxed windows in which DorkOS stopped asking
 * about one agent doing one thing. "Always allow" replaces them, and the live
 * ones are ENDED rather than converted: turning a window that was about to close
 * into a permanent setting would widen what somebody agreed to. Ending one still
 * owes the person a line in the permission history, naming the agent and the
 * action, so a window that stopped working does not stop silently.
 *
 * ## Why this is two halves with a file between them
 *
 * The `approval_grants` table is dropped by a Drizzle migration, and migrations
 * run at boot long before the Activity service exists. So the rows have to be
 * read BEFORE the drop, and the events written AFTER the Activity service is up.
 * The simplest testable bridge is a small one-shot JSON under the data
 * directory:
 *
 * 1. {@link captureLiveStandingGrants} runs just before `runMigrations`. If the
 *    table still exists (only on the first boot of this build), it writes the
 *    live grants to {@link ENDED_STANDING_GRANTS_FILE}. A file, not memory, so a
 *    crash between the drop and the sweep loses nothing.
 * 2. {@link recordEndedStandingGrants}, a step of the boot permission sweep,
 *    reads that file, writes one event per grant, and deletes it. It runs
 *    whenever the file exists, independent of the sweep's per-version marker,
 *    because the file is itself the "still owed" marker.
 *
 * ## Only the grants that were really live
 *
 * A row that is unrevoked and unexpired was not necessarily honored. The old
 * gate also required the master switch (`approvals.standingGrants`), voided
 * every grant made at or before `approvals.standingGrantsVoidBefore` (stamped by
 * `dorkos config set`, which has no database to revoke rows in), and ended them
 * all at boot whenever login was off. Reporting such a row as "ended" would tell
 * the person a window was open that was not, so the capture applies the same
 * three rules, read by {@link readStandingGrantLicence}.
 *
 * This build no longer declares those settings, so they are read straight off
 * `config.json`, where they stay (an unknown key, carried across every write)
 * until the server removes them just after its capture
 * (`ConfigManager.retireStandingGrantSettings`). They are deliberately not
 * removed by a config migration: the CLI opens the config store before the
 * server migrates the database, so a migration would erase them first. Every
 * entry point that migrates the real database (the server, and the CLI's
 * `dorkos auth`, which can run before the server ever has) captures before
 * migrating; `__tests__/ended-standing-grants-callers.test.ts` holds every
 * `runMigrations` caller to that.
 *
 * Capturing is best-effort and never blocks a boot: the grants are dead either
 * way (no code reads them any more), so a failure costs the history lines, not
 * safety, and is logged.
 *
 * @module services/core/permissions/ended-standing-grants
 */
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

import { sql, type Db } from '@dorkos/db';
import type { Logger } from '@dorkos/shared/logger';

import type { ActivityService } from '../../activity/activity-service.js';
import { STANDING_GRANT_ENDED_EVENT, UPGRADE_WRITER } from './permission-history.js';
import type { PermissionAgentRef } from './permission-service.js';

/** The one-shot file the capture writes and the sweep consumes. */
export const ENDED_STANDING_GRANTS_FILE = 'ended-standing-grants.json';

/** One live standing permission, as the capture recorded it. */
export interface EndedStandingGrant {
  /** The grant's id. */
  id: string;
  /** The agent's project directory. */
  agentPath: string;
  /** The capability id or hand-registered tool name it covered. */
  capabilityId: string;
  /** When it would have run out. ISO 8601 UTC. */
  expiresAt: string;
}

/** What the retired settings said about which standing permissions were honored. */
export interface StandingGrantLicence {
  /** Whether the master switch was on and login was on, so any grant counted. */
  honored: boolean;
  /** Every grant made at or before this instant was void. ISO 8601 UTC. */
  voidBefore: string | null;
}

/** Honors nothing: what an install that never switched the feature on had. */
const NO_LICENCE: StandingGrantLicence = { honored: false, voidBefore: null };

/**
 * Read the retired standing-permission settings straight off `config.json`,
 * before anything removes them (see the module TSDoc).
 *
 * A missing, unreadable or unparseable file, or one without the settings,
 * honors nothing: the feature was off by default, and failing toward "nothing
 * was open" never tells a person a window was open that was not.
 *
 * @param dorkHome - The data directory holding `config.json`.
 * @returns Whether any grant counted, and the void floor.
 */
export function readStandingGrantLicence(dorkHome: string): StandingGrantLicence {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path.join(dorkHome, 'config.json'), 'utf-8'));
  } catch {
    return NO_LICENCE;
  }
  if (!isObject(config) || !isObject(config.approvals)) return NO_LICENCE;
  const loginOn = isObject(config.auth) && config.auth.enabled === true;
  const voidBefore = config.approvals.standingGrantsVoidBefore;
  return {
    honored: config.approvals.standingGrants === true && loginOn,
    voidBefore: typeof voidBefore === 'string' && voidBefore !== '' ? voidBefore : null,
  };
}

/** True for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one captured row, refusing anything that is not the recorded shape. */
function toGrant(value: unknown): EndedStandingGrant | undefined {
  if (!isObject(value)) return undefined;
  const { id, agentPath, capabilityId, expiresAt } = value;
  if (
    typeof id !== 'string' ||
    typeof agentPath !== 'string' ||
    typeof capabilityId !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    return undefined;
  }
  return { id, agentPath, capabilityId, expiresAt };
}

/**
 * Before the Drizzle migrations drop `approval_grants`, write the grants that
 * are still live to a one-shot file under the data directory.
 *
 * Does nothing when the table is already gone (every boot after the first),
 * when the settings honored no grant, or when none is live. Never throws.
 *
 * @param db - The database, before `runMigrations`.
 * @param dorkHome - The data directory the file is written into.
 * @param logger - Where a failure is reported.
 * @param licence - The retired settings, from {@link readStandingGrantLicence}.
 * @param now - The current time, for which grants are still live.
 * @returns How many grants were captured.
 */
export function captureLiveStandingGrants(
  db: Db,
  dorkHome: string,
  logger: Pick<Logger, 'warn'>,
  licence: StandingGrantLicence,
  now: Date = new Date()
): number {
  try {
    if (!licence.honored) return 0;
    const table = db.get<{ name: string } | undefined>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_grants'`
    );
    if (!table) return 0;
    // Timestamps are fixed-width UTC ISO strings, so text order is time order;
    // a grant counted only when made strictly after the floor.
    const floor = licence.voidBefore ?? '';
    const rows = db.all<{
      id: string;
      agent_path: string;
      capability_id: string;
      expires_at: string;
    }>(
      sql`SELECT id, agent_path, capability_id, expires_at FROM approval_grants
          WHERE revoked_at IS NULL AND expires_at > ${now.toISOString()}
            AND granted_at > ${floor}`
    );
    if (rows.length === 0) return 0;
    const grants: EndedStandingGrant[] = rows.map((row) => ({
      id: row.id,
      agentPath: row.agent_path,
      capabilityId: row.capability_id,
      expiresAt: row.expires_at,
    }));
    const file = path.join(dorkHome, ENDED_STANDING_GRANTS_FILE);
    // Merged with anything a previous capture left unconsumed, so two boots
    // that both crashed before the sweep never lose the first one's rows.
    const existing = readCaptured(file);
    const byId = new Map([...existing, ...grants].map((grant) => [grant.id, grant]));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...byId.values()], null, 2), 'utf-8');
    renameSync(tmp, file);
    return grants.length;
  } catch (err) {
    logger.warn('[Permissions] could not record the standing permissions this upgrade ends', {
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** Read a captured file synchronously, tolerating its absence or damage. */
function readCaptured(file: string): EndedStandingGrant[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.flatMap((value) => {
          const grant = toGrant(value);
          return grant ? [grant] : [];
        })
      : [];
  } catch {
    return [];
  }
}

/** Everything {@link recordEndedStandingGrants} reads and writes through. */
export interface EndedStandingGrantsDeps {
  /** The data directory the capture wrote into. */
  dorkHome: string;
  /** The registered agents, to name each grant's agent. */
  agents: () => PermissionAgentRef[];
  /** Names an action id the way the permissions page does. */
  actionTitle: (id: string) => string;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'>;
  /** Where a failure is reported. */
  logger: Pick<Logger, 'warn'>;
}

/**
 * Write one `permission.standing_grant_ended` event per captured grant, then
 * delete the capture file. Runs at every boot the file exists, so an event owed
 * by a crashed boot is still written; the file is deleted only after every event
 * was handed to the Activity writer.
 *
 * @param deps - The data directory, agents, titles, Activity writer and logger.
 * @returns How many events were written.
 */
export async function recordEndedStandingGrants(deps: EndedStandingGrantsDeps): Promise<number> {
  const file = path.join(deps.dorkHome, ENDED_STANDING_GRANTS_FILE);
  const grants = readCaptured(file);
  if (grants.length === 0) {
    await fs.rm(file, { force: true });
    return 0;
  }
  const agents = new Map(deps.agents().map((agent) => [agent.projectPath, agent]));
  for (const grant of grants) {
    const agent = agents.get(grant.agentPath);
    const name = agent ? agent.displayName || agent.name : path.basename(grant.agentPath);
    const title = deps.actionTitle(grant.capabilityId);
    await deps.activity.emit({
      actorType: UPGRADE_WRITER.actorType,
      actorLabel: UPGRADE_WRITER.actorLabel,
      category: 'permissions',
      eventType: STANDING_GRANT_ENDED_EVENT,
      resourceType: agent ? 'agent' : 'permissions',
      resourceId: agent?.id ?? null,
      resourceLabel: name,
      summary: `${name}: the "stop asking" window for ${title} ended. Always allow replaces it.`,
      linkPath: null,
      metadata: {
        agentPath: grant.agentPath,
        action: grant.capabilityId,
        grantId: grant.id,
        wouldHaveExpiredAt: grant.expiresAt,
        surface: 'upgrade',
        attribution: 'upgrade',
        after: null,
      },
    });
  }
  try {
    await fs.rm(file, { force: true });
  } catch (err) {
    deps.logger.warn('[Permissions] could not remove the ended standing permissions file', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return grants.length;
}
