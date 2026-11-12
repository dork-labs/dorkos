/** Refuse unsupported config upgrades before Conf can write defaults. */
import semver from 'semver';
import { ConfigBootError, ConfigUnreadableError } from './boot-errors.js';
import { readStoredConfigForSalvage } from './salvage-read.js';

/** Oldest release from which a current build can upgrade directly. */
export const MINIMUM_CONFIG_UPGRADE_VERSION = '0.115.0';

/** Encodings retired before every supported release. Refuse, never convert. */
function hasRetiredConfigEncoding(value: object): boolean {
  if ('sessionSecret' in value) return true;
  const tunnel = (value as { tunnel?: unknown }).tunnel;
  if (
    tunnel &&
    typeof tunnel === 'object' &&
    ['passcodeEnabled', 'passcodeHash', 'passcodeSalt'].some((key) => key in tunnel)
  )
    return true;
  const mcp = (value as { mcp?: { apiKey?: unknown } }).mcp;
  // Null and empty are current unset defaults. Never let a surviving global
  // key be silently discarded while removing its retired credential path.
  if (mcp?.apiKey !== undefined && mcp.apiKey !== null && mcp.apiKey !== '') return true;
  const claudeCode = (value as { runtimes?: { claudeCode?: unknown } }).runtimes?.claudeCode;
  if (claudeCode && typeof claudeCode === 'object' && 'activeAccount' in claudeCode) return true;
  const sidebar = (value as { ui?: { sidebar?: unknown } }).ui?.sidebar;
  if (!sidebar || typeof sidebar !== 'object' || Array.isArray(sidebar)) return false;
  const stored = sidebar as Record<string, unknown>;
  const retired = [
    'ungroupedCollapsed',
    'channelsCollapsed',
    'dmsCollapsed',
    'threadsCollapsed',
    'recentsCollapsed',
    'ungroupedSortMode',
    'ungroupedDisplayFilter',
    'groupsHintDismissed',
  ];
  const bare = (list: unknown): boolean =>
    Array.isArray(list) && list.some((item) => typeof item === 'string');
  return (
    retired.some((key) => key in stored) ||
    bare(stored.pinned) ||
    bare(stored.muted) ||
    (Array.isArray(stored.groups) &&
      stored.groups.some(
        (group) =>
          group !== null &&
          typeof group === 'object' &&
          ('agentPaths' in group || bare((group as Record<string, unknown>).items))
      ))
  );
}

/** A readable config needs an intermediate release, not corrupt-file recovery. */
export class ConfigUpgradeRequiredError extends ConfigBootError {
  /**
   * Build the two-step upgrade message.
   * @param configPath - The settings file left untouched.
   */
  constructor(configPath: string) {
    const advice = 'Upgrade to 0.115 first, then upgrade to this version.';
    super(
      `DorkOS cannot upgrade these settings directly.\n${advice}\nYour settings have not been changed.`,
      configPath,
      advice,
      undefined
    );
    this.name = 'ConfigUpgradeRequiredError';
  }
}

/**
 * Check an existing file before opening Conf, including its defaults merge.
 *
 * The intermediate release itself must still accept earlier configs. Raw dev
 * trees use 0.0.0 rather than a release version and run no release migrations.
 * Raw dev still refuses retired sidebar, account and auth encodings: removing converters
 * must not empty memberships, change the billing account or revive an old credential.
 * Other raw-dev files have no release
 * age that this check can establish.
 * Unstamped readable objects need the intermediate release too; their age
 * cannot safely be inferred from which optional fields they happen to carry.
 * Invalid JSON retains corruption recovery. Malformed markers do too unless
 * the file holds a retired encoding.
 *
 * @param configPath - Existing config file to inspect, without changing it.
 * @param projectVersion - The version Conf will use for migration selection.
 * @param retryDelaysMs - The normal config-read retry staircase.
 */
export function assertSupportedConfigUpgrade(
  configPath: string,
  projectVersion: string,
  retryDelaysMs: readonly number[]
): void {
  const releasedUpgrade = semver.gt(projectVersion, MINIMUM_CONFIG_UPGRADE_VERSION);
  if (!releasedUpgrade && projectVersion !== '0.0.0') return;
  const stored = readStoredConfigForSalvage(configPath, retryDelaysMs);
  if (!stored.read) throw new ConfigUnreadableError(configPath, stored.error);
  const value = stored.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  if (hasRetiredConfigEncoding(value)) throw new ConfigUpgradeRequiredError(configPath);
  if (!releasedUpgrade) return;
  const internal = (value as { __internal__?: { migrations?: { version?: unknown } } })
    .__internal__;
  const version = internal?.migrations?.version;
  if (
    version === undefined ||
    (typeof version === 'string' &&
      semver.valid(version) !== null &&
      semver.lt(version, MINIMUM_CONFIG_UPGRADE_VERSION))
  ) {
    throw new ConfigUpgradeRequiredError(configPath);
  }
}
