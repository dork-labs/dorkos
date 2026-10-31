/**
 * The work queue slice of the mock Transport (DOR-3462), and the one spread that
 * brings it and the commitments slice into `createMockTransport`, so that file
 * stays inside its line limit.
 *
 * @module test-utils/mock-work-queue
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import { commitmentTransportMocks } from './mock-commitments.js';

/** The work queue methods of the Transport port. */
type WorkQueueMethods = Pick<
  Transport,
  | 'getWorkQueue'
  | 'updateWorkQueue'
  | 'setWorkQueuesStopped'
  | 'reorderWorkQueue'
  | 'addWorkItem'
  | 'removeWorkItem'
  | 'requeueWorkItem'
>;

/**
 * Mock work queue methods: an empty queue that is off, and writes a test must stub
 * before using.
 */
function workQueueTransportMocks(): WorkQueueMethods {
  return {
    getWorkQueue: vi.fn().mockImplementation((agentId: string) =>
      Promise.resolve({
        agentId,
        enabled: false,
        target: 1,
        dailyStartCap: 20,
        startsToday: 0,
        allStopped: false,
        hold: null,
        items: [],
        recent: [],
      })
    ),
    updateWorkQueue: vi.fn().mockRejectedValue(new Error('updateWorkQueue not mocked')),
    setWorkQueuesStopped: vi.fn().mockRejectedValue(new Error('setWorkQueuesStopped not mocked')),
    reorderWorkQueue: vi.fn().mockRejectedValue(new Error('reorderWorkQueue not mocked')),
    addWorkItem: vi.fn().mockRejectedValue(new Error('addWorkItem not mocked')),
    removeWorkItem: vi.fn().mockRejectedValue(new Error('removeWorkItem not mocked')),
    requeueWorkItem: vi.fn().mockRejectedValue(new Error('requeueWorkItem not mocked')),
  };
}

/** The commitments and work queue methods, for `createMockTransport` to spread. */
export function agentWorkTransportMocks() {
  return { ...commitmentTransportMocks(), ...workQueueTransportMocks() };
}
