/**
 * The to-dos slice of the mock Transport (spec `heartbeats` §12), spread
 * into `createMockTransport` the way the Transport port extends
 * `TodoPromiseTransport`.
 *
 * @module test-utils/mock-todo-promises
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The to-do methods of the Transport port. */
type TodoPromiseMethods = Pick<
  Transport,
  'listTodoPromises' | 'createTodoPromise' | 'updateTodoPromise'
>;

/**
 * Mock to-do methods: an empty list, a create that echoes an open
 * to-do, and an update a test must stub before using.
 */
export function todoPromiseTransportMocks(): TodoPromiseMethods {
  return {
    listTodoPromises: vi.fn().mockResolvedValue({ todoPromises: [] }),
    createTodoPromise: vi.fn().mockImplementation((agentId: string, body: { what: string }) =>
      Promise.resolve({
        id: 'todo-promise-1',
        agentId,
        to: null,
        what: body.what,
        dueAt: null,
        state: 'open',
        overdue: false,
        sourceSessionId: null,
        sourceRoomEntryId: null,
        createdAt: new Date(0).toISOString(),
        closedAt: null,
        note: null,
      })
    ),
    updateTodoPromise: vi.fn().mockRejectedValue(new Error('updateTodoPromise not mocked')),
  };
}
