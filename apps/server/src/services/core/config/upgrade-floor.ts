/** Refuse unsupported config upgrades before Conf can write defaults. */
import semver from 'semver';
import {
  ConfigBootError,
  ConfigRetiredSettingsError,
  ConfigUnreadableError,
  ConfigVersionUnreadableError,
} from './boot-errors.js';
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

/** Onboarding step ids only a pre-0.115 release could have stored. */
const RETIRED_ONBOARDING_STEPS = new Set(['tasks', 'adapters']);

/** True when `value` is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fields in an unstamped config that only a pre-0.115 release
 * wrote: one the retired v0.44-v0.56 migrators existed to rename or remove.
 * A missing field proves nothing (a person may write one setting by hand), so
 * only a present legacy field counts.
 *
 * @param config - The parsed config object.
 */
function preFloorKeys(config: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if ('sessionSecret' in config) keys.push('sessionSecret');
  const { tunnel, telemetry, onboarding } = config;
  if (isRecord(tunnel)) {
    for (const key of ['passcodeEnabled', 'passcodeHash', 'passcodeSalt']) {
      if (key in tunnel) keys.push(`tunnel.${key}`);
    }
  }
  if (isRecord(telemetry) && 'enabled' in telemetry) keys.push('telemetry.enabled');
  if (isRecord(onboarding)) {
    for (const field of ['completedSteps', 'skippedSteps'] as const) {
      const steps = onboarding[field];
      if (Array.isArray(steps)) {
        for (const step of new Set(steps)) {
          if (typeof step === 'string' && RETIRED_ONBOARDING_STEPS.has(step)) {
            keys.push(`onboarding.${field}: ${JSON.stringify(step)}`);
          }
        }
      }
    }
  }
  return keys;
}

/**
 * Check an existing file before opening Conf, including its defaults merge.
 *
 * Refuses a real pre-0.115 stamp, an unreadable stamp, or an unstamped file
 * carrying retired fields. Any other unstamped file (one written by hand, as
 * the docs suggest, or by the packaged smoke) is current: Conf opens it the way
 * it opens a fresh install and stamps it with this version.
 *
 * The intermediate release itself must still accept earlier configs. Raw dev
 * trees use 0.0.0 rather than a release version and run no release migrations.
 * Neither can establish that a current-release upgrade is taking place.
 * Invalid JSON retains corruption recovery. A present unreadable version must
 * not reach Conf: its recovery would replace the person's settings.
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
  if (!isRecord(value)) return;
  const internal = (value as { __internal__?: { migrations?: { version?: unknown } } })
    .__internal__;
  const version = internal?.migrations?.version;
  if (version === undefined) {
    const keys = preFloorKeys(value);
    if (keys.length > 0) throw new ConfigRetiredSettingsError(configPath, keys);
    return;
  }
  if (typeof version !== 'string' || semver.valid(version) === null) {
    throw new ConfigVersionUnreadableError(configPath);
  }
  if (semver.lt(version, MINIMUM_CONFIG_UPGRADE_VERSION)) {
    throw new ConfigUpgradeRequiredError(configPath);
  }
}
