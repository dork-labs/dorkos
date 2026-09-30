/**
 * Fly, Neon and Tigris probes for removing an uncertain launch create's leftover resource.
 *
 * Each probe reads only the run's own organization, through the same wrappers the launch uses.
 * Fly reads hold the local Fly session token in memory for one request; Neon uses the local
 * `neonctl` profile. No token reaches argv, the environment, the journal or the output.
 *
 * @module commands/community-deploy/runtime/default-removal
 */
import { readFlyApps } from '../fly-read.js';
import { destroyFlyApp, unsetFlyTigrisSecrets } from '../fly-mutate.js';
import { readNeonBranches, readNeonBranchTopology, readNeonProjects } from '../neon-read.js';
import { deleteNeonProject } from '../neon-mutate.js';
import { readFlySecretInventory } from '../tigris-session.js';
import { ProviderMutationError } from '../provider-mutation.js';
import type {
  NeonProjectFacts,
  RemovalProvider,
  RemovalTarget,
  UncertainResourceProbe,
} from '../provenance/uncertain-removal.js';
import { useTigrisClient, type CommunityServiceOptions } from './default-services.js';

const TIGRIS_SECRET_NAMES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

/**
 * Fly answers an unknown app name with `app: null`, and a server error can null the field the same
 * way. So a missing app counts as absent only when an independent read, the organization's app
 * listing, also lacks the name. A listing that still has it means the two reads disagree.
 */
async function confirmFlyNameUnlisted(
  options: CommunityServiceOptions,
  organization: string,
  appName: string
): Promise<void> {
  const listed = await readFlyApps(options.fly, organization);
  if (listed.some((app) => app.name === appName)) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
}

function flyProbe(options: CommunityServiceOptions): UncertainResourceProbe {
  const readApp = (name: string) =>
    useTigrisClient(options, (client) => client.readAppProvenance(name));
  return {
    find: async (intent) => {
      const app = await readApp(intent.resourceName);
      if (app === null) {
        await confirmFlyNameUnlisted(options, intent.organizationId, intent.resourceName);
        return { kind: 'absent' };
      }
      // An app with this name in another organization belongs to someone else; it is not read
      // further and never offered for removal.
      if (app.organizationSlug !== intent.organizationId) return { kind: 'absent' };
      return {
        kind: 'fly',
        app: {
          token: app.internalNumericId,
          name: app.name,
          organization: app.organizationSlug,
          network: app.network,
          createdAt: app.createdAt,
          machines: app.machineCount,
          volumes: app.volumeCount,
          ipAddresses: app.ipAddressCount,
          certificates: app.certificateCount,
          secretNames: app.secretNames,
        },
      };
    },
    remove: async (target) => void (await destroyFlyApp(options.fly, target.resourceName)),
    isGone: async (target) => {
      const app = await readApp(target.resourceName);
      if (app === null) {
        await confirmFlyNameUnlisted(options, target.organization, target.resourceName);
        return true;
      }
      // A different internal id under the same name is a newer app; the removed one is gone.
      return app.internalNumericId !== target.token;
    },
    isNameReleased: (target) =>
      useTigrisClient(options, (client) => client.isAppNameAvailable(target.resourceName)),
  };
}

function neonProbe(options: CommunityServiceOptions): UncertainResourceProbe {
  return {
    find: async (intent) => {
      const named = (await readNeonProjects(options.neon, intent.organizationId)).filter(
        (project) => project.name === intent.resourceName
      );
      if (named.length === 0) return { kind: 'absent' };
      const projects: NeonProjectFacts[] = [];
      for (const project of named) {
        const branches = await readNeonBranches(options.neon, project.id);
        const defaults = branches.filter((branch) => branch.isDefault);
        const topology =
          defaults.length === 1
            ? await readNeonBranchTopology(options.neon, project.id, defaults[0]!.id)
            : { roles: [], databases: [] };
        projects.push({
          token: project.id,
          name: project.name,
          organization: project.organizationId,
          region: project.regionId,
          ...(project.createdAt === undefined ? {} : { createdAt: project.createdAt }),
          branchCount: branches.length,
          defaultBranchCount: defaults.length,
          roles: topology.roles.map((role) => role.name),
          databases: topology.databases.map((database) => database.name),
        });
      }
      return { kind: 'neon', projects };
    },
    remove: async (target) => void (await deleteNeonProject(options.neon, target.token)),
    // A full listing of the organization: an empty answer is a real one, a failed read throws.
    isGone: async (target) =>
      !(await readNeonProjects(options.neon, target.organization)).some(
        (project) => project.id === target.token
      ),
  };
}

async function tigrisSecretNames(options: CommunityServiceOptions, target: RemovalTarget) {
  return readFlySecretInventory(options.fly, target.appName);
}

function tigrisProbe(options: CommunityServiceOptions): UncertainResourceProbe {
  const readOnApp = (appName: string) =>
    useTigrisClient(options, (client) => client.readTigrisOnApp(appName));
  return {
    find: async (_intent, journal) => {
      const appName = journal.recoveryContext?.appName;
      if (!appName) throw new ProviderMutationError('INVALID_INPUT');
      const found = await readOnApp(appName);
      return {
        kind: 'tigris',
        facts:
          found === null
            ? null
            : {
                app: {
                  name: found.name,
                  organization: found.organizationSlug,
                  network: found.network,
                },
                totalCount: found.totalCount,
                addOns: found.addOns.map((addOn) => ({
                  token: addOn.id,
                  name: addOn.name,
                  organization: addOn.organizationSlug,
                  createdAt: addOn.createdAt,
                })),
              },
      };
    },
    remove: async (target) =>
      void (await useTigrisClient(options, (client) => client.deleteTigris(target.resourceName))),
    isGone: async (target) => {
      const found = await readOnApp(target.appName);
      // Without the app, or with a list cut short, absence cannot be read.
      if (found === null || found.totalCount !== found.addOns.length) {
        throw new ProviderMutationError('INVALID_RESPONSE');
      }
      return !found.addOns.some((addOn) => addOn.id === target.token);
    },
    readPriorSecretDigests: async (target) => {
      const inventory = await tigrisSecretNames(options, target);
      return Object.fromEntries(
        inventory
          .filter((item) => (TIGRIS_SECRET_NAMES as readonly string[]).includes(item.name))
          .map((item) => [item.name, item.digest])
      );
    },
    clearBoundSecrets: async (target) => {
      // The unset's own result is advisory; only the readback decides.
      try {
        await unsetFlyTigrisSecrets(options.fly, target.appName);
      } catch {
        // Checked below.
      }
      const names = (await tigrisSecretNames(options, target)).map((item) => item.name);
      return !TIGRIS_SECRET_NAMES.some((name) => names.includes(name));
    },
  };
}

/**
 * Build the probe for the one service an uncertain intent names.
 *
 * @param options - Local executable and profile settings.
 */
export function createDefaultRemovalProbes(
  options: CommunityServiceOptions
): (provider: RemovalProvider) => UncertainResourceProbe {
  return (provider) =>
    provider === 'fly'
      ? flyProbe(options)
      : provider === 'neon'
        ? neonProbe(options)
        : tigrisProbe(options);
}
