/**
 * Default Fly, Neon, and Tigris assembly for Community deployment.
 *
 * @module commands/community-deploy/runtime/default-services
 */
import {
  readFlyApps,
  readFlyOrganizationId,
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
  verifyFreshTigrisSecrets,
  type FlySessionReadOptions,
} from '../tigris-session.js';
import { flyProvenanceNetwork, neonProvenanceRole } from '../provenance/provenance-gate.js';
import type { NeonReadOptions } from '../neon-read.js';
import type { CommunityPreflightInventory, CommunityPreflightSelection } from '../preflight.js';
import type {
  CommunityCreationDependencies,
  CreatedResourceIdentity,
  CreationInspectContext,
} from '../execute.js';
import type { LaunchJournal } from '../journal.js';
import type { LaunchPlan } from '../plan.js';
import { ProviderMutationError } from '../provider-mutation.js';
import { classifyCommunityProviderPreflightFailure } from './versions.js';

/** Local executable and profile settings used by the default service assembly. */
export interface CommunityServiceOptions {
  /** Fly CLI process boundary. */
  fly: FlySessionReadOptions;
  /** Neon CLI process boundary. */
  neon: NeonReadOptions;
  /** Deadline for each Fly GraphQL operation. */
  graphqlTimeoutMs: number;
  /** Operator cancellation shared by the complete guided launch. */
  signal?: AbortSignal;
}

/** Read every inventory used by preflight from the explicitly selected accounts. */
export async function readDefaultCommunityPreflight(
  options: CommunityServiceOptions,
  selection: CommunityPreflightSelection
): Promise<CommunityPreflightInventory> {
  const [flyInventory, neonInventory] = await Promise.all([
    Promise.all([
      readFlyOrganizations(options.fly),
      readFlyRegions(options.fly),
      readFlyApps(options.fly, selection.flyOrganization),
    ]).catch((error: unknown) => classifyCommunityProviderPreflightFailure('fly', error)),
    Promise.all([
      readNeonOrganizations(options.neon),
      readNeonRegions(options.neon),
      readNeonProjects(options.neon, selection.neonOrganization),
    ]).catch((error: unknown) => classifyCommunityProviderPreflightFailure('neon', error)),
  ]);
  const [flyOrganizations, flyRegions, flyApps] = flyInventory;
  const [neonOrganizations, neonRegions, neonProjects] = neonInventory;
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

/**
 * The Neon role a project must carry: the one already journaled, the one this in-flight create
 * named from its marker, or, for a create started before markers shipped, the old fixed role.
 */
function expectedNeonRole(context: CreationInspectContext): string {
  return (
    context.journal.resources.neonRoleId ??
    (context.provenanceMarker ? neonProvenanceRole(context.provenanceMarker) : 'community_owner')
  );
}

async function exactNeonProject(
  options: CommunityServiceOptions,
  plan: LaunchPlan,
  projectId: string,
  roleName: string
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
    (database) => database.name === 'community' && database.ownerName === roleName
  );
  const roles = topology.roles.filter((role) => role.name === roleName);
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
        new FlyTigrisGraphqlClient({
          accessToken: token,
          timeoutMs: options.graphqlTimeoutMs,
          signal: options.signal,
        })
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
  progress?: CommunityCreationDependencies['progress'];
  confirmTigrisTerms(): Promise<void>;
}): CommunityCreationDependencies {
  const app = async () => {
    const id = input.latestJournal().resources.flyAppId;
    if (!id) throw new ProviderMutationError('INVALID_RESPONSE');
    return exactFlyApp(input.options, input.plan.fly.organizationId, id, input.plan.fly.appName);
  };
  // The plan records the Fly organization by slug, as flyctl does; Fly's add-on API wants the
  // organization's GraphQL ID instead, as `fly ext tigris create` sends it.
  let flyOrganizationId: string | undefined;
  const readAppProvenance = (appName: string) =>
    useTigrisClient(input.options, (client) => client.readAppProvenance(appName));
  return {
    persist: input.persist,
    now: input.now,
    progress: input.progress,
    fly: {
      create: async (marker) => {
        const created = await createFlyApp(
          input.options.fly,
          input.plan.fly.appName,
          input.plan.fly.organizationId,
          flyProvenanceNetwork(marker),
          readAppProvenance
        );
        return {
          id: created.id,
          organizationId: created.organizationSlug,
          name: created.name,
        };
      },
      inspect: async (id, context) => {
        const found = await readAppProvenance(input.plan.fly.appName);
        if (
          !found ||
          found.id !== id ||
          found.name !== input.plan.fly.appName ||
          found.organizationSlug !== input.plan.fly.organizationId
        ) {
          throw new ProviderMutationError('INVALID_RESPONSE');
        }
        const identity = { id: found.id, organizationId: found.organizationSlug, name: found.name };
        const expectedNetwork = context.provenanceMarker
          ? flyProvenanceNetwork(context.provenanceMarker)
          : context.journal.provenance?.flyNetwork;
        // A run started before markers shipped has no network to check, and records none.
        if (expectedNetwork === undefined) return identity;
        if (found.network !== expectedNetwork) throw new ProviderMutationError('INVALID_RESPONSE');
        return { ...identity, provenance: { flyNetwork: found.network } };
      },
    },
    neon: {
      create: async (marker) => {
        const project = await createNeonProject(input.options.neon, {
          organizationId: input.plan.neon.organizationId,
          name: input.plan.neon.projectName,
          regionId: input.plan.neon.region,
          databaseName: 'community',
          roleName: neonProvenanceRole(marker),
          postgresVersion: 17,
        });
        return {
          id: project.id,
          organizationId: project.organizationId,
          name: project.name,
        };
      },
      inspect: (id, context) =>
        exactNeonProject(input.options, input.plan, id, expectedNeonRole(context)),
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
        // Resolved before the creation intent is recorded, so a failed read cannot strand one.
        flyOrganizationId = await readFlyOrganizationId(
          input.options.fly,
          input.plan.fly.organizationId
        );
      },
      create: async () => {
        const exactApp = await app();
        const organizationId = (flyOrganizationId ??= await readFlyOrganizationId(
          input.options.fly,
          input.plan.fly.organizationId
        ));
        const created = await useTigrisClient(input.options, (client) =>
          client.createTigris({
            clientMutationId: input.latestJournal().runId,
            name: input.plan.tigris.bucketName,
            organizationId,
            appId: exactApp.id,
            primaryRegion: input.plan.fly.region,
          })
        );
        const result = tigrisIdentity(created, input.plan, exactApp);
        return result;
      },
      inspect: async (id, context) => {
        const exactApp = await app();
        const found = await useTigrisClient(input.options, (client) => client.readTigris(id));
        const result = tigrisIdentity(found, input.plan, exactApp);
        verifyFreshTigrisSecrets(
          await readFlySecretInventory(input.options.fly, input.plan.fly.appName),
          (context.journal.removals ?? []).flatMap((removal) =>
            removal.provider === 'tigris' && removal.priorSecretDigests
              ? [removal.priorSecretDigests]
              : []
          )
        );
        return result;
      },
    },
  };
}
