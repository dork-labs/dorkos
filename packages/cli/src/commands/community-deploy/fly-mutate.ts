/**
 * Bounded Fly app, secret, deployment, and cleanup mutations.
 *
 * @module commands/community-deploy/fly-mutate
 */
import { z } from 'zod';
import { ExternalIdentifierSchema, parseExternalJson } from './provider-contract.js';
import { ProviderMutationError, runProviderMutation } from './provider-mutation.js';
import type { FlySessionReadOptions, FlySecretInventoryItem } from './tigris-session.js';
import type { FlyAppProvenance } from './fly-graphql-contract.js';
import {
  FlyAppResponseSchema,
  toFlyAppIdentity,
  type FlyAppIdentity,
  type FlyRuntimeInventory,
} from './fly-read.js';

const SecretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const ImageReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}@sha256:[0-9a-f]{64}$/u);

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderMutationError('INVALID_INPUT');
  return result.data;
}

/** Non-secret acknowledgement that a Fly command returned and still needs readback. */
export interface FlyMutationReceipt {
  /** Operation whose remote state must be independently verified. */
  operation: 'secrets-stage' | 'deploy' | 'destroy';
}

/**
 * Create one planned Fly app on its own private network and retain only its non-secret identity.
 *
 * The network name carries the run's provenance marker, which the journal recorded before this
 * call. The created app is bound by its name and the organization slug the operator selected. When
 * the command succeeds but its JSON cannot be read, the app is identified through a provenance read
 * instead of being reported as uncertain, and only when its name, organization slug and network all
 * match: the network carries a 128-bit marker only this run knew, so a match is the app this call
 * created. `apps list` is never used for this, because it always reports an empty network. A
 * response naming a different app or organization is never adopted.
 *
 * @param options - Pinned Fly executable and bounded process settings.
 * @param appName - Planned app name.
 * @param organizationSlug - Planned organization slug.
 * @param network - Private network name carrying the run's provenance marker.
 * @param readProvenance - Provenance read by app name, used only when create output is unreadable.
 */
export async function createFlyApp(
  options: FlySessionReadOptions,
  appName: string,
  organizationSlug: string,
  network: string,
  readProvenance: (appName: string) => Promise<FlyAppProvenance | null>
): Promise<FlyAppIdentity> {
  const app = parseInput(ExternalIdentifierSchema, appName);
  const organization = parseInput(ExternalIdentifierSchema, organizationSlug);
  const networkName = parseInput(ExternalIdentifierSchema, network);
  const created = await runProviderMutation({
    ...options,
    args: [
      'apps',
      'create',
      app,
      '--org',
      organization,
      '--network',
      networkName,
      '--json',
      '--yes',
    ],
    parse: (stdout) => {
      let document: unknown;
      try {
        document = parseExternalJson(stdout);
      } catch {
        return null;
      }
      const parsed = FlyAppResponseSchema.safeParse(document);
      if (!parsed.success) return null;
      if (parsed.data.Name !== app || parsed.data.Organization.Slug !== organization) {
        throw new Error('APP_BINDING_MISMATCH');
      }
      return toFlyAppIdentity(parsed.data);
    },
  });
  if (created) return created;
  const found = await readProvenance(app).catch(() => {
    throw new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
  });
  if (
    !found ||
    found.name !== app ||
    found.organizationSlug !== organization ||
    found.network !== networkName
  ) {
    throw new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
  }
  return { id: found.id, name: found.name, organizationSlug: found.organizationSlug, status: '' };
}

/** Stage secrets over stdin; completion must be proved through secret inventory readback. */
export async function stageFlySecrets(
  options: FlySessionReadOptions,
  appName: string,
  secrets: Readonly<Record<string, string>>
): Promise<FlyMutationReceipt> {
  const app = parseInput(ExternalIdentifierSchema, appName);
  const entries = Object.entries(secrets).sort(([left], [right]) => left.localeCompare(right));
  if (
    entries.length === 0 ||
    entries.some(
      ([name, value]) =>
        !SecretNameSchema.safeParse(name).success || value.length === 0 || /[\0\r\n]/u.test(value)
    )
  ) {
    throw new ProviderMutationError('INVALID_INPUT');
  }
  const document = `${entries.map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
  return runProviderMutation({
    ...options,
    args: ['secrets', 'import', '--app', app, '--stage'],
    stdin: document,
    parse: () => ({ operation: 'secrets-stage' as const }),
  });
}

/** Deploy one immutable image with Fly high availability explicitly disabled. */
export async function deployFlyImage(
  options: FlySessionReadOptions,
  appName: string,
  imageReference: string,
  configPath?: string
): Promise<FlyMutationReceipt> {
  const app = parseInput(ExternalIdentifierSchema, appName);
  const image = parseInput(ImageReferenceSchema, imageReference);
  if (configPath !== undefined && (configPath.length === 0 || /[\0\r\n]/u.test(configPath))) {
    throw new ProviderMutationError('INVALID_INPUT');
  }
  return runProviderMutation({
    ...options,
    args: [
      'deploy',
      '--app',
      app,
      '--image',
      image,
      ...(configPath === undefined ? [] : ['--config', configPath]),
      '--ha=false',
      '--yes',
    ],
    parse: () => ({ operation: 'deploy' as const }),
  });
}

/** Apply already staged secrets without rebuilding or changing the selected image. */
export async function deployFlySecrets(
  options: FlySessionReadOptions,
  appName: string
): Promise<FlyMutationReceipt> {
  const app = parseInput(ExternalIdentifierSchema, appName);
  return runProviderMutation({
    ...options,
    args: ['secrets', 'deploy', '--app', app, '--yes'],
    parse: () => ({ operation: 'deploy' as const }),
  });
}

/** Delete one exact Fly app after the release gate has verified its journal identity. */
export async function destroyFlyApp(
  options: FlySessionReadOptions,
  appName: string
): Promise<FlyMutationReceipt> {
  const app = parseInput(ExternalIdentifierSchema, appName);
  return runProviderMutation({
    ...options,
    args: ['apps', 'destroy', app, '--yes'],
    parse: () => ({ operation: 'destroy' as const }),
  });
}

/** Prove every expected staged secret exists and none is reported deployed prematurely. */
export function verifyStagedFlySecrets(
  inventory: readonly FlySecretInventoryItem[],
  expectedNames: readonly string[],
  previousInventory: readonly FlySecretInventoryItem[] = []
): FlySecretInventoryItem[] {
  const expected = expectedNames.map((name) => parseInput(SecretNameSchema, name));
  const byName = new Map(inventory.map((item) => [item.name, item]));
  const found = expected.map((name) => byName.get(name));
  const previous = new Map(previousInventory.map((item) => [item.name, item.digest]));
  if (
    found.some(
      (item) =>
        item === undefined ||
        item.status !== 'Staged' ||
        (previous.has(item.name) && previous.get(item.name) === item.digest)
    )
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return found as FlySecretInventoryItem[];
}

/** Prove deployment applied the exact staged secret digests. */
export function verifyDeployedFlySecrets(
  inventory: readonly FlySecretInventoryItem[],
  staged: readonly FlySecretInventoryItem[]
): FlySecretInventoryItem[] {
  const current = new Map(inventory.map((item) => [item.name, item]));
  const deployed = staged.map((item) => current.get(item.name));
  if (
    deployed.some(
      (item, index) =>
        item === undefined || item.status !== 'Deployed' || item.digest !== staged[index]?.digest
    )
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return deployed as FlySecretInventoryItem[];
}

/** Refuse app creation when the planned global name is already present in selected inventory. */
export function assertFlyAppNameAvailable(
  apps: readonly FlyAppIdentity[],
  plannedName: string
): void {
  const name = parseInput(ExternalIdentifierSchema, plannedName);
  if (apps.some((app) => app.name === name)) {
    throw new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
  }
}

/** Prove a newly completed release runs as one healthy exact-digest Machine. */
export function verifyFlyDeployment(
  inventory: FlyRuntimeInventory,
  previousReleases: readonly FlyRuntimeInventory['releases'][number][],
  expectedRepository: string,
  expectedDigest: string
): FlyRuntimeInventory {
  const latestRelease = inventory.releases.reduce<
    FlyRuntimeInventory['releases'][number] | undefined
  >(
    (latest, release) => (!latest || release.version > latest.version ? release : latest),
    undefined
  );
  const releaseIsNew =
    latestRelease !== undefined &&
    !previousReleases.some(
      (release) => release.id === latestRelease.id || release.version >= latestRelease.version
    );
  if (
    inventory.machines.length !== 1 ||
    inventory.machines[0]?.state !== 'started' ||
    inventory.machines[0]?.imageRepository !== expectedRepository ||
    inventory.machines[0]?.imageDigest !== expectedDigest ||
    inventory.machines[0]?.checks.length === 0 ||
    inventory.machines[0]?.checks.some((check) => check.status !== 'passing') ||
    !releaseIsNew ||
    latestRelease?.status !== 'complete' ||
    latestRelease.imageRef !== `${expectedRepository}@${expectedDigest}` ||
    inventory.addresses.length === 0
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return inventory;
}

/** Prove the current app already runs one healthy exact-digest deployment. */
export function verifyExistingFlyDeployment(
  inventory: FlyRuntimeInventory,
  expectedRepository: string,
  expectedDigest: string
): FlyRuntimeInventory {
  const latestRelease = inventory.releases.reduce<
    FlyRuntimeInventory['releases'][number] | undefined
  >(
    (latest, release) => (!latest || release.version > latest.version ? release : latest),
    undefined
  );
  if (
    inventory.machines.length !== 1 ||
    inventory.machines[0]?.state !== 'started' ||
    inventory.machines[0]?.imageRepository !== expectedRepository ||
    inventory.machines[0]?.imageDigest !== expectedDigest ||
    inventory.machines[0]?.checks.length === 0 ||
    inventory.machines[0]?.checks.some((check) => check.status !== 'passing') ||
    latestRelease?.status !== 'complete' ||
    latestRelease.imageRef !== `${expectedRepository}@${expectedDigest}` ||
    inventory.addresses.length === 0
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return inventory;
}
