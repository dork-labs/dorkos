/** The to-do calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, firstRequest } from './request-stub';
import { createTodoMethods } from '../todo-methods';

afterEach(() => vi.unstubAllGlobals());

describe('createTodoMethods', () => {
  const methods = createTodoMethods('/api');

  it('sends the list filters in order, showDone only when true, and nothing for none', async () => {
    let fetchMock = answer({ todos: [] });
    await methods.listTodos({
      view: 'agents',
      agentId: 'a 1',
      roomId: 'r1',
      due: 'today',
      showDone: true,
      sort: 'due',
      limit: 20,
    });
    expect(firstRequest(fetchMock).url).toBe(
      '/api/todos?view=agents&agentId=a+1&roomId=r1&due=today&showDone=true&sort=due&limit=20'
    );

    fetchMock = answer({ todos: [] });
    await methods.listTodos({ showDone: false });
    expect(firstRequest(fetchMock)).toEqual({ url: '/api/todos', method: 'GET', body: undefined });
  });

  it('reads, creates and edits one to-do', async () => {
    let fetchMock = answer({});
    await methods.getTodo('t 1');
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/todos/t%201',
      method: 'GET',
      body: undefined,
    });

    fetchMock = answer({});
    await methods.createTodo({ what: 'Ship it', assignee: { kind: 'agent', agentId: 'a1' } });
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/todos',
      method: 'POST',
      body: '{"what":"Ship it","assignee":{"kind":"agent","agentId":"a1"}}',
    });

    fetchMock = answer({});
    await methods.updateTodo('t/1', { state: 'kept', notes: null });
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/todos/t%2F1',
      method: 'PATCH',
      body: '{"state":"kept","notes":null}',
    });
  });
});
