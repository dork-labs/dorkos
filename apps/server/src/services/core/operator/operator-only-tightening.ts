/**
 * Which writes to a setting only a person may change only turn it down (DOR-3426, Security's
 * direction rule from DOR-3421).
 *
 * At Full a `config_patch` reaching an operator-only setting is refused, because Full asks nobody
 * and the setting is a person's. A write that only switches something off, or back to its
 * strictest value, widens nothing and adds no code, key or reach, so it runs instead, with one
 * Activity line.
 *
 * Decided by the VALUE alone, never by comparing with what is stored: every value in
 * {@link SAFEST_VALUES} is the strictest its setting has, so writing it can only keep or lower
 * what is allowed, whatever was there before. Anything not in the table counts as a raise, which
 * is the safe answer for a leaf nobody classified. Left out on purpose:
 *
 * - `auth.enabled: true`. Turning sign-in on with no account set up could lock the person out.
 * - `permissions.preset`. `config_patch` never writes permissions; `change_permission` does.
 * - Every number (a limit lowered is tighter, but only against what is stored, which this rule
 *   does not read).
 *
 * @module services/core/operator/operator-only-tightening
 */
import { getPermissionArea } from '@dorkos/shared/permissions';
import { findOperatorOnlyPaths, operatorOnlyAreasForPatch } from './config-write-policy.js';
import { OPERATOR_ONLY_STAKES } from './operator-only-stakes.js';
import { OPERATOR_TOOL_AUTHORITY, type ConfigWriteAuthority } from './config-write.js';
import type { GrantedApproval } from '../capabilities/tier-enforcement.js';

/** Each operator-only setting with a strictest value, and that value. */
export const SAFEST_VALUES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  // Who can reach this instance, and how far it reaches.
  ['tunnel.enabled', false],
  ['server.lanAccess', false],
  ['mcp.enabled', false],
  ['mcp.rateLimit.enabled', true],
  ['browser.enabled', false],
  ['computers.enabled', false],
  ['sessionRelay.enabled', false],
  ['spaces.enabled', false],
  ['a2a.enabled', false],
  ['harness.autoSync', false],
  ['harness.autoAdopt', false],
  ['rooms.repo.enabled', false],
  // When agents act on their own.
  ['rooms.turnLimitsEnabled', true],
  ['heartbeats.enabled', false],
  ['heartbeats.triageOnCredits', false],
  ['welcomeBack.enabled', false],
  ['welcomeBack.offersEnabled', false],
  ['docs.enabled', false],
  ['keepAwake.wakeForScheduledTasks', false],
  // Whether the person is asked first: Ask is the strictest stop.
  ['runtimes.defaultTrustStop', 'ask'],
  ['runtimes.claudeCode.defaultTrustStop', 'ask'],
  ['runtimes.codex.defaultTrustStop', 'ask'],
  ['runtimes.opencode.defaultTrustStop', 'ask'],
  ['runtimes.doe.defaultTrustStop', 'ask'],
  // What leaves this machine.
  ['telemetry.install', false],
  ['telemetry.heartbeat', false],
  ['telemetry.errorReporting', false],
  ['telemetry.usage', false],
  ['telemetry.linkAnalyticsToAccount', false],
  ['telemetry.aiMetadata', false],
]);

/** The value a patch writes at a dot path, or `undefined` when it writes none there. */
function valueAt(patch: unknown, path: string): unknown {
  let node: unknown = patch;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Whether a patch writes a setting's strictest value at that setting. */
function writesStrictest(patch: unknown, path: string): boolean {
  return SAFEST_VALUES.has(path) && Object.is(valueAt(patch, path), SAFEST_VALUES.get(path));
}

/**
 * Whether a patch touches at least one operator-only setting and only ever writes each one's
 * strictest value ({@link SAFEST_VALUES}). `false` for a patch that touches none, so a plain
 * preference is never read as a tightening.
 *
 * @param patch - The raw patch a caller supplied (any shape).
 */
export function patchOnlyTightens(patch: unknown): boolean {
  const paths = findOperatorOnlyPaths(patch);
  if (paths.length === 0) return false;
  return paths.every((path) => writesStrictest(patch, path));
}

/**
 * The operator-only settings a patch raises (every one it touches that is not set to its strictest
 * value), each named for a refusal: its key and the permission area it belongs to, e.g.
 * "`tunnel.domain` (Reach & secrets)". Empty when the patch raises none.
 *
 * @param patch - The raw patch a caller supplied (any shape).
 */
export function personSettingsRaised(patch: unknown): string[] {
  return findOperatorOnlyPaths(patch)
    .filter((path) => !writesStrictest(patch, path))
    .map((path) => {
      const area = OPERATOR_ONLY_STAKES.find((group) => group.paths.includes(path))?.area;
      const label = area ? getPermissionArea(area)?.label : undefined;
      return label ? `\`${path}\` (${label})` : `\`${path}\``;
    });
}

/** The patch a `config_patch` input carries. */
const patchOf = (input: unknown): unknown => (input as { patch?: unknown } | undefined)?.patch;

/**
 * `config_patch`'s two input readers for a person's settings: the floor areas a patch reaches
 * (`areasForInput`), and the settings in it that it raises (`personSettingsRaisedForInput`).
 */
export const CONFIG_PATCH_PERSON_SETTINGS = {
  areasForInput: (input: unknown) => operatorOnlyAreasForPatch(patchOf(input)),
  personSettingsRaisedForInput: (input: unknown) => personSettingsRaised(patchOf(input)),
};

/**
 * The authority a `config_patch` the gate let through WITHOUT a person writes under: the tool's
 * own (preferences only), except that a patch the gate allowed at Full because it only turns a
 * person's settings down (`source: 'floor'`, DOR-3426) may write those, and only those. The patch
 * is checked again here rather than trusted from the gate, so a looser value is refused as before.
 *
 * @param patch - The patch being written.
 * @param approval - What the gate granted, if anything.
 */
export function unattendedConfigAuthority(
  patch: unknown,
  approval: GrantedApproval | undefined
): ConfigWriteAuthority {
  if (approval?.via !== 'permission' || approval.source !== 'floor' || !patchOnlyTightens(patch)) {
    return OPERATOR_TOOL_AUTHORITY;
  }
  return {
    refuseOperatorOnly: (paths) =>
      paths.every((path) => writesStrictest(patch, path))
        ? undefined
        : OPERATOR_TOOL_AUTHORITY.refuseOperatorOnly(paths),
  };
}
