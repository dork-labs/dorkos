/**
 * Owner handoff, lost setup-secret replacement, and applied rotation.
 *
 * @module commands/community-deploy/owner
 */
import { randomBytes } from 'node:crypto';
import type { LaunchJournal } from './journal.js';
import type { LaunchPlan } from './plan.js';
import type { FlySecretInventoryItem } from './tigris-session.js';
import { ProviderMutationError } from './provider-mutation.js';

const BOOTSTRAP_SECRET_NAME = 'COMMUNITY_BOOTSTRAP_SECRET';

/** Interactive and service boundaries required for owner handoff. */
export interface CommunityOwnerDependencies {
  /** Persist one complete next journal revision. */
  persist(journal: LaunchJournal, expectedRevision: number): Promise<void>;
  /** Stage one replacement setup secret over stdin. */
  stageBootstrap(secret: string): Promise<void>;
  /** Apply staged secrets to the existing Machine. */
  deploySecrets(): Promise<void>;
  /** Read non-secret Fly secret inventory. */
  readSecrets(): Promise<FlySecretInventoryItem[]>;
  /** Reprove the same one-Machine pinned-image runtime and public health. */
  verifyRuntimeAndHealth(): Promise<void>;
  /** Ask locally before copying or displaying the setup secret. */
  handoffSecret(origin: string, secret: string): Promise<void>;
  /** Wait for the operator, then detect owner creation without receiving a session. */
  waitForOwnerClaim(origin: string): Promise<boolean>;
  /** Read whether the public community identity now exists. */
  ownerExists(origin: string): Promise<boolean>;
  /** Ask the signed-in operator to confirm a post and private attachment round trip. */
  confirmAcceptance(origin: string): Promise<boolean>;
  /** Clock used only for journal timestamps. */
  now(): string;
}

function nextJournal(
  current: LaunchJournal,
  now: string,
  update: Partial<LaunchJournal>
): LaunchJournal {
  return { ...current, ...update, revision: current.revision + 1, updatedAt: now };
}

async function persist(
  dependencies: CommunityOwnerDependencies,
  current: LaunchJournal,
  update: Partial<LaunchJournal>
): Promise<LaunchJournal> {
  const next = nextJournal(current, dependencies.now(), update);
  await dependencies.persist(next, current.revision);
  return next;
}

function bootstrapDigest(
  inventory: readonly FlySecretInventoryItem[],
  status: 'Staged' | 'Deployed'
) {
  const matches = inventory.filter((item) => item.name === BOOTSTRAP_SECRET_NAME);
  if (matches.length !== 1 || matches[0]?.status !== status) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return matches[0].digest;
}

async function replaceAndApplyBootstrap(
  journal: LaunchJournal,
  dependencies: CommunityOwnerDependencies
): Promise<{ journal: LaunchJournal; secret: string }> {
  const previousDigest = journal.secretDigests?.[BOOTSTRAP_SECRET_NAME];
  if (!previousDigest) throw new ProviderMutationError('INVALID_RESPONSE');
  const secret = randomBytes(32).toString('base64url');
  await dependencies.stageBootstrap(secret);
  const stagedDigest = bootstrapDigest(await dependencies.readSecrets(), 'Staged');
  if (stagedDigest === previousDigest) throw new ProviderMutationError('INVALID_RESPONSE');
  await dependencies.deploySecrets();
  const deployedDigest = bootstrapDigest(await dependencies.readSecrets(), 'Deployed');
  if (deployedDigest !== stagedDigest) throw new ProviderMutationError('INVALID_RESPONSE');
  await dependencies.verifyRuntimeAndHealth();
  const current = await persist(dependencies, journal, {
    secretDigests: { ...journal.secretDigests, [BOOTSTRAP_SECRET_NAME]: deployedDigest },
    lastSafeError: null,
  });
  return { journal: current, secret };
}

/**
 * Hand the setup secret to the operator, detect the claim, rotate it, and record acceptance.
 *
 * @param plan - Immutable plan containing the public Fly origin.
 * @param journal - Latest healthy or owner-pending journal.
 * @param initialBootstrapSecret - In-memory secret from uninterrupted initial staging, if present.
 * @param dependencies - Interactive, secret, deployment, and verification boundaries.
 * @returns Completed journal after rotation and meaningful operator acceptance.
 */
export async function executeCommunityOwnerHandoff(
  plan: LaunchPlan,
  journal: LaunchJournal,
  initialBootstrapSecret: string | null,
  dependencies: CommunityOwnerDependencies
): Promise<LaunchJournal> {
  if (journal.completedSteps.includes('complete')) return journal;
  let current = journal;
  const origin = `https://${plan.fly.appName}.fly.dev`;
  let handoffSecret = initialBootstrapSecret;
  if (
    current.completedSteps.includes('owner_pending') &&
    !(await dependencies.ownerExists(origin))
  ) {
    if (!handoffSecret) {
      const replacement = await replaceAndApplyBootstrap(current, dependencies);
      current = replacement.journal;
      handoffSecret = replacement.secret;
    }
    await dependencies.handoffSecret(origin, handoffSecret);
  }
  if (!current.completedSteps.includes('owner_pending')) {
    if (!handoffSecret) {
      const replacement = await replaceAndApplyBootstrap(current, dependencies);
      current = replacement.journal;
      handoffSecret = replacement.secret;
    }
    await dependencies.handoffSecret(origin, handoffSecret);
    current = await persist(dependencies, current, {
      state: 'owner_pending',
      completedSteps: [...current.completedSteps, 'owner_pending'],
      lastSafeError: null,
    });
  }

  if (
    !(await dependencies.ownerExists(origin)) &&
    !(await dependencies.waitForOwnerClaim(origin))
  ) {
    return current;
  }
  const rotation = await replaceAndApplyBootstrap(current, dependencies);
  current = rotation.journal;
  if (!(await dependencies.confirmAcceptance(origin))) return current;
  return persist(dependencies, current, {
    state: 'complete',
    completedSteps: [...current.completedSteps, 'complete'],
    lastSafeError: null,
  });
}
