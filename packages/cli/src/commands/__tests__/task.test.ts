/**
 * Tests for `dorkos task` (`commands/task.ts`).
 *
 * Covers argument parsing and one happy path per verb with the api-client
 * mocked — no running server is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: string }
    ) {
      super(body.error ?? `HTTP ${status}`);
    }
  }
  return { ApiError, apiCall: vi.fn() };
});

import { ApiError, apiCall } from '../../lib/api-client.js';
import {
  parseTaskCreateArgs,
  parseTaskRunsArgs,
  runTaskCreate,
  runTaskDispatcher,
  runTaskList,
  runTaskRuns,
  runTaskTrigger,
} from '../task.js';

const apiCallMock = vi.mocked(apiCall);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('parseTaskCreateArgs', () => {
  it('parses required flags', () => {
    expect(
      parseTaskCreateArgs([
        '--name',
        'nightly',
        '--description',
        'Nightly sweep',
        '--prompt',
        'Review PRs',
        '--target',
        'global',
        '--cron',
        '0 2 * * *',
      ])
    ).toMatchObject({
      name: 'nightly',
      description: 'Nightly sweep',
      prompt: 'Review PRs',
      target: 'global',
      cron: '0 2 * * *',
      json: false,
    });
  });

  it('throws when a required flag is missing', () => {
    expect(() => parseTaskCreateArgs(['--name', 'x'])).toThrow(/Missing required --description/);
  });

  it('throws on an unknown option', () => {
    expect(() =>
      parseTaskCreateArgs([
        '--name',
        'x',
        '--description',
        'd',
        '--prompt',
        'p',
        '--target',
        'global',
        '--nope',
      ])
    ).toThrow(/Unknown option for 'task create'/);
  });
});

describe('parseTaskRunsArgs', () => {
  it('parses filters', () => {
    expect(parseTaskRunsArgs(['--schedule', 's1', '--status', 'failed', '--limit', '5'])).toEqual({
      scheduleId: 's1',
      status: 'failed',
      limit: 5,
      json: false,
    });
  });

  it('rejects a non-positive --limit', () => {
    expect(() => parseTaskRunsArgs(['--limit', '0'])).toThrow(/Invalid value for --limit/);
  });
});

describe('runTaskList', () => {
  it('GETs /api/tasks and prints a table', async () => {
    apiCallMock.mockResolvedValue([
      { id: 't1', name: 'nightly', cron: '0 2 * * *', enabled: true, nextRun: null },
    ]);
    expect(await runTaskList(false)).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/tasks');
  });

  it('returns 1 on an API error', async () => {
    apiCallMock.mockRejectedValue(new ApiError(500, { error: 'boom' }));
    expect(await runTaskList(false)).toBe(1);
  });
});

describe('runTaskCreate', () => {
  it('POSTs /api/tasks with the body', async () => {
    apiCallMock.mockResolvedValue({ id: 't1', name: 'nightly', enabled: true });
    const code = await runTaskCreate({
      name: 'nightly',
      description: 'd',
      prompt: 'p',
      target: 'global',
      cron: '0 2 * * *',
      timezone: undefined,
      displayName: undefined,
      json: false,
    });
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('POST', '/api/tasks', {
      name: 'nightly',
      description: 'd',
      prompt: 'p',
      target: 'global',
      cron: '0 2 * * *',
    });
  });
});

/**
 * The honesty line on `task create` (spec `full-power-defaults`, D6).
 *
 * This command has no flag for the permission mode, so the server always
 * resolves one from the operator's configured trust stop — which on a
 * full-power install arms a cron that will never pause to ask. The line exists
 * so that is said out loud, and these cases pin that it is said only when true,
 * and never at the cost of the create.
 */
describe('runTaskCreate — naming an unattended level', () => {
  /** The create arguments every case below shares. */
  const args = {
    name: 'nightly',
    description: 'd',
    prompt: 'p',
    target: 'global',
    cron: '0 2 * * *',
    timezone: undefined,
    displayName: undefined,
    json: false,
  };

  /** Claude Code's real declarations for the two modes these cases resolve to. */
  const CAPABILITIES = {
    capabilities: {
      'claude-code': {
        permissionModes: {
          values: [
            {
              id: 'acceptEdits',
              label: 'Accept edits',
              stop: 'act',
              asks: 'risky',
              reach: 'write',
            },
            {
              id: 'bypassPermissions',
              label: 'Full autonomy',
              stop: 'autonomy',
              asks: 'never',
              reach: 'all',
            },
          ],
        },
      },
    },
  };

  /**
   * Answer the create POST, then the capabilities GET.
   *
   * @param permissionMode - The mode the server resolved onto the new task.
   */
  function mockCreateResolving(permissionMode: string): void {
    apiCallMock.mockImplementation((method: string, path: string) =>
      Promise.resolve(
        path === '/api/capabilities'
          ? CAPABILITIES
          : { id: 't1', name: 'nightly', enabled: true, permissionMode }
      )
    );
  }

  it('says so plainly when the resolved level never stops to ask', async () => {
    mockCreateResolving('bypassPermissions');

    expect(await runTaskCreate(args)).toBe(0);

    const said = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(said.some((line) => line.includes('Runs at full power'))).toBe(true);
  });

  it('stays quiet when the resolved level still stops for the risky parts', async () => {
    mockCreateResolving('acceptEdits');

    expect(await runTaskCreate(args)).toBe(0);

    const said = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(said.some((line) => line.includes('full power'))).toBe(false);
    // The success line is still printed — the advisory is additive.
    expect(said.some((line) => line.includes('Created scheduled task'))).toBe(true);
  });

  it('reads the judgement off the runtime, not off the mode id', async () => {
    // The substrate rule. A runtime that files this id at the middle stop with
    // ordinary asking gets no scary line, however the id reads to a human.
    apiCallMock.mockImplementation((method: string, path: string) =>
      Promise.resolve(
        path === '/api/capabilities'
          ? {
              capabilities: {
                'claude-code': {
                  permissionModes: {
                    values: [
                      {
                        id: 'bypassPermissions',
                        label: 'Sandboxed',
                        stop: 'act',
                        asks: 'risky',
                        reach: 'write',
                      },
                    ],
                  },
                },
              },
            }
          : { id: 't1', name: 'nightly', enabled: true, permissionMode: 'bypassPermissions' }
      )
    );

    expect(await runTaskCreate(args)).toBe(0);

    const said = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(said.some((line) => line.includes('full power'))).toBe(false);
  });

  it('never fails a create it has already made, when the lookup goes wrong', async () => {
    apiCallMock.mockImplementation((method: string, path: string) =>
      path === '/api/capabilities'
        ? Promise.reject(new ApiError(500, { error: 'boom' }))
        : Promise.resolve({ id: 't1', name: 'nightly', enabled: true, permissionMode: 'whatever' })
    );

    expect(await runTaskCreate(args)).toBe(0);
  });
});

describe('runTaskTrigger', () => {
  it('POSTs the trigger route and returns 0', async () => {
    apiCallMock.mockResolvedValue({ runId: 'r1' });
    expect(await runTaskTrigger('t1', false)).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('POST', '/api/tasks/t1/trigger');
  });
});

describe('runTaskRuns', () => {
  it('GETs /api/tasks/runs with a query string', async () => {
    apiCallMock.mockResolvedValue([{ id: 'r1', scheduleId: 't1', status: 'success' }]);
    expect(await runTaskRuns({ scheduleId: 't1', limit: 5, json: false })).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/tasks/runs?scheduleId=t1&limit=5');
  });
});

describe('runTaskDispatcher', () => {
  it('returns 1 with no subcommand', async () => {
    expect(await runTaskDispatcher([])).toBe(1);
  });

  it('errors on an unknown subcommand', async () => {
    expect(await runTaskDispatcher(['frobnicate'])).toBe(1);
  });

  it('requires an id for trigger', async () => {
    expect(await runTaskDispatcher(['trigger'])).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalled();
  });
});
