/**
 * Default secret, deploy, and health boundaries for Community launch.
 *
 * @module commands/community-deploy/runtime/default-deploy
 */
import {
  deployFlyImage,
  stageFlySecrets,
  verifyExistingFlyDeployment,
  verifyFlyDeployment,
} from '../fly-mutate.js';
import { readFlyRuntimeInventory } from '../fly-read.js';
import {
  readNeonDirectConnection,
  readNeonEndpoints,
  verifyNeonDirectEndpoint,
} from '../neon-read.js';
import { readFlySecretInventory } from '../tigris-session.js';
import { withCommunityFlyConfig } from '../fly-config.js';
import { verifyCommunityHealth } from '../health.js';
import type { CommunityDeployPhaseDependencies } from '../deploy.js';
import type { CommunityServiceOptions } from './default-services.js';
import type { LaunchJournal } from '../journal.js';
import type { LaunchPlan } from '../plan.js';
import { ProviderMutationError } from '../provider-mutation.js';
import { resolvePlatformImageDigest } from './image-platform.js';

const COMMUNITY_IMAGE_REPOSITORY = 'ghcr.io/dork-labs/dorkos-community';

/**
 * Settle which digest Fly will report for the attested release (DOR-2586): the linux/amd64
 * manifest inside the attested index, read from ghcr.io and accepted only if the index bytes hash
 * to the attested index digest.
 *
 * @param input - The plan and the service bounds.
 * @returns The linux/amd64 manifest digest.
 */
export async function resolveCommunityPlatformDigest(input: {
  plan: LaunchPlan;
  options: CommunityServiceOptions;
  fetch?: typeof fetch;
}): Promise<string> {
  return resolvePlatformImageDigest({
    repository: COMMUNITY_IMAGE_REPOSITORY,
    digest: input.plan.imageDigest,
    timeoutMs: input.options.graphqlTimeoutMs,
    signal: input.options.signal,
    fetch: input.fetch,
  });
}

/** Build the production boundaries used after Fly, Neon, and Tigris creation. */
export function createDefaultCommunityDeployDependencies(input: {
  options: CommunityServiceOptions;
  plan: LaunchPlan;
  latestJournal(): LaunchJournal;
  persist(journal: LaunchJournal, expectedRevision: number): Promise<void>;
  now(): string;
  /** Settles the platform digest Fly will report; see {@link resolveCommunityPlatformDigest}. */
  resolvePlatformDigest(): Promise<string>;
}): CommunityDeployPhaseDependencies {
  return {
    persist: input.persist,
    now: input.now,
    readSecrets: () => readFlySecretInventory(input.options.fly, input.plan.fly.appName),
    useDatabaseUrl: async (consumer) => {
      const resources = input.latestJournal().resources;
      const { neonProjectId, neonBranchId, neonDatabaseId, neonRoleId, neonEndpointId } = resources;
      if (!neonProjectId || !neonBranchId || !neonDatabaseId || !neonRoleId || !neonEndpointId) {
        throw new ProviderMutationError('INVALID_RESPONSE');
      }
      const connection = await readNeonDirectConnection(
        input.options.neon,
        neonProjectId,
        neonBranchId,
        'community',
        neonRoleId
      );
      try {
        const endpoints = await readNeonEndpoints(input.options.neon, neonProjectId, neonBranchId);
        const endpoint = verifyNeonDirectEndpoint(connection, endpoints, input.plan.neon.region);
        if (endpoint.id !== neonEndpointId) throw new ProviderMutationError('INVALID_RESPONSE');
        return await connection.credential.use(consumer);
      } finally {
        connection.credential.dispose();
      }
    },
    stageSecrets: async (values) => {
      await stageFlySecrets(input.options.fly, input.plan.fly.appName, values);
    },
    readRuntime: () => readFlyRuntimeInventory(input.options.fly, input.plan.fly.appName),
    deploy: (digest) =>
      withCommunityFlyConfig(input.plan, async (configPath) => {
        await deployFlyImage(
          input.options.fly,
          input.plan.fly.appName,
          `${COMMUNITY_IMAGE_REPOSITORY}@${digest}`,
          configPath
        );
      }),
    resolvePlatformDigest: input.resolvePlatformDigest,
    verifyNewRuntime: (inventory, previous, platformDigest) =>
      verifyFlyDeployment(inventory, previous, COMMUNITY_IMAGE_REPOSITORY, platformDigest),
    verifyExistingRuntime: (inventory, platformDigest) =>
      verifyExistingFlyDeployment(inventory, COMMUNITY_IMAGE_REPOSITORY, platformDigest),
    verifyHealth: (origin) =>
      verifyCommunityHealth(origin, {
        timeoutMs: 120_000,
        signal: input.options.fly.signal,
      }),
  };
}
