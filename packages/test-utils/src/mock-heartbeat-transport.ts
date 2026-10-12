/**
 * The heartbeat method of a mock `Transport` (spec `heartbeats` §7.6), kept in
 * its own file and spread into `createMockTransport`.
 *
 * @module test-utils/mock-heartbeat-transport
 */
import { vi } from 'vitest';
import type { HeartbeatMeasures } from '@dorkos/shared/heartbeat-schemas';
import type { HeartbeatTransport } from '@dorkos/shared/transport-heartbeats';

/**
 * A rate with nothing counted yet, beside its target.
 *
 * @param target - The starting target.
 */
function emptyRate(target: string) {
  return { value: null, part: 0, whole: 0, target, source: 'Counted from the record.' };
}

/**
 * The measures of an agent with no beats yet (spec `heartbeats` §13): every
 * rate empty, every count zero, the targets canon §6.1 starts with.
 */
export function emptyHeartbeatMeasures(): HeartbeatMeasures {
  return {
    windowDays: 7,
    since: '2026-10-05T12:00:00.000Z',
    keptRate: emptyRate('95% or more'),
    usefulRaiseRate: emptyRate('60% or more'),
    interruptions: {
      value: null,
      messages: 0,
      usefulOutcomes: 0,
      target: '1 or less',
      source: 'Counted from the record.',
    },
    surprises: { measured: false, source: 'Not measured yet.' },
    mutesAndPauses: {
      total: 0,
      pauses: 0,
      wakeOff: 0,
      mutes: 0,
      target: 'Trending to 0',
      source: 'Counted from the record.',
    },
    supporting: {
      beats: 0,
      quietBeats: emptyRate('80% or more'),
      commitmentsOnTime: emptyRate('90% or more'),
      noEndBeat: 0,
      triage: { checks: 0, tokens: 0 },
      turns: { count: 0, tokensPerTurn: null },
      bypass: 0,
      held: 0,
    },
  };
}

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
      measures: emptyHeartbeatMeasures(),
    }),
    chooseTriageCredits: vi
      .fn()
      .mockImplementation(async (useCredits: boolean) => ({ useCredits })),
  };
}
