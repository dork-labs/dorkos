/**
 * The hub methods of a mock `Transport` (step B3, DOR-2946), kept in their own
 * file and spread into `createMockTransport`. By default this is not a hub:
 * listing the computers rejects with the `/api` 404, as a person's own
 * computer answers. The session relay methods answer the 404 too, as a
 * computer with the experiment off does.
 *
 * @module test-utils/mock-hub-transport
 */
import { vi } from 'vitest';
import type { HubComputersTransport, SessionRelayTransport } from '@dorkos/shared/transport-hub';

/** The error a non-hub server answers `/api/hub/computers` with. */
function notFound(): Error {
  return Object.assign(new Error('Not found'), { status: 404, code: 'API_NOT_FOUND' });
}

/** Mock hub methods: not a hub, so every read and write is the 404. */
export function createMockHubTransport(): HubComputersTransport {
  return {
    listHubComputers: vi.fn().mockRejectedValue(notFound()),
    createHubLinkCode: vi.fn().mockRejectedValue(notFound()),
    removeHubComputer: vi.fn().mockRejectedValue(notFound()),
  };
}

/** Mock session relay methods: the experiment is off, so every call is the 404. */
export function createMockSessionRelayTransport(): SessionRelayTransport {
  return {
    getSessionRelayStatus: vi.fn().mockRejectedValue(notFound()),
    linkSessionRelay: vi.fn().mockRejectedValue(notFound()),
    setSessionRelayLevel: vi.fn().mockRejectedValue(notFound()),
    pauseSessionRelay: vi.fn().mockRejectedValue(notFound()),
    resumeSessionRelay: vi.fn().mockRejectedValue(notFound()),
    unlinkSessionRelay: vi.fn().mockRejectedValue(notFound()),
    getSessionRelayPresence: vi.fn().mockRejectedValue(notFound()),
    endSessionRelayPresence: vi.fn().mockRejectedValue(notFound()),
    listSessionRelayDevices: vi.fn().mockRejectedValue(notFound()),
  };
}
