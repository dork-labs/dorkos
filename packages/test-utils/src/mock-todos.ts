/**
 * The to-dos slice of the mock Transport (DOR-3088), spread into `createMockTransport` the way
 * the Transport port extends `TodoTransport`, and a factory for one to-do.
 *
 * @module test-utils/mock-todos
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import type { CreateTodoRequest, Todo } from '@dorkos/shared/todo-schemas';

/** The to-do methods of the Transport port. */
type TodoMethods = Pick<Transport, 'listTodos' | 'createTodo' | 'updateTodo'>;

/**
 * One open to-do the person made and assigned to themselves, with no date, no room and no
 * source, overridden field by field.
 *
 * @param overrides - The fields this test cares about.
 */
export function createMockTodo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: 'todo-1',
    what: 'Send the invoice',
    assignee: { kind: 'person', account: 'owner' },
    assignedBy: { kind: 'person', id: 'owner' },
    to: null,
    dueAt: null,
    state: 'open',
    overdue: false,
    roomId: null,
    sourceEntryId: null,
    sourceAuthor: null,
    titleFromSource: false,
    notes: null,
    note: null,
    rank: null,
    chainDepth: 0,
    strangerBound: false,
    createdAt: new Date(0).toISOString(),
    closedAt: null,
    ...overrides,
  };
}

/**
 * Mock to-do methods: an empty list with nothing hidden and no badge, a create that echoes an
 * open to-do the person made, and an update a test must stub before using.
 */
export function todoTransportMocks(): TodoMethods {
  return {
    listTodos: vi.fn().mockResolvedValue({ todos: [], doneCount: 0, badge: 0 }),
    createTodo: vi.fn().mockImplementation((body: CreateTodoRequest): Promise<Todo> =>
      Promise.resolve(
        createMockTodo({
          what: body.what,
          assignee: body.assignee,
          to: body.to ?? null,
          dueAt: body.dueAt ?? null,
          roomId: body.roomId ?? null,
          sourceEntryId: body.sourceEntryId ?? null,
          notes: body.notes ?? null,
          rank: body.rank ?? null,
        })
      )
    ),
    updateTodo: vi.fn().mockRejectedValue(new Error('updateTodo not mocked')),
  };
}
