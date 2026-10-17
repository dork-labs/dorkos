/**
 * Mocks for the `Transport` slices split out of `mock-factories.ts`: what
 * happened (`ActivityTransport`), where every read answers an empty page, and
 * pausing agents (`AgentPauseTransport`), where nothing is paused and every
 * pause or resume succeeds, and held connected-app actions, where every cancel
 * succeeds. Heartbeats and a hub's computers come from their own mocks.
 *
 * @module test-utils/mock-transport-slices
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import { createMockComputerTransport } from './mock-computer-transport.js';
import { createMockLocalBrowserTransport } from './mock-local-browser-transport.js';
import { createMockHeartbeatTransport } from './mock-heartbeat-transport.js';
import { createMockHubTransport } from './mock-hub-transport.js';

/** The methods {@link transportSliceMocks} covers. */
type SliceMethods =
  | 'listActivityEvents'
  | 'listAuditEvents'
  | 'getAccountTimeline'
  | 'getChatActivity'
  | 'listAgentPauses'
  | 'pauseAgent'
  | 'resumeAgent'
  | 'cancelHeldConnectorAction';

/** Mocks for every method of the split-out `Transport` slices. */
export function transportSliceMocks(): Pick<Transport, SliceMethods> &
  ReturnType<typeof createMockHeartbeatTransport> &
  ReturnType<typeof createMockLocalBrowserTransport> &
  ReturnType<typeof createMockComputerTransport> &
  ReturnType<typeof createMockHubTransport> {
  return {
    ...createMockHeartbeatTransport(),
    ...createMockComputerTransport(),
    ...createMockLocalBrowserTransport(),
    ...createMockHubTransport(),
    listActivityEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listAuditEvents: vi.fn().mockResolvedValue({ events: [] }),
    getAccountTimeline: vi.fn().mockResolvedValue({ events: [] }),
    getChatActivity: vi.fn().mockResolvedValue({ sent: [], stops: [] }),
    listAgentPauses: vi.fn().mockResolvedValue({ pauses: [] }),
    pauseAgent: vi
      .fn()
      .mockImplementation(async (agentId: string) => ({ agentId, paused: true, changed: true })),
    resumeAgent: vi
      .fn()
      .mockImplementation(async (agentId: string) => ({ agentId, paused: false, changed: true })),
    cancelHeldConnectorAction: vi
      .fn()
      .mockImplementation(async (holdId: string) => ({ status: 'cancelled', holdId })),
  };
}
