/**
 * The heartbeat method of a mock `Transport` (spec `heartbeats` §7.6), kept in
 * its own file and spread into `createMockTransport`.
 *
 * @module test-utils/mock-heartbeat-transport
 */
import { vi } from 'vitest';
import type { HeartbeatTransport } from '@dorkos/shared/transport-heartbeats';

/**
 * Mock heartbeat methods: an agent that wakes on events, with no beats yet,
 * whose checks run on its own runtime and no credits offer standing.
 */
export function createMockHeartbeatTransport(): HeartbeatTransport {
  return {
    getAgentHeartbeat: vi.fn().mockResolvedValue({
      enabled: true,
      wake: 'events',
      nextBeatAt: null,
      skippedReason: null,
      fileError: null,
      lastBeats: [],
      held: [],
      report: { cadence: 'daily', to: 'owner', nextReportAt: null, items: 0 },
      checks: { runsOn: 'runtime', runtime: 'claude-code', today: 0, tokens: 0, offer: false },
    }),
    chooseTriageCredits: vi
      .fn()
      .mockImplementation(async (useCredits: boolean) => ({ useCredits })),
  };
}
