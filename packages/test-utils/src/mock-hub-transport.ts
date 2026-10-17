/**
 * The hub methods of a mock `Transport` (step B3, DOR-2946), kept in their own
 * file and spread into `createMockTransport`. By default this is not a hub:
 * listing the computers rejects with the `/api` 404, as a person's own
 * computer answers.
 *
 * @module test-utils/mock-hub-transport
 */
import { vi } from 'vitest';
import type { HubComputersTransport } from '@dorkos/shared/transport-hub';

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
