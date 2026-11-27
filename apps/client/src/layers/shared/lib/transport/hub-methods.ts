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
  SessionRelayPasskeyList,
  SessionRelayPasskeyStart,
  SessionRelayPasskeyStartBody,
  SessionRelayPresence,
  SessionRelayStatus,
} from '@dorkos/shared/session-relay-link';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/**
 * Create the hub methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createHubMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  // The computer waits up to 15 s for its hub; leave room past that.
  const linkApi = createTransportApiClient(baseUrl, 30_000);
  // The document also lists the capability mount's 202 approval answer for the
  // relay reads, which a person's own call never gets; the casts keep today's types.
  return {
    async listHubComputers(): Promise<HubComputerList> {
      return (await api.call('hub.listComputers', {})) as HubComputerList;
    },
    // Stays hand-written: waits for batch 3's no-body client (DOR-5473).
    createHubLinkCode(): Promise<HubLinkCode> {
      return fetchJSON(baseUrl, '/hub/computers/link-code', { method: 'POST' });
    },
    async removeHubComputer(computerId: string): Promise<void> {
      await api.call('hub.deleteComputers', { path: { computerId } });
    },
    async getSessionRelayStatus(): Promise<SessionRelayStatus> {
      return (await api.call('session-relay.status', {})) as SessionRelayStatus;
    },
    async linkSessionRelay(body: SessionRelayLinkBody): Promise<SessionRelayStatus> {
      return (await linkApi.call('sessionRelay.link', { body })) as SessionRelayStatus;
    },
    async setSessionRelayLevel(level: SessionRelayLevel): Promise<SessionRelayStatus> {
      return (await api.call('sessionRelay.updateLevel', {
        body: { level },
      })) as SessionRelayStatus;
    },
    // Stays hand-written: waits for batch 3's no-body client (DOR-5473).
    pauseSessionRelay(): Promise<SessionRelayStatus> {
      return fetchJSON(baseUrl, '/session-relay/pause', { method: 'POST' });
    },
    // Stays hand-written: waits for batch 3's no-body client (DOR-5473).
    resumeSessionRelay(): Promise<SessionRelayStatus> {
      return fetchJSON(baseUrl, '/session-relay/resume', {
        method: 'POST',
      });
    },
    async unlinkSessionRelay(): Promise<SessionRelayStatus> {
      return (await api.call('session-relay.unlink', {})) as SessionRelayStatus;
    },
    async getSessionRelayPresence(): Promise<SessionRelayPresence> {
      return (await api.call('session-relay.presence', {})) as SessionRelayPresence;
    },
    // Stays hand-written: waits for batch 3's no-body client (DOR-5473).
    endSessionRelayPresence(): Promise<SessionRelayPresence> {
      return fetchJSON(baseUrl, '/session-relay/presence/end', { method: 'POST' });
    },
    async listSessionRelayDevices(): Promise<SessionRelayDeviceList> {
      return (await api.call('session-relay.devices', {})) as SessionRelayDeviceList;
    },
    async listSessionRelayPasskeys(): Promise<SessionRelayPasskeyList> {
      return (await api.call('session-relay.passkeys', {})) as SessionRelayPasskeyList;
    },
    async startSessionRelayPasskey(
      body: SessionRelayPasskeyStartBody
    ): Promise<SessionRelayPasskeyStart> {
      return (await api.call('sessionRelay.startPasskeys', { body })) as SessionRelayPasskeyStart;
    },
    async removeSessionRelayPasskey(
      credentialId: string,
      password: string
    ): Promise<SessionRelayPasskeyList> {
      return (await api.call('sessionRelay.deletePasskey', {
        path: { credentialId },
        body: { password },
      })) as SessionRelayPasskeyList;
    },
    async removeDamagedSessionRelayPasskeys(password: string): Promise<SessionRelayPasskeyList> {
      return (await api.call('sessionRelay.deletePasskeys', {
        body: { password },
      })) as SessionRelayPasskeyList;
    },
  };
}
