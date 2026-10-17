/**
 * The hub slice of the `Transport` interface (spec `everything-is-a-space`
 * step B3, DOR-2946): a hub owner's linked computers. Joined in
 * `transport-slices.ts`. Off a hub every method rejects with the `/api` 404.
 *
 * @module shared/transport-hub
 */
import type { HubComputerList, HubLinkCode } from './session-relay-link.js';

/** What a hub's owner asks it about the computers it serves. */
export interface HubComputersTransport {
  /** The computers this hub serves, and whether each is connected now. */
  listHubComputers(): Promise<HubComputerList>;
  /** Mint a one-time code to link another computer. Owner's browser only. */
  createHubLinkCode(): Promise<HubLinkCode>;
  /**
   * Unlink a computer: its relay secret stops working at once.
   *
   * @param computerId - The computer to unlink.
   */
  removeHubComputer(computerId: string): Promise<void>;
}
