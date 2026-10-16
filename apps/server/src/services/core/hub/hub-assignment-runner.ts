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
import { getAuth, hasAnyUser } from '../auth/index.js';
import { createCloudV1Client } from '../cloud/v1-client.js';
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
 * The real dependencies: this hub's own Cloud key, its data directory, and
 * Better Auth for the owner account.
 *
 * @param dorkHome - The DorkOS data directory.
 */
function liveDeps(dorkHome: string): HubAssignmentSyncDeps {
  return {
    ...cloudHubCalls(createCloudV1Client()),
    ownerExists: hasAnyUser,
    createOwner: async (body) => {
      const auth = getAuth();
      if (!auth) throw new Error('Sign-in is not ready yet.');
      await withRegistrationCaller('provisioning', () => auth.api.signUpEmail({ body }));
    },
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
  const resolved = deps ?? liveDeps(dorkHome);
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
