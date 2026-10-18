/**
 * Which credential pays for DorkOS credits on this server: the one question
 * the credits token loop (`./credits-inference.ts`) and the credits model list
 * (`./credits-models.ts`) ask before they call the Cloud API.
 *
 * - **A person's computer or a hub:** the account link (`cloud.instanceToken`),
 *   exactly as before.
 * - **An agent computer:** its own instance key and nothing else
 *   (`../agent-computer/instance-key.ts`). It never reads an account link, so
 *   a link written into its config by anything could not make it pay another
 *   way, and with no key there is no credential at all: every credits turn
 *   is refused.
 *
 * The agent computer's key is fixed for the life of the process, so its
 * context is always current.
 *
 * @module services/core/cloud/credits-credential
 */
import { agentComputerInstanceKey } from '../agent-computer/instance-key.js';
import { isAgentComputer } from '../server-role/role-checks.js';
import {
  captureCloudV1Context,
  createCloudV1ClientFor,
  isCloudLinked,
  readCloudInstanceToken,
  type CloudV1Context,
} from './v1-client.js';

/**
 * The credential credits are minted under, or `null` when there is none. A
 * credential: never logged, never sent anywhere but the Cloud API.
 */
export function creditsCredential(): string | null {
  return isAgentComputer() ? agentComputerInstanceKey() : readCloudInstanceToken();
}

/** Whether a credential that can mint credits is held right now. */
export function creditsCredentialHeld(): boolean {
  return isAgentComputer() ? agentComputerInstanceKey() !== null : isCloudLinked();
}

/**
 * A `/v1` context under the credits credential, or `null` when there is none.
 * On a person's computer, the captured account link; on an agent computer, its
 * own key.
 */
export function captureCreditsContext(): CloudV1Context | null {
  if (!isAgentComputer()) return captureCloudV1Context();
  const key = agentComputerInstanceKey();
  if (key === null) return null;
  return { client: createCloudV1ClientFor(key), isCurrent: () => true };
}
