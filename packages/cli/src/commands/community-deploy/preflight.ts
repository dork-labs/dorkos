/**
 * Read-only Community launch preflight and immutable plan construction.
 *
 * @module commands/community-deploy/preflight
 */
import type { CompatibleCommunityRelease } from './release-resolver.js';
import type { FlyAppIdentity, FlyOrganization, FlyRegion } from './fly-read.js';
import type { NeonOrganization, NeonProject, NeonRegion } from './neon-read.js';
import { createLaunchPlan, hashLaunchPlan, type LaunchPlan } from './plan.js';

/** Explicit selections supplied by the operator before preflight. */
export interface CommunityPreflightSelection {
  /** Exact Fly organization slug. */
  flyOrganization: string;
  /** Exact Fly region code. */
  flyRegion: string;
  /** Globally unique Fly app name. */
  appName: string;
  /** Fly Machine size selected by the operator. */
  machineSize: string;
  /** Exact Neon organization ID. */
  neonOrganization: string;
  /** Exact Neon region ID. */
  neonRegion: string;
  /** Non-unique Neon project label. */
  neonProjectName: string;
  /** Private Tigris bucket name. */
  bucketName: string;
}

/** Read-only inventories required to construct a launch plan. */
export interface CommunityPreflightInventory {
  /** Authenticated Fly organizations. */
  flyOrganizations: readonly FlyOrganization[];
  /** Fly region capability inventory. */
  flyRegions: readonly FlyRegion[];
  /** Existing apps in the explicitly selected Fly organization. */
  flyApps: readonly FlyAppIdentity[];
  /** Authenticated Neon organizations. */
  neonOrganizations: readonly NeonOrganization[];
  /** Neon region inventory. */
  neonRegions: readonly NeonRegion[];
  /** Existing projects in the explicitly selected Neon organization. */
  neonProjects: readonly NeonProject[];
}

/** One authoritative or explicitly unknown readiness check. */
export interface CommunityReadinessCheck {
  /** Stable check identifier. */
  id:
    | 'fly-app-name'
    | 'fly-role'
    | 'fly-billing'
    | 'fly-quota'
    | 'neon-role'
    | 'neon-billing'
    | 'neon-quota';
  /** Read-only readiness result. */
  status: 'ready' | 'blocked' | 'unknown';
}

/** Complete result rendered before consent or a dry-run exit. */
export interface CommunityPreflightResult {
  /** Immutable non-secret launch plan. */
  plan: LaunchPlan;
  /** Stable hash used by the recovery journal. */
  planHash: string;
  /** Checks that cannot be inferred from names or local authentication. */
  readiness: readonly CommunityReadinessCheck[];
}

/** Exact recorded identities that may explain name collisions during resume. */
export interface CommunityPreflightResume {
  /** Previously journaled Fly app ID, when creation completed. */
  flyAppId?: string;
  /** Previously journaled Neon project ID, when creation completed. */
  neonProjectId?: string;
}

/** Stable preflight rejection with no external response text. */
export class CommunityPreflightError extends Error {
  /** Safe failure classification. */
  readonly code:
    | 'FLY_ORGANIZATION_NOT_FOUND'
    | 'FLY_REGION_UNAVAILABLE'
    | 'FLY_APP_NAME_UNAVAILABLE'
    | 'NEON_ORGANIZATION_NOT_FOUND'
    | 'NEON_REGION_UNAVAILABLE'
    | 'NEON_PROJECT_NAME_AMBIGUOUS'
    | 'RELEASE_PLATFORM_UNSUPPORTED';

  /** Create one secret-free preflight rejection. */
  constructor(code: CommunityPreflightError['code']) {
    super(`Community launch preflight failed (${code})`);
    this.name = 'CommunityPreflightError';
    this.code = code;
  }
}

/**
 * Build a plan only from explicit selections and authoritative read-only inventory.
 *
 * @param release - Verified exact-version Community release.
 * @param selection - Every organization, region, and resource name selected by the operator.
 * @param inventory - Sanitized inventory returned by the read-only service boundaries.
 * @returns Immutable plan, stable hash, and honest readiness classifications.
 */
export function buildCommunityPreflight(
  release: CompatibleCommunityRelease,
  selection: CommunityPreflightSelection,
  inventory: CommunityPreflightInventory,
  resume: CommunityPreflightResume = {}
): CommunityPreflightResult {
  if (
    !release.image.platforms.some(
      ({ os, architecture }) => os === 'linux' && architecture === 'amd64'
    )
  ) {
    throw new CommunityPreflightError('RELEASE_PLATFORM_UNSUPPORTED');
  }

  const flyOrganization = inventory.flyOrganizations.find(
    ({ slug }) => slug === selection.flyOrganization
  );
  if (!flyOrganization) throw new CommunityPreflightError('FLY_ORGANIZATION_NOT_FOUND');
  const flyRegion = inventory.flyRegions.find(({ code }) => code === selection.flyRegion);
  if (!flyRegion || flyRegion.deprecated || !flyRegion.gatewayAvailable) {
    throw new CommunityPreflightError('FLY_REGION_UNAVAILABLE');
  }
  const matchingFlyApps = inventory.flyApps.filter(({ name }) => name === selection.appName);
  if (
    matchingFlyApps.length > 0 &&
    (matchingFlyApps.length !== 1 || matchingFlyApps[0]?.id !== resume.flyAppId)
  ) {
    throw new CommunityPreflightError('FLY_APP_NAME_UNAVAILABLE');
  }

  const neonOrganization = inventory.neonOrganizations.find(
    ({ id }) => id === selection.neonOrganization
  );
  if (!neonOrganization) throw new CommunityPreflightError('NEON_ORGANIZATION_NOT_FOUND');
  const neonRegion = inventory.neonRegions.find(({ id }) => id === selection.neonRegion);
  if (!neonRegion) throw new CommunityPreflightError('NEON_REGION_UNAVAILABLE');
  const matchingNeonProjects = inventory.neonProjects.filter(
    ({ name }) => name === selection.neonProjectName
  );
  if (
    matchingNeonProjects.length > 0 &&
    (matchingNeonProjects.length !== 1 || matchingNeonProjects[0]?.id !== resume.neonProjectId)
  ) {
    throw new CommunityPreflightError('NEON_PROJECT_NAME_AMBIGUOUS');
  }

  const plan = createLaunchPlan({
    dorkosVersion: release.dorkosVersion,
    imageDigest: release.image.digest,
    fly: {
      organizationId: flyOrganization.slug,
      organizationName: flyOrganization.name,
      appName: selection.appName,
      region: flyRegion.code,
      machineSize: selection.machineSize,
    },
    neon: {
      organizationId: neonOrganization.id,
      organizationName: neonOrganization.name,
      projectName: selection.neonProjectName,
      region: neonRegion.id,
    },
    tigris: { bucketName: selection.bucketName, private: true },
  });

  return {
    plan,
    planHash: hashLaunchPlan(plan),
    readiness: [
      { id: 'fly-app-name', status: 'unknown' },
      { id: 'fly-role', status: 'unknown' },
      { id: 'fly-billing', status: 'unknown' },
      { id: 'fly-quota', status: 'unknown' },
      { id: 'neon-role', status: 'unknown' },
      { id: 'neon-billing', status: 'unknown' },
      { id: 'neon-quota', status: 'unknown' },
    ],
  };
}
