/** The Tasks calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTasksMethods } from '../task-methods';
import { answer, firstRequest } from './request-stub';

/** The first request, with `fetch`'s own GET default named. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const request = firstRequest(fetchMock);
  return { ...request, method: request.method ?? 'GET' };
}

afterEach(() => vi.unstubAllGlobals());

describe('createTasksMethods', () => {
  const methods = createTasksMethods('/api');

  it('reads and removes schedules, approves a file and reads runs at the same paths and bodies', async () => {
    const calls: Array<[() => Promise<unknown>, ReturnType<typeof sent>]> = [
      [() => methods.listTasks(), { url: '/api/tasks', method: 'GET', body: undefined }],
      [() => methods.deleteTask('t1'), { url: '/api/tasks/t1', method: 'DELETE', body: undefined }],
      [
        () => methods.approveTaskFile('t1', null, 'h1'),
        { url: '/api/tasks/t1/approve-file', method: 'POST', body: '{"hash":"h1"}' },
      ],
      [
        () => methods.approveTaskFile('t1', '2026-01-01T00:00:00Z', 'h1'),
        {
          url: '/api/tasks/t1/approve-file',
          method: 'POST',
          body: '{"capAt":"2026-01-01T00:00:00Z","hash":"h1"}',
        },
      ],
      [
        () => methods.listTaskRuns({ scheduleId: 't1', status: 'failed', limit: 5, offset: 10 }),
        {
          url: '/api/tasks/runs?scheduleId=t1&status=failed&limit=5&offset=10',
          method: 'GET',
          body: undefined,
        },
      ],
      [() => methods.listTaskRuns(), { url: '/api/tasks/runs', method: 'GET', body: undefined }],
      [
        () => methods.getTaskRun('r1'),
        { url: '/api/tasks/runs/r1', method: 'GET', body: undefined },
      ],
    ];
    for (const [call, expected] of calls) {
      const fetchMock = answer({});
      await call();
      expect(sent(fetchMock)).toEqual(expected);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    }
  });

  it('throws a refusal as the app error, with its code and status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'urn:dorkos:problem:task_not_found',
              title: 'Not found',
              status: 404,
              code: 'task_not_found',
              detail: 'No such schedule.',
            }),
            { status: 404, headers: { 'Content-Type': 'application/problem+json' } }
          )
      )
    );
    await expect(methods.deleteTask('t1')).rejects.toMatchObject({
      message: 'No such schedule.',
      code: 'task_not_found',
      status: 404,
    });
  });
});
