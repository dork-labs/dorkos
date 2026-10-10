/**
 * Mocks for the what-happened part of the `Transport` (`ActivityTransport`),
 * split out of `mock-factories.ts`: every read answers an empty page.
 *
 * @module test-utils/mock-activity-transport
 */
import { vi } from 'vitest';
import type { ActivityTransport } from '@dorkos/shared/transport-activity';

/** Empty-page mocks for every `ActivityTransport` method. */
export function activityTransportMocks(): ActivityTransport {
  return {
    listActivityEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listAuditEvents: vi.fn().mockResolvedValue({ events: [] }),
    getAccountTimeline: vi.fn().mockResolvedValue({ events: [] }),
    getChatActivity: vi.fn().mockResolvedValue({ sent: [], stops: [] }),
  };
}
