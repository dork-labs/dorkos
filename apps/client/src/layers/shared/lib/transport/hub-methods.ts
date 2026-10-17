/**
 * Hub Transport method factory (step B3, DOR-2946): a hub owner's linked
 * computers, and a computer's own switch for chatting from the web. Off a hub
 * every hub call rejects with the `/api` 404; on a hub, or with the experiment
 * off, every session relay call does.
 *
 * @module shared/lib/transport/hub-methods
 */
import type {
  HubComputerList,
  HubLinkCode,
  SessionRelayDeviceList,
  SessionRelayLevel,
  SessionRelayLinkBody,
  SessionRelayPresence,
  SessionRelayStatus,
} from '@dorkos/shared/session-relay-link';
import { fetchJSON, fetchNoContent } from './http-client';

/**
 * Create the hub methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createHubMethods(baseUrl: string) {
  return {
    listHubComputers(): Promise<HubComputerList> {
      return fetchJSON(baseUrl, '/hub/computers');
    },
    createHubLinkCode(): Promise<HubLinkCode> {
      return fetchJSON(baseUrl, '/hub/computers/link-code', { method: 'POST' });
    },
    removeHubComputer(computerId: string): Promise<void> {
      return fetchNoContent(baseUrl, `/hub/computers/${encodeURIComponent(computerId)}`, {
        method: 'DELETE',
      });
    },
    getSessionRelayStatus(): Promise<SessionRelayStatus> {
      return fetchJSON(baseUrl, '/session-relay/status');
    },
    linkSessionRelay(body: SessionRelayLinkBody): Promise<SessionRelayStatus> {
      // The computer waits up to 15 s for its hub; leave room past that.
      return fetchJSON(baseUrl, '/session-relay/link', {
        method: 'POST',
        body: JSON.stringify(body),
        timeout: 30_000,
      });
    },
    setSessionRelayLevel(level: SessionRelayLevel, password?: string): Promise<SessionRelayStatus> {
      return fetchJSON(baseUrl, '/session-relay/level', {
        method: 'PATCH',
        body: JSON.stringify(password === undefined ? { level } : { level, password }),
      });
    },
    pauseSessionRelay(): Promise<SessionRelayStatus> {
      return fetchJSON(baseUrl, '/session-relay/pause', { method: 'POST' });
    },
    resumeSessionRelay(password: string): Promise<SessionRelayStatus> {
      return fetchJSON(baseUrl, '/session-relay/resume', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
    },
    unlinkSessionRelay(): Promise<SessionRelayStatus> {
      return fetchJSON(baseUrl, '/session-relay/link', { method: 'DELETE' });
    },
    getSessionRelayPresence(): Promise<SessionRelayPresence> {
      return fetchJSON(baseUrl, '/session-relay/presence');
    },
    endSessionRelayPresence(): Promise<SessionRelayPresence> {
      return fetchJSON(baseUrl, '/session-relay/presence/end', { method: 'POST' });
    },
    listSessionRelayDevices(): Promise<SessionRelayDeviceList> {
      return fetchJSON(baseUrl, '/session-relay/devices');
    },
  };
}
