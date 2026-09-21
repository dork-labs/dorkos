/**
 * Default Fly, Neon, and Tigris assembly for Community deployment.
 *
 * @module commands/community-deploy/runtime/default-services
 */
import {
  readFlyApps,
  readFlyOrganizations,
  readFlyRegions,
  type FlyAppIdentity,
} from '../fly-read.js';
import { createFlyApp } from '../fly-mutate.js';
import {
  readNeonBranches,
  readNeonBranchTopology,
  readNeonEndpoints,
  readNeonOrganizations,
  readNeonProjects,
  readNeonRegions,
} from '../neon-read.js';
import { createNeonProject } from '../neon-mutate.js';
import { FlyGraphqlClientError, FlyTigrisGraphqlClient } from '../fly-graphql-client.js';
import { verifyTigrisBinding, type TigrisAddOnIdentity } from '../fly-graphql-contract.js';
import {
  readFlySecretInventory,
  readFlySessionCredential,
  verifyTigrisSecretNames,
  type FlySessionReadOptions,
} from '../tigris-session.js';
import type { NeonReadOptions } from '../neon-read.js';
import type { CommunityPreflightInventory, CommunityPreflightSelection } from '../preflight.js';
import type { CommunityCreationDependencies, CreatedResourceIdentity } from '../execute.js';
import type { LaunchJournal } from '../journal.js';
import type { LaunchPlan } from '../plan.js';
import { ProviderMutationError } from '../provider-mutation.js';

/** Local executable and profile settings used by the default service assembly. */
export interface CommunityServiceOptions {
  /** Fly CLI process boundary. */
  fly: FlySessionReadOptions;
  /** Neon CLI process boundary. */
  neon: NeonReadOptions;
  /** Deadline for each Fly GraphQL operation. */
  graphqlTimeoutMs: number;
}

/** Read every inventory used by preflight from the explicitly selected accounts. */
export async function readDefaultCommunityPreflight(
  options: CommunityServiceOptions,
  selection: CommunityPreflightSelection
): Promise<CommunityPreflightInventory> {
  const [flyOrganizations, flyRegions, flyApps, neonOrganizations, neonRegions, neonProjects] =
    await Promise.all([
      readFlyOrganizations(options.fly),
      readFlyRegions(options.fly),
      readFlyApps(options.fly, selection.flyOrganization),
      readNeonOrganizations(options.neon),
      readNeonRegions(options.neon),
      readNeonProjects(options.neon, selection.neonOrganization),
    ]);
  return { flyOrganizations, flyRegions, flyApps, neonOrganizations, neonRegions, neonProjects };
}

async function exactFlyApp(
  options: CommunityServiceOptions,
  organizationSlug: string,
  appId: string,
  appName: string
): Promise<FlyAppIdentity> {
  const matches = (await readFlyApps(options.fly, organizationSlug)).filter(
    (app) => app.id === appId && app.name === appName
  );
  if (matches.length !== 1) throw new ProviderMutationError('INVALID_RESPONSE');
  return matches[0]!;
}

async function exactNeonProject(
  options: CommunityServiceOptions,
  plan: LaunchPlan,
  projectId: string
): Promise<CreatedResourceIdentity> {
  const projects = (await readNeonProjects(options.neon, plan.neon.organizationId)).filter(
    (project) => project.id === projectId && project.name === plan.neon.projectName
  );
  if (projects.length !== 1 || projects[0]?.regionId !== plan.neon.region) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  const branches = (await readNeonBranches(options.neon, projectId)).filter(
    (branch) => branch.isDefault
  );
  if (branches.length !== 1) throw new ProviderMutationError('INVALID_RESPONSE');
  const branch = branches[0]!;
  const topology = await readNeonBranchTopology(options.neon, projectId, branch.id);
  const databases = topology.databases.filter(
    (database) => database.name === 'community' && database.ownerName === 'community_owner'
  );
  const roles = topology.roles.filter((role) => role.name === 'community_owner');
  const endpoints = (await readNeonEndpoints(options.neon, projectId, branch.id)).filter(
    (endpoint) => endpoint.type === 'read_write' && endpoint.regionId === plan.neon.region
  );
  if (databases.length !== 1 || roles.length !== 1 || endpoints.length !== 1) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return {
    id: projectId,
    organizationId: plan.neon.organizationId,
    name: plan.neon.projectName,
    relatedResources: {
      neonBranchId: branch.id,
      neonDatabaseId: databases[0]!.id,
      neonRoleId: roles[0]!.name,
      neonEndpointId: endpoints[0]!.id,
    },
    verifiedBindings: [
      { kind: 'endpoint-to-project', sourceId: endpoints[0]!.id, targetId: projectId },
    ],
  };
}

async function useTigrisClient<T>(
  options: CommunityServiceOptions,
  consumer: (client: FlyTigrisGraphqlClient) => Promise<T>
): Promise<T> {
  const credential = await readFlySessionCredential(options.fly);
  try {
    return await credential.use((token) =>
      consumer(
        new FlyTigrisGraphqlClient({ accessToken: token, timeoutMs: options.graphqlTimeoutMs })
      )
    );
  } finally {
    credential.dispose();
  }
}

function tigrisIdentity(
  identity: TigrisAddOnIdentity,
  plan: LaunchPlan,
  app: FlyAppIdentity
): CreatedResourceIdentity {
  const verified = verifyTigrisBinding(identity, {
    addOnId: identity.addOnId,
    addOnName: plan.tigris.bucketName,
    organizationSlug: plan.fly.organizationId,
    appId: app.id,
    appName: plan.fly.appName,
  });
  return {
    id: verified.addOnId,
    organizationId: verified.organizationSlug,
    name: verified.addOnName,
    bindingId: verified.appId,
  };
}

/** Build exact-ID creation boundaries over the accepted service wrappers. */
export function createDefaultCommunityCreationDependencies(input: {
  options: CommunityServiceOptions;
  plan: LaunchPlan;
  latestJournal(): LaunchJournal;
  persist(journal: LaunchJournal, expectedRevision: number): Promise<void>;
  now(): string;
  confirmTigrisTerms(): Promise<void>;
}): CommunityCreationDependencies {
  const app = async () => {
    const id = input.latestJournal().resources.flyAppId;
    if (!id) throw new ProviderMutationError('INVALID_RESPONSE');
    return exactFlyApp(input.options, input.plan.fly.organizationId, id, input.plan.fly.appName);
  };
  return {
    persist: input.persist,
    now: input.now,
    fly: {
      create: async () => {
        const created = await createFlyApp(
          input.options.fly,
          input.plan.fly.appName,
          input.plan.fly.organizationId
        );
        return {
          id: created.id,
          organizationId: created.organizationSlug,
          name: created.name,
        };
      },
      inspect: async (id) => {
        const found = await exactFlyApp(
          input.options,
          input.plan.fly.organizationId,
          id,
          input.plan.fly.appName
        );
        return { id: found.id, organizationId: found.organizationSlug, name: found.name };
      },
    },
    neon: {
      create: async () => {
        const project = await createNeonProject(input.options.neon, {
          organizationId: input.plan.neon.organizationId,
          name: input.plan.neon.projectName,
          regionId: input.plan.neon.region,
          databaseName: 'community',
          roleName: 'community_owner',
          postgresVersion: 17,
        });
        return exactNeonProject(input.options, input.plan, project.id);
      },
      inspect: (id) => exactNeonProject(input.options, input.plan, id),
    },
    tigris: {
      prepare: async () => {
        const accepted = await useTigrisClient(input.options, (client) =>
          client.hasAcceptedTerms()
        );
        if (!accepted) {
          await input.confirmTigrisTerms();
          const confirmed = await useTigrisClient(input.options, (client) =>
            client.hasAcceptedTerms()
          );
          if (!confirmed) throw new FlyGraphqlClientError('TERMS_NOT_ACCEPTED');
        }
      },
      create: async () => {
        const exactApp = await app();
        const created = await useTigrisClient(input.options, (client) =>
          client.createTigris({
            clientMutationId: input.latestJournal().runId,
            name: input.plan.tigris.bucketName,
            organizationId: input.plan.fly.organizationId,
            appId: exactApp.id,
            primaryRegion: input.plan.fly.region,
          })
        );
        const result = tigrisIdentity(created, input.plan, exactApp);
        verifyTigrisSecretNames(
          await readFlySecretInventory(input.options.fly, input.plan.fly.appName)
        );
        return result;
      },
      inspect: async (id) => {
        const exactApp = await app();
        const found = await useTigrisClient(input.options, (client) => client.readTigris(id));
        const result = tigrisIdentity(found, input.plan, exactApp);
        verifyTigrisSecretNames(
          await readFlySecretInventory(input.options.fly, input.plan.fly.appName)
        );
        return result;
      },
    },
  };
}
