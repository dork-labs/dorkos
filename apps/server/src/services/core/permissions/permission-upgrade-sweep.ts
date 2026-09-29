/**
 * The boot-time permission upgrade (spec `agent-permissions` D13).
 *
 * What an upgrade has to do that a config migration cannot:
 *
 * - **Rewrite agent manifests.** A manifest has no migration mechanism of its
 *   own (`AgentManifestSchema` carries no version), so a file still holding a
 *   retired field (`enabledToolGroups`, `tierCeiling`) is folded on every read
 *   but keeps the old field on disk. {@link runPermissionRetirements} writes the
 *   folded manifest back.
 * - **Retire the global context switches.** `agentContext.*Tools` becomes a
 *   Blocked area default for each switch a person had turned off
 *   ({@link PermissionUpgradeSweepDeps.retireAgentContext}).
 * - **Record what the upgrade changed.** Config migrations run before the
 *   Activity service exists, so they cannot write the audit event a permission
 *   change owes. This module writes it for them.
 *
 * Two kinds of step, run at two cadences:
 *
 * - **Retirements run on every boot** and act only on what is still there to
 *   retire: a manifest still carrying a retired field, a config still carrying
 *   `agentContext`. Keyed on PRESENCE rather than on a version, so an install
 *   that already ran an earlier build at the same version number (the operator's
 *   own dogfood install is always one) is still upgraded, and running twice is a
 *   no-op because the first run removed what it folded.
 * - **Once-per-version steps** ({@link runPermissionUpgradeSweep}) record a
 *   config migration's effect, behind the `permissions.upgradeSweptVersion`
 *   marker.
 *
 * Ended standing permissions are recorded beside these, not in them
 * (`ended-standing-grants.ts`). A step that fails on one agent logs it and moves
 * on: an unreadable manifest must never stop the server from booting.
 *
 * Agents discovered later are folded on read and written back on their next
 * manifest write, with no extra code.
 *
 * @module services/core/permissions/permission-upgrade-sweep
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { MANIFEST_DIR, MANIFEST_FILE } from '@dorkos/shared/manifest';
import { foldLegacyPermissionFields } from '@dorkos/shared/mesh-schemas';
import {
  PERMISSION_AREA_IDS,
  type AgentPermissions,
  type PermissionAreaId,
  type PermissionChange,
  type PermissionConfigInput,
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
  /**
   * Write an agent's folded permissions back through the manifest write-through.
   * The write drops the retired fields: the manifest schema no longer declares
   * them, so the file that comes out of the write-through has none.
   */
  writeFolded: (agentId: string, fields: { permissions?: AgentPermissions }) => Promise<void>;
  /**
   * Fold the retired `agentContext` switches into the permission defaults and
   * remove the section. Returns the areas it set to Blocked (`[]` when every
   * switch was on), or `null` when the config no longer carries the section.
   */
  retireAgentContext?: () => PermissionAreaId[] | null;
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

/** The note an upgrade event carries for an agent that was limited to reading. */
export const OBSERVE_CEILING_NOTE =
  'This agent was limited to reading. Every area is now Blocked for it, but it can still ' +
  'post and react in its conversations, save its own notes, and use its own window.';

/** The raw area map of a manifest's `permissions`, or an empty one. */
function rawAreas(raw: Record<string, unknown>): Record<string, unknown> {
  const permissions = raw.permissions;
  if (!isObject(permissions) || !isObject(permissions.areas)) return {};
  return permissions.areas;
}

/**
 * Write back every manifest that still carries a retired permission field
 * (`enabledToolGroups`, `tierCeiling`), folded, and record one event per agent
 * whose areas the fold decided. Runs on every boot; see the module doc.
 */
const foldLegacyManifestsStep: PermissionUpgradeStep = async (deps) => {
  let events = 0;
  for (const agent of deps.agents()) {
    try {
      const raw = await deps.readRawManifest(agent.projectPath);
      if (!isObject(raw)) continue;
      if (!Object.hasOwn(raw, 'enabledToolGroups') && !Object.hasOwn(raw, 'tierCeiling')) {
        continue;
      }
      const before = rawAreas(raw);
      const folded = foldLegacyPermissionFields(raw) as Record<string, unknown>;
      const permissions = folded.permissions as AgentPermissions | undefined;
      await deps.writeFolded(agent.id, permissions ? { permissions } : {});
      const after = permissions?.areas ?? {};
      const target: PermissionChange['target'] = {
        kind: 'agent',
        agentId: agent.id,
        agentPath: agent.projectPath,
        agentName: agent.displayName || agent.name,
      };
      const changes: PermissionChange[] = PERMISSION_AREA_IDS.filter(
        (area) => Object.hasOwn(after, area) && !Object.hasOwn(before, area)
      ).map((area) => ({
        target,
        key: { kind: 'area', area },
        before: null,
        after: after[area] ?? null,
      }));
      if (changes.length === 0) continue;
      await recordPermissionChange(deps.activity, {
        changes,
        surface: 'upgrade',
        writer: UPGRADE_WRITER,
        ...(raw.tierCeiling === 'observe' ? { note: OBSERVE_CEILING_NOTE } : {}),
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
 * Fold the retired `agentContext` switches into the permission defaults and
 * record the areas that fold Blocked, as one event for everyone. Runs on every
 * boot and does nothing once the section is gone.
 */
const retireAgentContextStep: PermissionUpgradeStep = async (deps) => {
  const blocked = deps.retireAgentContext?.() ?? null;
  if (!blocked || blocked.length === 0) return 0;
  await recordPermissionChange(deps.activity, {
    changes: blocked.map((area) => ({
      target: { kind: 'default' },
      key: { kind: 'area', area },
      before: null,
      after: 'blocked',
    })),
    surface: 'upgrade',
    writer: UPGRADE_WRITER,
  });
  return 1;
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

/** The once-per-version steps, in order. */
const PERMISSION_UPGRADE_STEPS: readonly PermissionUpgradeStep[] = [recordPresetMigrationStep];

/** The retirements, which run on every boot and act only on what is left. */
const PERMISSION_RETIREMENT_STEPS: readonly PermissionUpgradeStep[] = [
  retireAgentContextStep,
  foldLegacyManifestsStep,
];

/**
 * Run the retirements: fold whatever retired permission field is still on disk
 * or in the config, and record what that decided. Safe on every boot.
 *
 * @param deps - The config, agents, manifest I/O, Activity writer and logger.
 * @returns How many events the retirements wrote.
 */
export async function runPermissionRetirements(deps: PermissionUpgradeSweepDeps): Promise<number> {
  let events = 0;
  for (const step of PERMISSION_RETIREMENT_STEPS) events += await step(deps);
  if (events > 0) {
    deps.logger.info('[Permissions] upgrade folded retired permission settings', { events });
  }
  return events;
}

/**
 * Run the once-per-version steps for this server version.
 *
 * @param deps - The config, agents, manifest I/O, Activity writer and logger.
 * @param steps - The steps to run; the production list by default.
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
