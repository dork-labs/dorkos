/**
 * Fail-closed configuration for the credentialed Community release gate.
 *
 * This module contains no process or network boundary so its refusal behavior can be tested
 * without touching a provider.
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const ENABLED = '1';
const CHARGE_ACKNOWLEDGEMENT = 'I ACCEPT THROWAWAY PROVIDER CHARGES';
const IdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u);
const RegionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);

/** The `=1` arms. Each is a separate decision to let the gate write, or clean up, somewhere. */
export const COMMUNITY_LIVE_GATE_ARMS = [
  'DORKOS_COMMUNITY_LIVE_GATE',
  'DORKOS_COMMUNITY_LIVE_FLY_WRITES',
  'DORKOS_COMMUNITY_LIVE_NEON_WRITES',
  'DORKOS_COMMUNITY_LIVE_TIGRIS_WRITES',
  'DORKOS_COMMUNITY_LIVE_CLEANUP',
] as const;

/** Must hold the exact charge-acknowledgement phrase, not merely be set. */
export const COMMUNITY_LIVE_GATE_CHARGE_ACKNOWLEDGEMENT_ENV =
  'DORKOS_COMMUNITY_LIVE_CHARGE_ACKNOWLEDGEMENT';

/** The non-secret choices for one run, keyed by the config field each one fills. */
const SETTINGS_ENV = {
  version: 'DORKOS_COMMUNITY_LIVE_VERSION',
  flyOrganization: 'DORKOS_COMMUNITY_LIVE_FLY_ORG',
  flyRegion: 'DORKOS_COMMUNITY_LIVE_FLY_REGION',
  neonOrganization: 'DORKOS_COMMUNITY_LIVE_NEON_ORG',
  neonRegion: 'DORKOS_COMMUNITY_LIVE_NEON_REGION',
  budgetUsd: 'DORKOS_COMMUNITY_LIVE_BUDGET_USD',
} as const;

/**
 * An unreleased package to test instead of a published version: the absolute path of a `.tgz`
 * that `pnpm --filter dorkos pack:community-live` wrote, beside its provenance sidecar. Exactly one
 * of this and {@link SETTINGS_ENV}.version must be set. It lets a fix be tried against the real
 * services before anything is published, and the receipt says the run was not a release.
 */
export const COMMUNITY_LIVE_GATE_TARBALL_ENV = 'DORKOS_COMMUNITY_LIVE_PACKAGE_TARBALL';

/**
 * Every environment name the gate requires in its default, published-release mode. Built from the
 * same constants {@link parseCommunityLiveGateConfig} reads, so the list and the parser cannot
 * disagree. {@link COMMUNITY_LIVE_GATE_TARBALL_ENV} can stand in for the version.
 */
export const COMMUNITY_LIVE_GATE_ENV = [
  ...COMMUNITY_LIVE_GATE_ARMS,
  COMMUNITY_LIVE_GATE_CHARGE_ACKNOWLEDGEMENT_ENV,
  ...Object.values(SETTINGS_ENV),
] as const;

/**
 * Optional: keep the finished community alive for this many whole minutes, from 1 to
 * {@link COMMUNITY_LIVE_GATE_MAX_HOLD_MINUTES}, so an attended run can drive it (the two-Desktop
 * driver's remote mode) before cleanup. Unset means no hold. A hold keeps one small Machine and one
 * Neon endpoint running, so its ceiling is fixed here rather than trusted to the operator, and any
 * other value is refused with every other arm, before a process starts.
 */
export const COMMUNITY_LIVE_GATE_HOLD_ENV = 'DORKOS_COMMUNITY_LIVE_HOLD_MINUTES';

/** The longest hold the gate accepts, in minutes. */
export const COMMUNITY_LIVE_GATE_MAX_HOLD_MINUTES = 45;

/** Every name the gate reads, and so every name that must never reach an ordinary task. */
export const COMMUNITY_LIVE_GATE_ALL_ENV = [
  ...COMMUNITY_LIVE_GATE_ENV,
  COMMUNITY_LIVE_GATE_TARBALL_ENV,
  COMMUNITY_LIVE_GATE_HOLD_ENV,
] as const;

/** Where the launcher under test comes from. */
export type CommunityLiveGateSource =
  /** An exact version published on npm. */
  | { kind: 'release'; version: string }
  /** A local, unreleased package tarball; its version is read from the tarball itself. */
  | { kind: 'tarball'; path: string };

/** Validated, non-secret choices for one disposable live run. */
export interface CommunityLiveGateConfig {
  /** The published version, or the unreleased tarball, whose launcher the run installs. */
  source: CommunityLiveGateSource;
  /** Explicitly designated Fly test organization slug. */
  flyOrganization: string;
  /** Explicit Fly Machine region. */
  flyRegion: string;
  /** Explicitly designated Neon test organization id. */
  neonOrganization: string;
  /** Explicit Neon project region. */
  neonRegion: string;
  /** Operator-approved provider spend ceiling recorded in the receipt. */
  budgetUsd: number;
  /** Minutes to hold the finished community before cleanup, or null for no hold. */
  holdMinutes: number | null;
}

/**
 * Build a recovery command that survives deletion of the disposable package install.
 *
 * @param version - The published version, used when no tarball is given.
 * @param args - The launch's own arguments.
 * @param runId - The run to resume.
 * @param dorkHome - The retained data directory holding its journal.
 * @param tarballPath - For an unreleased run, the tarball it installed; it must stay in place.
 */
export function communityLiveGateRecoveryCommand(
  version: string,
  args: readonly string[],
  runId: string,
  dorkHome: string,
  tarballPath?: string
): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const packageArgs =
    tarballPath === undefined
      ? quote(`dorkos@${version}`)
      : `--package ${quote(tarballPath)} dorkos`;
  return `DORK_HOME=${quote(dorkHome)} npx --yes ${packageArgs} community deploy ${args.map(quote).join(' ')} --resume ${quote(runId)}`;
}

/** Whether a value can name the tarball: an absolute `.tgz` path with no control characters. */
function isTarballPath(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length <= 4096 &&
    isAbsolute(value) &&
    value.endsWith('.tgz') &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}

/** Refusal raised before the release gate is allowed to cross a process boundary. */
export class CommunityLiveGateNotArmedError extends Error {
  /** Missing or invalid non-secret environment names. */
  readonly fields: readonly string[];

  /** Create a stable, credential-free refusal. */
  constructor(fields: readonly string[]) {
    // The hold is the one optional name, so a refusal of it says what it accepts.
    const holdRange = fields.includes(COMMUNITY_LIVE_GATE_HOLD_ENV)
      ? `; ${COMMUNITY_LIVE_GATE_HOLD_ENV} must be a whole number of minutes from 1 to ${COMMUNITY_LIVE_GATE_MAX_HOLD_MINUTES}, or unset`
      : '';
    super(`Community live gate is not armed (${fields.join(', ')})${holdRange}`);
    this.name = 'CommunityLiveGateNotArmedError';
    this.fields = fields;
  }
}

/**
 * Validate every write arm and designated account before any executable, network, or profile read.
 */
export function parseCommunityLiveGateConfig(
  environment: Readonly<Record<string, string | undefined>>
): CommunityLiveGateConfig {
  const invalid: string[] = [];
  for (const name of COMMUNITY_LIVE_GATE_ARMS) {
    if (environment[name] !== ENABLED) invalid.push(name);
  }
  if (environment[COMMUNITY_LIVE_GATE_CHARGE_ACKNOWLEDGEMENT_ENV] !== CHARGE_ACKNOWLEDGEMENT) {
    invalid.push(COMMUNITY_LIVE_GATE_CHARGE_ACKNOWLEDGEMENT_ENV);
  }

  // Exactly one source: a published version or an unreleased tarball, never both and never none.
  const rawVersion = environment[SETTINGS_ENV.version];
  const rawTarball = environment[COMMUNITY_LIVE_GATE_TARBALL_ENV];
  const version = VersionSchema.safeParse(rawVersion);
  let source: CommunityLiveGateSource | null = null;
  if (rawVersion !== undefined && rawTarball !== undefined) {
    invalid.push(SETTINGS_ENV.version, COMMUNITY_LIVE_GATE_TARBALL_ENV);
  } else if (rawTarball !== undefined) {
    if (isTarballPath(rawTarball)) source = { kind: 'tarball', path: rawTarball };
    else invalid.push(COMMUNITY_LIVE_GATE_TARBALL_ENV);
  } else if (rawVersion === undefined) {
    invalid.push(SETTINGS_ENV.version, COMMUNITY_LIVE_GATE_TARBALL_ENV);
  } else if (version.success) {
    source = { kind: 'release', version: version.data };
  } else {
    invalid.push(SETTINGS_ENV.version);
  }
  const flyOrganization = IdentifierSchema.safeParse(environment[SETTINGS_ENV.flyOrganization]);
  const flyRegion = RegionSchema.safeParse(environment[SETTINGS_ENV.flyRegion]);
  const neonOrganization = IdentifierSchema.safeParse(environment[SETTINGS_ENV.neonOrganization]);
  const neonRegion = RegionSchema.safeParse(environment[SETTINGS_ENV.neonRegion]);
  if (!flyOrganization.success) invalid.push(SETTINGS_ENV.flyOrganization);
  if (!flyRegion.success) invalid.push(SETTINGS_ENV.flyRegion);
  if (!neonOrganization.success) invalid.push(SETTINGS_ENV.neonOrganization);
  if (!neonRegion.success) invalid.push(SETTINGS_ENV.neonRegion);

  const budgetUsd = Number(environment[SETTINGS_ENV.budgetUsd]);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 25) {
    invalid.push(SETTINGS_ENV.budgetUsd);
  }
  // Digits only, so `1.5`, `1e1`, ` 5`, `0x10` and `-1` are refused rather than coerced.
  const rawHold = environment[COMMUNITY_LIVE_GATE_HOLD_ENV];
  const holdMinutes =
    rawHold === undefined ? null : /^\d{1,2}$/u.test(rawHold) ? Number(rawHold) : NaN;
  if (
    holdMinutes !== null &&
    !(holdMinutes >= 1 && holdMinutes <= COMMUNITY_LIVE_GATE_MAX_HOLD_MINUTES)
  ) {
    invalid.push(COMMUNITY_LIVE_GATE_HOLD_ENV);
  }
  if (
    invalid.length > 0 ||
    source === null ||
    !flyOrganization.success ||
    !flyRegion.success ||
    !neonOrganization.success ||
    !neonRegion.success
  )
    throw new CommunityLiveGateNotArmedError([...new Set(invalid)]);

  return {
    source,
    flyOrganization: flyOrganization.data,
    flyRegion: flyRegion.data,
    neonOrganization: neonOrganization.data,
    neonRegion: neonRegion.data,
    budgetUsd,
    holdMinutes,
  };
}
