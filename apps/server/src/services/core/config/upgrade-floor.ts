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

/** Onboarding step ids only a pre-0.115 release could have stored. */
const RETIRED_ONBOARDING_STEPS = new Set(['tasks', 'adapters']);

/** True when `value` is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether an unstamped config carries a field that only a pre-0.115 release
 * wrote: one the retired v0.44-v0.56 migrators existed to rename or remove.
 * A missing field proves nothing (a person may write one setting by hand), so
 * only a present legacy field counts.
 *
 * @param config - The parsed config object.
 */
function hasPreFloorShape(config: Record<string, unknown>): boolean {
  if ('sessionSecret' in config) return true;
  const { tunnel, telemetry, onboarding } = config;
  if (
    isRecord(tunnel) &&
    ('passcodeEnabled' in tunnel || 'passcodeHash' in tunnel || 'passcodeSalt' in tunnel)
  ) {
    return true;
  }
  if (isRecord(telemetry) && 'enabled' in telemetry) return true;
  if (isRecord(onboarding)) {
    for (const field of ['completedSteps', 'skippedSteps'] as const) {
      const steps = onboarding[field];
      if (
        Array.isArray(steps) &&
        steps.some((step) => typeof step === 'string' && RETIRED_ONBOARDING_STEPS.has(step))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check an existing file before opening Conf, including its defaults merge.
 *
 * Refuses only a real pre-0.115 stamp, or an unstamped file whose shape only a
 * pre-0.115 release wrote. Any other unstamped file (one written by hand, as
 * the docs suggest, or by the packaged smoke) is current: Conf opens it the way
 * it opens a fresh install and stamps it with this version.
 *
 * The intermediate release itself must still accept earlier configs. Raw dev
 * trees use 0.0.0 rather than a release version and run no release migrations.
 * Neither can establish that a current-release upgrade is taking place.
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
  if (!isRecord(value)) return;
  const internal = (value as { __internal__?: { migrations?: { version?: unknown } } })
    .__internal__;
  const version = internal?.migrations?.version;
  const tooOld =
    version === undefined
      ? hasPreFloorShape(value)
      : typeof version === 'string' &&
        semver.valid(version) !== null &&
        semver.lt(version, MINIMUM_CONFIG_UPGRADE_VERSION);
  if (tooOld) throw new ConfigUpgradeRequiredError(configPath);
}
