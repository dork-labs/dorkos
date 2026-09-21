/**
 * Secret staging, immutable deployment, and health proof for Community launch.
 *
 * @module commands/community-deploy/deploy
 */
import { randomBytes } from 'node:crypto';
import type { LaunchJournal } from './journal.js';
import type { LaunchPlan } from './plan.js';
import type { FlyRuntimeInventory } from './fly-read.js';
import type { FlySecretInventoryItem } from './tigris-session.js';
import { ProviderMutationError } from './provider-mutation.js';

/** Runtime secret names owned by the Community launcher. */
export const COMMUNITY_RUNTIME_SECRET_NAMES = [
  'COMMUNITY_DATABASE_URL',
  'COMMUNITY_AUTH_SECRET',
  'COMMUNITY_INVITE_SECRET',
  'COMMUNITY_BOOTSTRAP_SECRET',
] as const;

/** Secret document retained only for the bounded stage call. */
export class CommunityRuntimeSecrets {
  #values: Record<(typeof COMMUNITY_RUNTIME_SECRET_NAMES)[number], string> | undefined;

  /** Generate three independent 256-bit values around one direct Neon URL. */
  constructor(databaseUrl: string) {
    if (!databaseUrl.startsWith('postgres') || /[\0\r\n]/u.test(databaseUrl)) {
      throw new ProviderMutationError('INVALID_INPUT');
    }
    this.#values = {
      COMMUNITY_DATABASE_URL: databaseUrl,
      COMMUNITY_AUTH_SECRET: randomBytes(32).toString('base64url'),
      COMMUNITY_INVITE_SECRET: randomBytes(32).toString('base64url'),
      COMMUNITY_BOOTSTRAP_SECRET: randomBytes(32).toString('base64url'),
    };
  }

  /** Use the values only inside one bounded secret-import callback. */
  async use<T>(consumer: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
    if (!this.#values) throw new ProviderMutationError('INVALID_INPUT');
    return consumer(this.#values);
  }

  /** Return the setup secret for the immediate owner handoff only. */
  bootstrapSecret(): string {
    if (!this.#values) throw new ProviderMutationError('INVALID_INPUT');
    return this.#values.COMMUNITY_BOOTSTRAP_SECRET;
  }

  /** Drop the local references after import or failure. */
  dispose(): void {
    this.#values = undefined;
  }

  /** Redact string conversion. */
  toString(): string {
    return '[REDACTED Community runtime secrets]';
  }

  /** Redact JSON serialization. */
  toJSON(): string {
    return '[REDACTED Community runtime secrets]';
  }
}

/** Boundaries needed after all three service resources are proved. */
export interface CommunityDeployPhaseDependencies {
  /** Persist a complete next revision. */
  persist(journal: LaunchJournal, expectedRevision: number): Promise<void>;
  /** Read non-secret Fly secret names, digests, and posture. */
  readSecrets(): Promise<FlySecretInventoryItem[]>;
  /** Obtain a direct TLS URL in memory for one callback. */
  useDatabaseUrl<T>(consumer: (url: string) => Promise<T>): Promise<T>;
  /** Stage the runtime secret document over stdin. */
  stageSecrets(values: Readonly<Record<string, string>>): Promise<void>;
  /** Read current app release, Machine, checks, and address inventory. */
  readRuntime(): Promise<FlyRuntimeInventory>;
  /** Deploy the immutable image with one Machine and a generated config. */
  deploy(imageReference: string): Promise<void>;
  /** Verify the first post-deploy inventory against its pre-deploy releases. */
  verifyNewRuntime(
    inventory: FlyRuntimeInventory,
    previous: FlyRuntimeInventory['releases']
  ): FlyRuntimeInventory;
  /** Verify an already completed deployment during resume. */
  verifyExistingRuntime(inventory: FlyRuntimeInventory): FlyRuntimeInventory;
  /** Verify the public health endpoint independently of Fly checks. */
  verifyHealth(origin: string): Promise<void>;
  /** Clock used only for journal timestamps. */
  now(): string;
}

/** Result containing the latest journal and an optional immediate-use setup secret. */
export interface CommunityDeployPhaseResult {
  /** Latest durable journal. */
  journal: LaunchJournal;
  /** Setup secret available only in the uninterrupted process that generated it. */
  bootstrapSecret: string | null;
}

function nextJournal(
  current: LaunchJournal,
  now: string,
  update: Partial<LaunchJournal>
): LaunchJournal {
  return { ...current, ...update, revision: current.revision + 1, updatedAt: now };
}

async function persist(
  dependencies: CommunityDeployPhaseDependencies,
  current: LaunchJournal,
  update: Partial<LaunchJournal>
): Promise<LaunchJournal> {
  const next = nextJournal(current, dependencies.now(), update);
  await dependencies.persist(next, current.revision);
  return next;
}

function runtimeSecretRows(inventory: readonly FlySecretInventoryItem[]): FlySecretInventoryItem[] {
  const byName = new Map(inventory.map((item) => [item.name, item]));
  return COMMUNITY_RUNTIME_SECRET_NAMES.map((name) => byName.get(name)).filter(
    (item): item is FlySecretInventoryItem => item !== undefined
  );
}

function exactSecretDigests(
  inventory: readonly FlySecretInventoryItem[],
  status: 'Staged' | 'Deployed'
): Record<string, string> {
  const rows = runtimeSecretRows(inventory);
  if (
    rows.length !== COMMUNITY_RUNTIME_SECRET_NAMES.length ||
    rows.some((item) => item.status !== status)
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return Object.fromEntries(rows.map((item) => [item.name, item.digest]));
}

function sameDigests(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return COMMUNITY_RUNTIME_SECRET_NAMES.every((name) => actual[name] === expected[name]);
}

function runtimeDigestMap(inventory: readonly FlySecretInventoryItem[]): Record<string, string> {
  return Object.fromEntries(runtimeSecretRows(inventory).map((item) => [item.name, item.digest]));
}

function provesFreshStage(
  inventory: readonly FlySecretInventoryItem[],
  baseline: Record<string, string>
): Record<string, string> {
  const staged = exactSecretDigests(inventory, 'Staged');
  if (
    COMMUNITY_RUNTIME_SECRET_NAMES.some(
      (name) => baseline[name] !== undefined && baseline[name] === staged[name]
    )
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return staged;
}

function runtimeEvidence(inventory: FlyRuntimeInventory) {
  const machine = inventory.machines[0];
  const release = inventory.releases.reduce<FlyRuntimeInventory['releases'][number] | undefined>(
    (latest, value) => (!latest || value.version > latest.version ? value : latest),
    undefined
  );
  const address = inventory.addresses[0];
  if (!machine || !release || !address) throw new ProviderMutationError('INVALID_RESPONSE');
  return { machine, release, address };
}

/**
 * Stage fresh secrets once, deploy the pinned image, and prove public health.
 *
 * Resume first inspects staged/deployed secret digests and current runtime state. It never generates
 * replacements merely because the previous process stopped between a service write and journaling.
 */
export async function executeCommunityDeployPhase(
  plan: LaunchPlan,
  journal: LaunchJournal,
  dependencies: CommunityDeployPhaseDependencies
): Promise<CommunityDeployPhaseResult> {
  let current = journal;
  let bootstrapSecret: string | null = null;

  if (!current.completedSteps.includes('secrets_staged')) {
    if (!current.secretBaseline) {
      const before = await dependencies.readSecrets();
      if (runtimeSecretRows(before).length > 0) {
        await persist(dependencies, current, {
          state: 'uncertain',
          lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
        });
        throw new Error('Runtime secrets exist without a proven journal checkpoint');
      }
      current = await persist(dependencies, current, {
        secretBaseline: runtimeDigestMap(before),
        lastSafeError: null,
      });
    }
    const baseline = current.secretBaseline;
    if (!baseline) throw new ProviderMutationError('INVALID_RESPONSE');
    const observed = await dependencies.readSecrets();
    const observedRuntime = runtimeSecretRows(observed);
    if (observedRuntime.length > 0) {
      const staged = provesFreshStage(observed, baseline);
      current = await persist(dependencies, current, {
        state: 'secrets_staged',
        secretDigests: staged,
        completedSteps: [...current.completedSteps, 'secrets_staged'],
        lastSafeError: null,
      });
    } else {
      const secretSet = await dependencies.useDatabaseUrl(async (url) => {
        const values = new CommunityRuntimeSecrets(url);
        try {
          await values.use(dependencies.stageSecrets);
          return values;
        } catch (error) {
          values.dispose();
          throw error;
        }
      });
      try {
        const staged = provesFreshStage(await dependencies.readSecrets(), baseline);
        bootstrapSecret = secretSet.bootstrapSecret();
        current = await persist(dependencies, current, {
          state: 'secrets_staged',
          secretDigests: staged,
          completedSteps: [...current.completedSteps, 'secrets_staged'],
          lastSafeError: null,
        });
      } finally {
        secretSet.dispose();
      }
    }
  }

  const expectedDigests = current.secretDigests ?? {};
  if (Object.keys(expectedDigests).length !== COMMUNITY_RUNTIME_SECRET_NAMES.length) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }

  if (!current.completedSteps.includes('deployed')) {
    const existingSecrets = await dependencies.readSecrets();
    const deployedRows = runtimeSecretRows(existingSecrets);
    let inventory: FlyRuntimeInventory;
    if (
      deployedRows.length === COMMUNITY_RUNTIME_SECRET_NAMES.length &&
      deployedRows.every((item) => item.status === 'Deployed')
    ) {
      const deployed = exactSecretDigests(existingSecrets, 'Deployed');
      if (!sameDigests(deployed, expectedDigests))
        throw new ProviderMutationError('INVALID_RESPONSE');
      inventory = dependencies.verifyExistingRuntime(await dependencies.readRuntime());
    } else {
      const staged = exactSecretDigests(existingSecrets, 'Staged');
      if (!sameDigests(staged, expectedDigests))
        throw new ProviderMutationError('INVALID_RESPONSE');
      const previous = (await dependencies.readRuntime()).releases;
      await dependencies.deploy(`${plan.imageDigest}`);
      const afterSecrets = exactSecretDigests(await dependencies.readSecrets(), 'Deployed');
      if (!sameDigests(afterSecrets, expectedDigests)) {
        throw new ProviderMutationError('INVALID_RESPONSE');
      }
      inventory = dependencies.verifyNewRuntime(await dependencies.readRuntime(), previous);
    }
    const { machine, release, address } = runtimeEvidence(inventory);
    current = await persist(dependencies, current, {
      state: 'deployed',
      resources: {
        ...current.resources,
        flyMachineId: machine.id,
        flyReleaseId: release.id,
        flyAddressId: address.id,
      },
      verifiedBindings: [
        ...current.verifiedBindings,
        { kind: 'machine-to-release', sourceId: machine.id, targetId: release.id },
        ...Object.values(expectedDigests).map((digest) => ({
          kind: 'secret-version-to-machine' as const,
          sourceId: digest,
          targetId: machine.id,
        })),
      ],
      completedSteps: [...current.completedSteps, 'deployed'],
      lastSafeError: null,
    });
  }

  if (!current.completedSteps.includes('healthy')) {
    await dependencies.verifyHealth(`https://${plan.fly.appName}.fly.dev`);
    current = await persist(dependencies, current, {
      state: 'healthy',
      completedSteps: [...current.completedSteps, 'healthy'],
      lastSafeError: null,
    });
  }
  return { journal: current, bootstrapSecret };
}
