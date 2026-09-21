/**
 * Fail-closed configuration for the credentialed Community release gate.
 *
 * This module contains no process or network boundary so its refusal behavior can be tested
 * without touching a provider.
 */
import { z } from 'zod';

const ENABLED = '1';
const CHARGE_ACKNOWLEDGEMENT = 'I ACCEPT THROWAWAY PROVIDER CHARGES';
const IdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u);
const RegionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);

/** Environment names that must never be passed to ordinary test or CI tasks. */
export const COMMUNITY_LIVE_GATE_ENV = [
  'DORKOS_COMMUNITY_LIVE_GATE',
  'DORKOS_COMMUNITY_LIVE_FLY_WRITES',
  'DORKOS_COMMUNITY_LIVE_NEON_WRITES',
  'DORKOS_COMMUNITY_LIVE_TIGRIS_WRITES',
  'DORKOS_COMMUNITY_LIVE_CLEANUP',
  'DORKOS_COMMUNITY_LIVE_CHARGE_ACKNOWLEDGEMENT',
  'DORKOS_COMMUNITY_LIVE_BUDGET_USD',
  'DORKOS_COMMUNITY_LIVE_VERSION',
  'DORKOS_COMMUNITY_LIVE_FLY_ORG',
  'DORKOS_COMMUNITY_LIVE_FLY_REGION',
  'DORKOS_COMMUNITY_LIVE_NEON_ORG',
  'DORKOS_COMMUNITY_LIVE_NEON_REGION',
] as const;

/** Validated, non-secret choices for one disposable live run. */
export interface CommunityLiveGateConfig {
  /** Exact published DorkOS version. */
  version: string;
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
}

/** Build a recovery command that survives deletion of the disposable package install. */
export function communityLiveGateRecoveryCommand(
  version: string,
  args: readonly string[],
  runId: string,
  dorkHome: string
): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `DORK_HOME=${quote(dorkHome)} npx --yes ${quote(`dorkos@${version}`)} community deploy ${args.map(quote).join(' ')} --resume ${quote(runId)}`;
}

/** Refusal raised before the release gate is allowed to cross a process boundary. */
export class CommunityLiveGateNotArmedError extends Error {
  /** Missing or invalid non-secret environment names. */
  readonly fields: readonly string[];

  /** Create a stable, credential-free refusal. */
  constructor(fields: readonly string[]) {
    super(`Community live gate is not armed (${fields.join(', ')})`);
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
  for (const name of [
    'DORKOS_COMMUNITY_LIVE_GATE',
    'DORKOS_COMMUNITY_LIVE_FLY_WRITES',
    'DORKOS_COMMUNITY_LIVE_NEON_WRITES',
    'DORKOS_COMMUNITY_LIVE_TIGRIS_WRITES',
    'DORKOS_COMMUNITY_LIVE_CLEANUP',
  ] as const) {
    if (environment[name] !== ENABLED) invalid.push(name);
  }
  if (environment.DORKOS_COMMUNITY_LIVE_CHARGE_ACKNOWLEDGEMENT !== CHARGE_ACKNOWLEDGEMENT) {
    invalid.push('DORKOS_COMMUNITY_LIVE_CHARGE_ACKNOWLEDGEMENT');
  }

  const version = VersionSchema.safeParse(environment.DORKOS_COMMUNITY_LIVE_VERSION);
  const flyOrganization = IdentifierSchema.safeParse(environment.DORKOS_COMMUNITY_LIVE_FLY_ORG);
  const flyRegion = RegionSchema.safeParse(environment.DORKOS_COMMUNITY_LIVE_FLY_REGION);
  const neonOrganization = IdentifierSchema.safeParse(environment.DORKOS_COMMUNITY_LIVE_NEON_ORG);
  const neonRegion = RegionSchema.safeParse(environment.DORKOS_COMMUNITY_LIVE_NEON_REGION);
  if (!version.success) invalid.push('DORKOS_COMMUNITY_LIVE_VERSION');
  if (!flyOrganization.success) invalid.push('DORKOS_COMMUNITY_LIVE_FLY_ORG');
  if (!flyRegion.success) invalid.push('DORKOS_COMMUNITY_LIVE_FLY_REGION');
  if (!neonOrganization.success) invalid.push('DORKOS_COMMUNITY_LIVE_NEON_ORG');
  if (!neonRegion.success) invalid.push('DORKOS_COMMUNITY_LIVE_NEON_REGION');

  const budgetUsd = Number(environment.DORKOS_COMMUNITY_LIVE_BUDGET_USD);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 25) {
    invalid.push('DORKOS_COMMUNITY_LIVE_BUDGET_USD');
  }
  if (
    invalid.length > 0 ||
    !version.success ||
    !flyOrganization.success ||
    !flyRegion.success ||
    !neonOrganization.success ||
    !neonRegion.success
  )
    throw new CommunityLiveGateNotArmedError([...new Set(invalid)]);

  return {
    version: version.data,
    flyOrganization: flyOrganization.data,
    flyRegion: flyRegion.data,
    neonOrganization: neonOrganization.data,
    neonRegion: neonRegion.data,
    budgetUsd,
  };
}
