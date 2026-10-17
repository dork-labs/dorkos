/**
 * The hub's end of the session relay (B1, DOR-2944): the linked computers it
 * serves, the `/api/relay/computer` endpoint they dial, and their live
 * connections, which the relayed chat view looks up by computer id.
 *
 * Only a serving hub answers the endpoint, and only once the hub's signing key
 * is wired in through {@link setHubRelaySigner}.
 *
 * @module services/core/hub-relay
 */
import { resolveDorkHome } from '../../../lib/dork-home.js';
import {
  storeLinkedComputer,
  unlinkComputer,
  type LinkComputerInput,
  type LinkedComputer,
} from './computer-store.js';
import {
  computerConnection,
  dropComputerConnection,
  onConnectionPromoted,
} from './hub-relay-registry.js';
import { HubViewerTracker } from './viewer-tracker.js';

export {
  HUB_RELAY_MAX_COMPUTERS,
  readLinkedComputers,
  relaySecretHash,
  type LinkComputerInput,
  type LinkedComputer,
} from './computer-store.js';
export {
  RELAY_BAD_ANSWER,
  RELAY_COMPUTER_OFFLINE,
  RELAY_HUB_BUSY,
  RELAY_REQUEST_TOO_LARGE,
  RELAY_TIMED_OUT,
  type HubComputerConnection,
  type HubRelaySigner,
  type RelayCallRequest,
  type RelayCallResult,
  type RelayStreamFrame,
} from './computer-connection.js';
export { closeAllComputerConnections, computerConnection } from './hub-relay-registry.js';
export { hubRelayComputerRoute, setHubRelaySigner } from './relay-endpoint.js';
export {
  ComputerWaker,
  HUB_RELAY_WAKE_DEBOUNCE_MS,
  hubComputerWaker,
  setHubRelayWaker,
  type HubRelayWake,
} from './computer-waker.js';
export { HubViewerTracker, type ViewerCountTarget } from './viewer-tracker.js';

/**
 * The hub's open chat streams per computer. Each computer's live connection is
 * told its count whenever it changes, and the moment the connection proves
 * itself.
 */
export const hubViewers = new HubViewerTracker({ lookup: computerConnection });
onConnectionPromoted((connection) => hubViewers.connected(connection));

/**
 * Link a computer (step B3), or link it again with a new secret and key. A
 * live connection it had was proved with the old key, so it is closed and the
 * computer redials with the new one.
 *
 * @param input - The computer's id, secret hash and public key.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns The stored record.
 */
export async function linkComputer(
  input: LinkComputerInput,
  dorkHome: string = resolveDorkHome()
): Promise<LinkedComputer> {
  const { record, replaced } = await storeLinkedComputer(input, dorkHome);
  if (replaced) dropComputerConnection(input.computerId);
  return record;
}

/**
 * Forget a linked computer and close any connection it has open, so its
 * secret stops working at once rather than at its next dial.
 *
 * @param computerId - The computer to unlink.
 * @param dorkHome - The data folder; defaults to the live one.
 * @returns Whether it was linked.
 */
export async function forgetLinkedComputer(
  computerId: string,
  dorkHome: string = resolveDorkHome()
): Promise<boolean> {
  const was = await unlinkComputer(computerId, dorkHome);
  dropComputerConnection(computerId);
  return was;
}
