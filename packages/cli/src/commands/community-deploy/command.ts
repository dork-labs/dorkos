/**
 * Pure command orchestration for guided Community deployment.
 *
 * @module commands/community-deploy/command
 */
import type { CompatibleCommunityRelease } from './release-resolver.js';
import {
  buildCommunityPreflight,
  type CommunityPreflightInventory,
  type CommunityPreflightResult,
  type CommunityPreflightResume,
  type CommunityPreflightSelection,
} from './preflight.js';

/** Parsed deploy request, independent of the top-level CLI process. */
export interface CommunityDeployRequest {
  /** Exact release version; mutable tags and fallback versions are excluded. */
  version: string;
  /** Explicit plan selections. */
  selection: CommunityPreflightSelection;
  /** Stop after the same release and read-only planning path. */
  dryRun: boolean;
  /** Exact journal identities allowed to explain name collisions during resume. */
  resume?: CommunityPreflightResume;
}

/** Side-effect boundaries used by the command after local argument parsing. */
export interface CommunityDeployDependencies {
  /** Resolve and attest exactly the requested release without service writes. */
  resolveRelease(version: string): Promise<CompatibleCommunityRelease>;
  /** Read the inventories needed for planning without service writes. */
  readPreflight(selection: CommunityPreflightSelection): Promise<CommunityPreflightInventory>;
  /** Render the complete non-secret plan before consent. */
  renderPreflight(result: CommunityPreflightResult): void;
  /** Require exact typed approval for the first write. */
  consent(appName: string): Promise<void>;
  /** Execute or resume the journaled state machine after consent. */
  execute(result: CommunityPreflightResult): Promise<void>;
}

/**
 * Resolve, inspect, and render one plan before dry-run exit or typed consent.
 *
 * @param request - Exact version, selections, and dry-run choice.
 * @param dependencies - Release, inventory, consent, and execution boundaries.
 * @returns The immutable result used for rendering and journal identity.
 */
export async function runCommunityDeploy(
  request: CommunityDeployRequest,
  dependencies: CommunityDeployDependencies
): Promise<CommunityPreflightResult> {
  const release = await dependencies.resolveRelease(request.version);
  const inventory = await dependencies.readPreflight(request.selection);
  const result = buildCommunityPreflight(release, request.selection, inventory, request.resume);
  dependencies.renderPreflight(result);
  if (request.dryRun) return result;
  await dependencies.consent(result.plan.fly.appName);
  await dependencies.execute(result);
  return result;
}

/** Render a concise plan without credentials or secret-bearing URLs. */
export function formatCommunityPreflight(result: CommunityPreflightResult): string {
  const { plan } = result;
  const digest = `${plan.imageDigest.slice(0, 15)}…${plan.imageDigest.slice(-8)}`;
  const readiness = result.readiness.map(({ id, status }) => `  ${id}: ${status}`).join('\n');
  return [
    `DorkOS Community ${plan.dorkosVersion} (${digest})`,
    `Fly: ${plan.fly.appName} in ${plan.fly.organizationName} [${plan.fly.organizationId}], ${plan.fly.region}, one ${plan.fly.machineSize} Machine`,
    `Neon: ${plan.neon.projectName} in ${plan.neon.organizationName} [${plan.neon.organizationId}], ${plan.neon.region}, direct TLS`,
    `Tigris: ${plan.tigris.bucketName}, private`,
    `Plan: ${result.planHash}`,
    'Readiness:',
    readiness,
    `Billing: creating resources may add charges to Fly organization ${plan.fly.organizationName} and Neon organization ${plan.neon.organizationName}; Tigris charges belong to the selected Fly organization.`,
    'Review provider billing before consent: https://fly.io/docs/about/pricing/ and https://neon.com/pricing',
    'Resources are retained if setup stops; resume from the launch journal.',
  ].join('\n');
}
