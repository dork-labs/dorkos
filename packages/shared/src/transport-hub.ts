/**
 * The hub slice of the `Transport` interface (spec `everything-is-a-space`
 * step B3, DOR-2946): a hub owner's linked computers, and the other end, a
 * computer's own switch for chatting from the web. Joined in
 * `transport-slices.ts`. Off a hub every hub method rejects with the `/api`
 * 404; on a hub, or with the experiment off, every session relay method does.
 *
 * @module shared/transport-hub
 */
import type {
  HubComputerList,
  HubLinkCode,
  SessionRelayLevel,
  SessionRelayLinkBody,
  SessionRelayStatus,
} from './session-relay-link.js';

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

/** What the person at a computer asks it about chatting from the web. */
export interface SessionRelayTransport {
  /** Whether this computer is linked to a hub, and its switches. */
  getSessionRelayStatus(): Promise<SessionRelayStatus>;
  /**
   * Link this computer to a hub with a code copied from it. At this computer only.
   *
   * @param body - The code, the name to link with, and the owner's password.
   */
  linkSessionRelay(body: SessionRelayLinkBody): Promise<SessionRelayStatus>;
  /**
   * Choose what the web may do here. At this computer only.
   *
   * @param level - Chat or Full control.
   * @param password - The owner's password; needed to raise it to Full control.
   */
  setSessionRelayLevel(level: SessionRelayLevel, password?: string): Promise<SessionRelayStatus>;
  /** Stop chatting from the web for now, keeping the link. At this computer only. */
  pauseSessionRelay(): Promise<SessionRelayStatus>;
  /**
   * Allow chatting from the web again. At this computer only.
   *
   * @param password - The owner's password.
   */
  resumeSessionRelay(password: string): Promise<SessionRelayStatus>;
  /** Forget the hub. Works with the network off. At this computer only. */
  unlinkSessionRelay(): Promise<SessionRelayStatus>;
}
