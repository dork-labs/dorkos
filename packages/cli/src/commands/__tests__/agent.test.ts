/**
 * Tests for `dorkos agent` (`commands/agent.ts`).
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
  parseAgentCreateArgs,
  parseAgentUpdateArgs,
  runAgentCreate,
  runAgentDispatcher,
  runAgentList,
  runAgentShow,
  runAgentUpdate,
} from '../agent.js';

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

describe('parseAgentCreateArgs', () => {
  it('parses required flags', () => {
    expect(parseAgentCreateArgs(['--name', 'my-bot', '--path', '/tmp/my-bot'])).toEqual({
      name: 'my-bot',
      path: '/tmp/my-bot',
      template: undefined,
      displayName: undefined,
      description: undefined,
      json: false,
    });
  });

  it('throws when --name is missing', () => {
    expect(() => parseAgentCreateArgs(['--path', '/tmp/x'])).toThrow(/Missing required --name/);
  });

  it('throws when --path is missing', () => {
    expect(() => parseAgentCreateArgs(['--name', 'x'])).toThrow(/Missing required --path/);
  });

  it('throws on an unknown option', () => {
    expect(() => parseAgentCreateArgs(['--name', 'x', '--path', 'y', '--nope'])).toThrow(
      /Unknown option for 'agent create'/
    );
  });
});

describe('parseAgentUpdateArgs', () => {
  it('requires --path', () => {
    expect(() => parseAgentUpdateArgs(['--display-name', 'X'])).toThrow(/Missing required --path/);
  });

  it('maps an empty --color to null (clear)', () => {
    expect(parseAgentUpdateArgs(['--path', '/a', '--color', ''])).toMatchObject({ color: null });
  });

  it('keeps a non-empty --icon as a string', () => {
    expect(parseAgentUpdateArgs(['--path', '/a', '--icon', '🤖'])).toMatchObject({ icon: '🤖' });
  });
});

describe('runAgentList', () => {
  it('GETs the mesh roster and prints a table', async () => {
    apiCallMock.mockResolvedValue({
      agents: [{ id: 'dorkbot', name: 'dorkbot', runtime: 'claude-code', healthStatus: 'active' }],
    });
    const code = await runAgentList(false);
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/mesh/agents');
  });

  it('prints raw JSON with --json', async () => {
    apiCallMock.mockResolvedValue({ agents: [{ id: 'a', name: 'a' }] });
    const writeSpy = process.stdout.write as unknown as ReturnType<typeof vi.fn>;
    const code = await runAgentList(true);
    expect(code).toBe(0);
    expect(writeSpy).toHaveBeenCalled();
  });

  it('returns 1 on an API error', async () => {
    apiCallMock.mockRejectedValue(new ApiError(500, { error: 'boom' }));
    expect(await runAgentList(false)).toBe(1);
  });
});

describe('runAgentShow', () => {
  it('resolves a bare id via the mesh endpoint', async () => {
    apiCallMock.mockResolvedValue({ id: 'dorkbot', name: 'dorkbot' });
    await runAgentShow('dorkbot', true);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/mesh/agents/dorkbot');
  });

  it('resolves a path via the agents/current endpoint', async () => {
    apiCallMock.mockResolvedValue({ id: 'x', name: 'x' });
    await runAgentShow('~/projects/app', true);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/agents/current?path=~%2Fprojects%2Fapp');
  });

  it('returns 1 when the path endpoint yields null', async () => {
    apiCallMock.mockResolvedValue(null);
    expect(await runAgentShow('/nope', false)).toBe(1);
  });
});

describe('runAgentCreate', () => {
  it('POSTs to /api/agents/create with directory mapped from --path', async () => {
    apiCallMock.mockResolvedValue({ id: 'new', name: 'my-bot', _path: '/tmp/my-bot' });
    const code = await runAgentCreate({
      name: 'my-bot',
      path: '/tmp/my-bot',
      template: undefined,
      displayName: undefined,
      description: undefined,
      json: false,
    });
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('POST', '/api/agents/create', {
      name: 'my-bot',
      directory: '/tmp/my-bot',
    });
  });
});

describe('runAgentUpdate', () => {
  it('PATCHes /api/agents/current with the path query and changed fields', async () => {
    apiCallMock.mockResolvedValue({ id: 'x', name: 'x' });
    const code = await runAgentUpdate({
      path: '/tmp/a',
      displayName: 'New Name',
      description: undefined,
      color: undefined,
      icon: undefined,
      json: false,
    });
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('PATCH', '/api/agents/current?path=%2Ftmp%2Fa', {
      displayName: 'New Name',
    });
  });

  it('returns 1 without calling the API when nothing changes', async () => {
    const code = await runAgentUpdate({
      path: '/tmp/a',
      displayName: undefined,
      description: undefined,
      color: undefined,
      icon: undefined,
      json: false,
    });
    expect(code).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalled();
  });
});

describe('runAgentDispatcher', () => {
  it('returns 1 and prints usage with no subcommand', async () => {
    expect(await runAgentDispatcher([])).toBe(1);
  });

  it('returns 0 for --help', async () => {
    expect(await runAgentDispatcher(['--help'])).toBe(0);
  });

  it('errors on an unknown subcommand', async () => {
    expect(await runAgentDispatcher(['frobnicate'])).toBe(1);
  });

  it('dispatches list', async () => {
    apiCallMock.mockResolvedValue({ agents: [] });
    expect(await runAgentDispatcher(['list'])).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/mesh/agents');
  });
});
