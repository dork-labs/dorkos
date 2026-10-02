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
import { createFlyApp, stageFlySecrets } from '../fly-mutate.js';
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
import {
  verifyTigrisBinding,
  type TigrisAddOnIdentity,
  type TigrisBucketCredentials,
} from '../fly-graphql-contract.js';
import {
  EXPECTED_TIGRIS_SECRET_NAMES,
  readFlySecretInventory,
  readFlySessionCredential,
  TigrisSessionError,
  verifyFreshTigrisSecrets,
  verifyTigrisSecretNames,
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

/** Stop before recording an intent while Fly still holds the name of an app a removal deleted. */
export class FlyNameStillHeldError extends Error {
  /**
   * Create the stop with the exact next step.
   *
   * @param appName - The planned app name.
   */
  constructor(appName: string) {
    super(`Fly is still releasing the name ${appName}. Try \`--resume\` again in a few minutes.`);
    this.name = 'FlyNameStillHeldError';
  }
}

/** Stop before recording an intent while Fly still holds the name of a bucket a removal deleted. */
export class TigrisNameStillHeldError extends Error {
  /**
   * Create the stop with the exact next step.
   *
   * @param bucketName - The planned bucket name.
   */
  constructor(bucketName: string) {
    super(
      `Fly is still releasing the storage name ${bucketName}. Try \`--resume\` again in a few minutes.`
    );
    this.name = 'TigrisNameStillHeldError';
  }
}

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
    ]).catch((error: unknown) =>
      classifyCommunityProviderPreflightFailure('fly', error, {
        env: options.fly.env,
        organization: selection.flyOrganization,
      })
    ),
    Promise.all([
      readNeonOrganizations(options.neon),
      readNeonRegions(options.neon),
      readNeonProjects(options.neon, selection.neonOrganization),
    ]).catch((error: unknown) =>
      classifyCommunityProviderPreflightFailure('neon', error, {
        env: options.neon.env,
        organization: selection.neonOrganization,
      })
    ),
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

/**
 * Run one consumer against the pinned Fly GraphQL client, holding the local Fly session token only
 * for that call.
 *
 * @param options - Local executable and profile settings.
 * @param consumer - Operations to run with the client.
 */
export async function useTigrisClient<T>(
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

/**
 * Stage a bucket's two access keys on the app with the same `secrets import --stage` path as every
 * other app secret, so the first deploy applies them, then drop them from memory.
 */
async function stageTigrisKeys(
  options: CommunityServiceOptions,
  appName: string,
  credentials: TigrisBucketCredentials
): Promise<void> {
  try {
    await credentials.use((values) => stageFlySecrets(options.fly, appName, values));
  } finally {
    credentials.dispose();
  }
}

/**
 * Prove the bucket's two access keys are on the app, fetching them once more if they are not.
 *
 * Fly's servers do not set them when the bucket is created; flyctl does it client-side from the
 * add-on's `environment`, and so does `inspect` below, before anything else. This is the check
 * after that, and the path a resumed launch takes. Keys already there are neither re-read nor
 * re-set. One name without the other is never overwritten: the app then holds a key this launch
 * cannot vouch for. When neither is there, the keys are read once more by exact ID; flyctl never
 * does that, so Fly may return none, and the launch then stops with `MISSING_TIGRIS_SECRETS`, whose
 * recovery text says how to put the keys on the app by hand.
 */
async function ensureTigrisSecrets(
  options: CommunityServiceOptions,
  appName: string,
  addOnId: string
): Promise<void> {
  const before = await readFlySecretInventory(options.fly, appName);
  const present = EXPECTED_TIGRIS_SECRET_NAMES.filter((name) =>
    before.some((item) => item.name === name)
  );
  if (present.length === EXPECTED_TIGRIS_SECRET_NAMES.length) {
    verifyTigrisSecretNames(before);
    return;
  }
  if (present.length > 0) throw new TigrisSessionError('MISSING_TIGRIS_SECRETS');
  const credentials = await useTigrisClient(options, (client) =>
    client.readTigrisCredentials(addOnId)
  );
  if (!credentials) throw new TigrisSessionError('MISSING_TIGRIS_SECRETS');
  await stageTigrisKeys(options, appName, credentials);
  verifyTigrisSecretNames(await readFlySecretInventory(options.fly, appName));
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
  // The keys from the create answer, held only until `inspect` has put them on the app.
  let tigrisCredentials: TigrisBucketCredentials | null = null;
  return {
    persist: input.persist,
    now: input.now,
    progress: input.progress,
    fly: {
      // Runs before any intent is recorded, so a name Fly still holds can never strand the run.
      prepare: async () => {
        const name = input.plan.fly.appName;
        const removed = (input.latestJournal().removals ?? []).some(
          (removal) => removal.provider === 'fly' && removal.resourceName === name
        );
        if (!removed) return;
        const available = await useTigrisClient(input.options, (client) =>
          client.isAppNameAvailable(name)
        );
        if (!available) throw new FlyNameStillHeldError(name);
      },
      create: async (marker) => {
        const created = await createFlyApp(
          input.options.fly,
          input.plan.fly.appName,
          input.plan.fly.organizationId,
          flyProvenanceNetwork(marker),
          (appName) =>
            useTigrisClient(input.options, (client) => client.readAppProvenanceOrNotFound(appName))
        );
        return {
          id: created.id,
          organizationId: created.organizationSlug,
          name: created.name,
        };
      },
      inspect: async (id, context) => {
        const expectedNetwork = context.provenanceMarker
          ? flyProvenanceNetwork(context.provenanceMarker)
          : context.journal.provenance?.flyNetwork;
        // A run started before markers shipped has no network to check and records none. It keeps
        // the listing read it has always used, so a launch already in progress is never re-checked
        // through the newer provenance read.
        if (expectedNetwork === undefined) {
          const listed = await exactFlyApp(
            input.options,
            input.plan.fly.organizationId,
            id,
            input.plan.fly.appName
          );
          return { id: listed.id, organizationId: listed.organizationSlug, name: listed.name };
        }
        const found = await readAppProvenance(input.plan.fly.appName);
        if (
          !found ||
          found.id !== id ||
          found.name !== input.plan.fly.appName ||
          found.organizationSlug !== input.plan.fly.organizationId
        ) {
          throw new ProviderMutationError('INVALID_RESPONSE');
        }
        if (found.network !== expectedNetwork) throw new ProviderMutationError('INVALID_RESPONSE');
        return {
          id: found.id,
          organizationId: found.organizationSlug,
          name: found.name,
          provenance: { flyNetwork: found.network },
        };
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
        // After an uncertain-create removal of a bucket with this name, Fly renames the deleted
        // record and frees the name at once (a by-name lookup answers NOT_FOUND). Check anyway,
        // before any intent is recorded: a create refused because the name is still held would be
        // a new uncertain stop that --remove-uncertain can only answer as absent.
        const bucketName = input.plan.tigris.bucketName;
        const removed = (input.latestJournal().removals ?? []).some(
          (removal) => removal.provider === 'tigris' && removal.resourceName === bucketName
        );
        if (removed) {
          const held = await useTigrisClient(input.options, (client) =>
            client.isTigrisNameHeld(bucketName)
          );
          if (held) throw new TigrisNameStillHeldError(bucketName);
        }
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
        tigrisCredentials?.dispose();
        tigrisCredentials = created.credentials;
        return tigrisIdentity(created.identity, input.plan, exactApp);
      },
      inspect: async (id, context) => {
        // The keys exist only in memory, so they go onto the app first: the bucket id is already
        // in the journal, create() already bound the bucket to this app, and any read below that
        // fails would otherwise lose them for good. A failed stage is not fatal here: the keys may
        // have landed, and the name check below decides.
        const held = tigrisCredentials;
        tigrisCredentials = null;
        if (held) {
          await stageTigrisKeys(input.options, input.plan.fly.appName, held).catch(() => undefined);
        }
        const exactApp = await app();
        const found = await useTigrisClient(input.options, (client) => client.readTigris(id));
        const result = tigrisIdentity(found, input.plan, exactApp);
        await ensureTigrisSecrets(input.options, input.plan.fly.appName, found.addOnId);
        // After an uncertain-create removal of an earlier bucket, its keys were unset and their
        // digests recorded. The keys now on the app must be new ones: a digest equal to a removed
        // bucket's means stale credentials, and the step stops instead of deploying with them.
        const removedDigests = (context.journal.removals ?? []).flatMap((removal) =>
          removal.provider === 'tigris' && removal.priorSecretDigests
            ? [removal.priorSecretDigests]
            : []
        );
        if (removedDigests.length > 0) {
          verifyFreshTigrisSecrets(
            await readFlySecretInventory(input.options.fly, input.plan.fly.appName),
            removedDigests
          );
        }
        return result;
      },
    },
  };
}
