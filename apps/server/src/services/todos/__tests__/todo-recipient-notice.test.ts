/**
 * Telling whoever a promise was made to that its agent moved or dropped it (DOR-3034): a person
 * through the Inbox, an agent through a message from the promising agent's chat, an outsider not
 * at all, and a failed notice never breaking the change.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import {
  agentNoticeText,
  createTodoRecipientNotice,
  recipientOf,
  type TodoRecipientNoticeDeps,
} from '../notice/todo-recipient-notice.js';
import { TODO_CHANGE_ENTRIES } from '../notice/todo-change-notifications.js';

const AT = new Date('2026-11-15T17:00:00.000Z');

function promise(over: Partial<TodoPromise> = {}): TodoPromise {
  return {
    id: 'todo-1',
    agentId: 'agent-ana',
    to: 'owner',
    what: 'Send Acme the revised quote',
    dueAt: '2026-11-20T17:00:00.000Z',
    originalDueAt: '2026-11-18T17:00:00.000Z',
    scoreDueAt: '2026-11-20T17:00:00.000Z',
    moveCount: 1,
    confirmState: null,
    delivered: null,
    state: 'open',
    overdue: false,
    sourceSessionId: null,
    sourceRoomEntryId: null,
    createdAt: '2026-11-10T09:00:00.000Z',
    closedAt: null,
    note: 'An old note',
    ...over,
  };
}

function build(over: Partial<TodoRecipientNoticeDeps> = {}) {
  const deps = {
    isAgent: (id: string) => id.startsWith('agent-'),
    agentName: (id: string) => (id === 'agent-ana' ? 'Ana' : undefined),
    dateWords: () => 'Fri, Nov 20',
    askConfirm: vi.fn(() => true),
    notifyPerson: vi.fn(),
    sendToAgent: vi.fn().mockResolvedValue(undefined),
    now: () => AT,
    ...over,
  };
  return { deps, tell: createTodoRecipientNotice(deps) };
}

describe('recipientOf', () => {
  it('reads an agent id as an agent, an outsider as nobody, and anything else as a person', () => {
    const isAgent = (id: string) => id === 'agent-bo';
    expect(recipientOf('agent-bo', isAgent)).toEqual({ kind: 'agent', agentId: 'agent-bo' });
    expect(recipientOf('external:Acme', isAgent)).toBeNull();
    expect(recipientOf(null, isAgent)).toBeNull();
    expect(recipientOf('owner', isAgent)).toEqual({ kind: 'person' });
  });
});

describe('createTodoRecipientNotice', () => {
  it('tells a person in the Inbox with the reason given for this change, not an older note', async () => {
    const { deps, tell } = build();
    await tell({ todoPromise: promise(), change: 'moved', reason: 'Waiting on their numbers' });
    expect(deps.notifyPerson).toHaveBeenCalledWith({
      todoId: 'todo-1',
      agentId: 'agent-ana',
      agentName: 'Ana',
      what: 'Send Acme the revised quote',
      change: 'moved',
      note: 'Waiting on their numbers',
      newDue: 'Fri, Nov 20',
      delivered: null,
      at: AT.toISOString(),
    });
  });

  it('tells an agent from the promising agent’s chat', async () => {
    const { deps, tell } = build();
    await tell({
      todoPromise: promise({ to: 'agent-bo' }),
      change: 'dropped',
      reason: null,
      sessionId: 'chat-1',
      agentPath: '/agents/ana',
    });
    expect(deps.sendToAgent).toHaveBeenCalledWith(
      { sessionId: 'chat-1', agentPath: '/agents/ana' },
      'agent-bo',
      'Ana dropped the promise it made you: "Send Acme the revised quote". No reason given.'
    );
    expect(deps.notifyPerson).not.toHaveBeenCalled();
  });

  it('tells nobody about a promise to an outsider or to the agent itself', async () => {
    const { deps, tell } = build();
    await tell({ todoPromise: promise({ to: 'external:Acme' }), change: 'moved', reason: null });
    await tell({ todoPromise: promise({ to: 'agent-ana' }), change: 'moved', reason: null });
    expect(deps.notifyPerson).not.toHaveBeenCalled();
    expect(deps.sendToAgent).not.toHaveBeenCalled();
  });

  it('asks a person to confirm a kept promise, and stays quiet for an agent (DOR-3034)', async () => {
    const { deps, tell } = build();
    await tell({
      todoPromise: promise({ state: 'kept', delivered: 'https://example.com/pr/1' }),
      change: 'kept',
      reason: null,
    });
    expect(deps.askConfirm).toHaveBeenCalledWith('todo-1');
    expect(deps.notifyPerson).toHaveBeenCalledWith(
      expect.objectContaining({ change: 'kept', delivered: 'https://example.com/pr/1' })
    );
    await tell({
      todoPromise: promise({ to: 'agent-bo', state: 'kept' }),
      change: 'kept',
      reason: null,
    });
    expect(deps.sendToAgent).not.toHaveBeenCalled();
  });

  it('raises nothing when a kept promise is not waiting for an answer', async () => {
    const { deps, tell } = build({ askConfirm: vi.fn(() => false) });
    await tell({ todoPromise: promise({ state: 'kept' }), change: 'kept', reason: null });
    expect(deps.notifyPerson).not.toHaveBeenCalled();
  });

  it('never throws when the notice fails', async () => {
    const { tell } = build({
      notifyPerson: vi.fn(() => {
        throw new Error('down');
      }),
    });
    await expect(
      tell({ todoPromise: promise(), change: 'dropped', reason: 'No longer needed' })
    ).resolves.toBeUndefined();
  });
});

describe('the todo.changed notice', () => {
  const base = {
    todoId: 't',
    agentId: 'agent-ana',
    agentName: 'Ana',
    what: 'Send Acme the revised quote',
    at: AT.toISOString(),
  };

  it('says the new date and the reason for a move, and only the reason for a drop', () => {
    const entry = TODO_CHANGE_ENTRIES['todo.changed'];
    const body = entry.body!;
    expect(entry.title({ ...base, change: 'moved', note: null, newDue: 'Fri, Nov 20' })).toBe(
      'Ana moved “Send Acme the revised quote”'
    );
    expect(body({ ...base, change: 'moved', note: 'Blocked', newDue: 'Fri, Nov 20' })).toBe(
      'Now due Fri, Nov 20. Why: Blocked'
    );
    expect(body({ ...base, change: 'moved', note: null, newDue: null })).toBe(
      'Now with no date. No reason given.'
    );
    expect(
      body({
        ...base,
        change: 'kept',
        note: null,
        newDue: null,
        delivered: 'https://github.com/acme/app/pull/12',
      })
    ).toBe('Done? Answer Yes or Not yet on Ana’s to-dos. Delivered · github.com');
    expect(body({ ...base, change: 'kept', note: null, newDue: null, delivered: 'pr/1' })).toBe(
      'Done? Answer Yes or Not yet on Ana’s to-dos.'
    );
    expect(body({ ...base, change: 'dropped', note: 'Not needed', newDue: null })).toBe(
      'Why: Not needed'
    );
  });
});

describe('agentNoticeText', () => {
  it('says the new date of a moved promise', () => {
    expect(
      agentNoticeText('Ana', { todoPromise: promise(), change: 'moved', reason: 'Blocked' })
    ).toBe(
      'Ana moved the promise it made you: "Send Acme the revised quote", now due 2026-11-20T17:00:00.000Z. Why: Blocked'
    );
  });
});
