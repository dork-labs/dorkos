/** Refuse unsupported config upgrades before Conf can write defaults. */
import semver from 'semver';
import { ConfigBootError, ConfigUnreadableError } from './boot-errors.js';
import { readStoredConfigForSalvage } from './salvage-read.js';

/** Oldest release from which a current build can upgrade directly. */
export const MINIMUM_CONFIG_UPGRADE_VERSION = '0.115.0';

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
 * Neither can establish that a current-release upgrade is taking place.
 * Unstamped readable objects need the intermediate release too; their age
 * cannot safely be inferred from which optional fields they happen to carry.
 * Invalid JSON and malformed markers retain the existing corruption recovery.
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
  if (!semver.gt(projectVersion, MINIMUM_CONFIG_UPGRADE_VERSION)) return;
  const stored = readStoredConfigForSalvage(configPath, retryDelaysMs);
  if (!stored.read) throw new ConfigUnreadableError(configPath, stored.error);
  const value = stored.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
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
