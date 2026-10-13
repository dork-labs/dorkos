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

  it('parses --runtime, --model and --effort (DOR-1615/DOR-1347)', () => {
    // Passed through unvalidated on purpose: which runtimes are registered and
    // which model ids they offer are the SERVER's questions, and it answers a
    // bad value with a message naming it. A second opinion here would go stale
    // the day a runtime ships.
    expect(
      parseTaskCreateArgs([
        ...['--name', 'nightly'],
        ...['--description', 'd'],
        ...['--prompt', 'p'],
        ...['--target', 'global'],
        ...['--runtime', 'codex'],
        ...['--model', 'gpt-5.5'],
        ...['--effort', 'high'],
      ])
    ).toMatchObject({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' });
  });

  it('leaves all three undefined when the flags are absent', () => {
    // Absent means "whatever this task's agent runs on" — the answer every
    // scheduled task gave before the flags existed.
    expect(
      parseTaskCreateArgs([
        ...['--name', 'nightly'],
        ...['--description', 'd'],
        ...['--prompt', 'p'],
        ...['--target', 'global'],
      ])
    ).toMatchObject({ runtime: undefined, model: undefined, effort: undefined });
  });

  it('names the three flags in its usage line', () => {
    // The usage string is the only place a person discovers them.
    let usage = '';
    try {
      parseTaskCreateArgs(['--name', 'x']);
    } catch (err) {
      usage = (err as Error).message;
    }
    expect(usage).toContain('--runtime');
    expect(usage).toContain('--model');
    expect(usage).toContain('--effort');
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

  it('sends runtime, model and effort when they were given, and omits them otherwise', async () => {
    apiCallMock.mockResolvedValue({ id: 't1', name: 'nightly', enabled: true });
    const base = {
      name: 'nightly',
      description: 'd',
      prompt: 'p',
      target: 'global',
      cron: '0 2 * * *',
      timezone: undefined,
      displayName: undefined,
      json: false,
    };

    await runTaskCreate({ ...base, runtime: 'codex', model: 'gpt-5.5', effort: 'high' });
    expect(apiCallMock).toHaveBeenLastCalledWith(
      'POST',
      '/api/tasks',
      expect.objectContaining({ runtime: 'codex', model: 'gpt-5.5', effort: 'high' })
    );

    // An omitted flag must leave the key OFF the body, not send `undefined`:
    // the server reads presence, and `null` there means "clear the override".
    await runTaskCreate(base);
    const [, , body] = apiCallMock.mock.calls.at(-1)!;
    expect(body).not.toHaveProperty('runtime');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('effort');
  });

  it('prints only the created line for a full-power task, with no capability lookup', async () => {
    // Trusted by default (ADR 261006-225605): full power is the expected level
    // for a schedule, so creating one no longer prints a warning about it.
    apiCallMock.mockResolvedValue({
      id: 't1',
      name: 'nightly',
      enabled: true,
      permissionMode: 'bypassPermissions',
    });

    expect(
      await runTaskCreate({
        name: 'nightly',
        description: 'd',
        prompt: 'p',
        target: 'global',
        cron: '0 2 * * *',
        timezone: undefined,
        displayName: undefined,
        json: false,
      })
    ).toBe(0);

    const said = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(said).toEqual(['Created scheduled task nightly (t1)']);
    expect(apiCallMock).not.toHaveBeenCalledWith('GET', '/api/capabilities');
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
