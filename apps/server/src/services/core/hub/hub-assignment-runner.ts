/**
 * Keeps a hub's assignment current: reads it at boot, then again on a beat
 * (DOR-2934). The beat is short while the hub is pooled (Cloud may set it
 * with `pollAfterSeconds`), long once it serves, and stops for good when the
 * hub refuses or its assignment ends. A failed read retries on the short
 * beat. The timer never holds the process open.
 *
 * Reading again on Cloud's `hub_assignment_changed` command is the next step;
 * until then the beat is how a hub picks up a replaced proof.
 *
 * @module services/core/hub/hub-assignment-runner
 */
import { logger } from '../../../lib/logger.js';
import { withRegistrationCaller } from '../auth/registration-policy.js';
import { getAuth, hasAnyUser, type Auth } from '../auth/index.js';
import { createCloudV1ClientFor } from '../cloud/v1-client.js';
import { env } from '../../../env.js';
import { ensureHubSigningKey, loadHubSigningKey } from './hub-signing-key.js';
import {
  cloudHubCalls,
  readHubOwnerPin,
  syncHubAssignment,
  writeHubOwnerPin,
  type HubAssignmentSyncDeps,
  type HubSyncOutcome,
} from './hub-assignment-sync.js';

/** How long a pooled or failing hub waits before reading again, by default. */
export const HUB_SHORT_BEAT_MS = 30_000;

/** How long a serving hub waits before reading again. */
export const HUB_LONG_BEAT_MS = 5 * 60_000;

/**
 * How long to wait after one sync, or `null` to stop.
 *
 * @param outcome - What the sync did.
 */
export function nextHubBeatMs(outcome: HubSyncOutcome): number | null {
  switch (outcome.kind) {
    case 'pooled':
      return outcome.pollAfterSeconds !== null
        ? outcome.pollAfterSeconds * 1_000
        : HUB_SHORT_BEAT_MS;
    case 'serving':
      return HUB_LONG_BEAT_MS;
    case 'unchanged':
      return HUB_SHORT_BEAT_MS;
    case 'refused':
    case 'ended':
      return null;
  }
}

/**
 * Create a hub's owner account: no password and no session, since the owner
 * only ever signs in with their DorkOS account. It still passes the
 * registration hook, which lets the `provisioning` caller in on a hub, makes
 * the account the owner, and writes it to the audit log.
 *
 * @param auth - Better Auth.
 * @param input - The owner's placeholder email and display name.
 */
export async function createHubOwner(
  auth: Auth,
  input: { email: string; name: string }
): Promise<void> {
  const context = await auth.$context;
  await withRegistrationCaller('provisioning', () =>
    context.internalAdapter.createUser(
      { ...input, emailVerified: false },
      { method: 'dorkos-cloud-assignment' }
    )
  );
}

/**
 * The real dependencies: this hub's data directory and Better Auth, and Cloud
 * through this hub's own key (`DORKOS_HUB_INSTANCE_KEY`) unless `cloud`
 * replaces it. The key is the hub's alone: the hub is not linked to an account
 * the way a person's computer is, so no account feature presents it.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param cloud - Replaces the Cloud calls, for tests.
 */
export function liveHubDeps(
  dorkHome: string,
  cloud: Pick<HubAssignmentSyncDeps, 'readAssignment' | 'confirm'> = cloudHubCalls(
    env.DORKOS_HUB_INSTANCE_KEY ? createCloudV1ClientFor(env.DORKOS_HUB_INSTANCE_KEY) : null
  )
): HubAssignmentSyncDeps {
  return {
    ...cloud,
    ownerExists: hasAnyUser,
    createOwner: async (input) => {
      const auth = getAuth();
      if (!auth) throw new Error('Sign-in is not ready yet.');
      await createHubOwner(auth, input);
    },
    signingPublicKey: (mayCreate) => ensureHubSigningKey(dorkHome, mayCreate),
    readPin: () => readHubOwnerPin(dorkHome),
    writePin: (pin) => writeHubOwnerPin(dorkHome, pin),
  };
}

/**
 * Start keeping this hub's assignment current. Call once, on a hub only.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param deps - Replaces the live dependencies, for tests.
 */
export function startHubAssignmentSync(dorkHome: string, deps?: HubAssignmentSyncDeps): void {
  // A hub that restarts signs relay handshakes before its next confirmation.
  // A key file it cannot read is caught by the first sync, which refuses.
  try {
    loadHubSigningKey(dorkHome);
  } catch {
    // Left for the sync: it reads the key again and refuses with the reason.
  }
  const resolved = deps ?? liveHubDeps(dorkHome);
  const beat = async (): Promise<void> => {
    let outcome: HubSyncOutcome;
    try {
      outcome = await syncHubAssignment(resolved);
    } catch (err) {
      logger.warn('[Hub] Taking this hub`s assignment failed; trying again', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      outcome = { kind: 'unchanged', reason: 'failed' };
    }
    const wait = nextHubBeatMs(outcome);
    if (wait === null) return;
    setTimeout(() => void beat(), wait).unref();
  };
  void beat();
}
