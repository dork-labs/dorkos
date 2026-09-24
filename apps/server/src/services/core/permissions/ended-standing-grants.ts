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
 * Does nothing when the table is already gone (every boot after the first) or
 * holds no live grant. Never throws.
 *
 * @param db - The database, before `runMigrations`.
 * @param dorkHome - The data directory the file is written into.
 * @param logger - Where a failure is reported.
 * @param now - The current time, for which grants are still live.
 * @returns How many grants were captured.
 */
export function captureLiveStandingGrants(
  db: Db,
  dorkHome: string,
  logger: Pick<Logger, 'warn'>,
  now: Date = new Date()
): number {
  try {
    const table = db.get<{ name: string } | undefined>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_grants'`
    );
    if (!table) return 0;
    const rows = db.all<{
      id: string;
      agent_path: string;
      capability_id: string;
      expires_at: string;
    }>(
      sql`SELECT id, agent_path, capability_id, expires_at FROM approval_grants
          WHERE revoked_at IS NULL AND expires_at > ${now.toISOString()}`
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
