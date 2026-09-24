/**
 * The boot-time permission upgrade sweep (spec `agent-permissions` D13).
 *
 * Two things an upgrade has to do that a config migration cannot:
 *
 * - **Rewrite agent manifests.** A manifest has no migration mechanism of its
 *   own (`AgentManifestSchema` carries no version), so a file still holding the
 *   retired `enabledToolGroups.roomsManage` is folded on every read but keeps
 *   the old key on disk. The sweep writes the folded manifest back once.
 * - **Record what the upgrade changed.** Config migrations run before the
 *   Activity service exists, so they cannot write the audit event a permission
 *   change owes. The sweep writes it for them.
 *
 * It runs once per server version, after the mesh and Activity services are up,
 * behind the `permissions.upgradeSweptVersion` marker. It is a LIST of steps,
 * each returning the events it produced, so later phases add steps (ended
 * standing grants; the `tierCeiling` and `agentContext` folds) without
 * rewriting it. A step that fails on one agent logs it and moves on: an
 * unreadable manifest must never stop the server from booting.
 *
 * Agents discovered after the sweep are folded on read and written back on
 * their next manifest write, with no extra code.
 *
 * @module services/core/permissions/permission-upgrade-sweep
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { MANIFEST_DIR, MANIFEST_FILE } from '@dorkos/shared/manifest';
import { foldLegacyPermissionFields } from '@dorkos/shared/mesh-schemas';
import type {
  AgentPermissions,
  PermissionConfigInput,
  PermissionState,
} from '@dorkos/shared/permissions';
import type { Logger } from '@dorkos/shared/logger';

import type { ActivityService } from '../../activity/activity-service.js';
import { UPGRADE_WRITER, recordPermissionChange } from './permission-history.js';
import type { PermissionAgentRef } from './permission-service.js';

/** The config section the sweep reads and stamps. */
type PermissionsSection = PermissionConfigInput & { upgradeSweptVersion: string | null };

/** Everything the sweep reads and writes through. */
export interface PermissionUpgradeSweepDeps {
  /** The running server version; the marker is compared against it. */
  version: string;
  /** The `permissions` config section. */
  config: { get: () => PermissionsSection; set: (next: PermissionsSection) => void };
  /** The registered agents. */
  agents: () => PermissionAgentRef[];
  /** Read an agent's manifest file as raw JSON, before any schema. `undefined` = none. */
  readRawManifest: (projectPath: string) => Promise<unknown>;
  /** Write an agent's folded fields back through the manifest write-through. */
  writeFolded: (
    agentId: string,
    fields: { permissions?: AgentPermissions; enabledToolGroups: Record<string, boolean> }
  ) => Promise<void>;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'>;
  /** Where a per-agent failure is reported. */
  logger: Pick<Logger, 'warn' | 'info'>;
}

/** One step of the sweep. Returns how many events it wrote. */
export type PermissionUpgradeStep = (deps: PermissionUpgradeSweepDeps) => Promise<number>;

/** True for a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Step 1: write back every manifest that still carries `roomsManage`, folded,
 * and record one event per agent whose Rooms setting the fold decided.
 */
const foldRoomsManageStep: PermissionUpgradeStep = async (deps) => {
  let events = 0;
  for (const agent of deps.agents()) {
    try {
      const raw = await deps.readRawManifest(agent.projectPath);
      if (!isObject(raw)) continue;
      const groups = raw.enabledToolGroups;
      if (!isObject(groups) || !Object.hasOwn(groups, 'roomsManage')) continue;
      const hadRooms =
        isObject(raw.permissions) &&
        isObject(raw.permissions.areas) &&
        Object.hasOwn(raw.permissions.areas, 'rooms');
      const folded = foldLegacyPermissionFields(raw) as Record<string, unknown>;
      const permissions = folded.permissions as AgentPermissions | undefined;
      await deps.writeFolded(agent.id, {
        ...(permissions ? { permissions } : {}),
        enabledToolGroups: (folded.enabledToolGroups as Record<string, boolean> | undefined) ?? {},
      });
      const rooms = permissions?.areas?.rooms as PermissionState | undefined;
      if (hadRooms || !rooms) continue;
      await recordPermissionChange(deps.activity, {
        changes: [
          {
            target: {
              kind: 'agent',
              agentId: agent.id,
              agentPath: agent.projectPath,
              agentName: agent.displayName || agent.name,
            },
            key: { kind: 'area', area: 'rooms' },
            before: null,
            after: rooms,
          },
        ],
        surface: 'upgrade',
        writer: UPGRADE_WRITER,
      });
      events += 1;
    } catch (err) {
      deps.logger.warn('[Permissions] upgrade could not fold one agent; it is folded on read', {
        agentId: agent.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return events;
};

/**
 * Step 2: record the config migration's effect. Runs only on the first sweep an
 * install ever makes, which is the boot right after that migration set the
 * preset from the first-run answer.
 */
const recordPresetMigrationStep: PermissionUpgradeStep = async (deps) => {
  const config = deps.config.get();
  if (config.upgradeSweptVersion !== null || config.preset === null) return 0;
  await recordPermissionChange(deps.activity, {
    changes: [
      { target: { kind: 'default' }, key: { kind: 'preset' }, before: null, after: config.preset },
    ],
    surface: 'upgrade',
    writer: UPGRADE_WRITER,
  });
  return 1;
};

/** The phase-1 steps, in order. Later phases append theirs. */
const PERMISSION_UPGRADE_STEPS: readonly PermissionUpgradeStep[] = [
  foldRoomsManageStep,
  recordPresetMigrationStep,
];

/**
 * Run the sweep once for this server version.
 *
 * @param deps - The config, agents, manifest I/O, Activity writer and logger.
 * @param steps - The steps to run; the phase-1 list by default.
 * @returns How many events the sweep wrote, or `null` when it had already run.
 */
export async function runPermissionUpgradeSweep(
  deps: PermissionUpgradeSweepDeps,
  steps: readonly PermissionUpgradeStep[] = PERMISSION_UPGRADE_STEPS
): Promise<number | null> {
  if (deps.config.get().upgradeSweptVersion === deps.version) return null;
  let events = 0;
  for (const step of steps) events += await step(deps);
  deps.config.set({ ...deps.config.get(), upgradeSweptVersion: deps.version });
  if (events > 0) deps.logger.info('[Permissions] upgrade recorded permission changes', { events });
  return events;
}

/**
 * Read a manifest file as raw JSON, before any schema: the sweep has to see the
 * retired key the schema folds away. A missing file is `undefined`; anything
 * else that fails throws, and the step logs it.
 *
 * @param projectPath - The agent's project directory.
 */
export async function readRawManifestFile(projectPath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
  return JSON.parse(raw);
}
