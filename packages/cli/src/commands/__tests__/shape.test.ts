/**
 * Tests for `dorkos shape` (`commands/shape.ts`).
 *
 * Covers argument parsing, the `fork` HTTP call (api-client mocked), and
 * subcommand dispatch. No running server is needed — the api-client is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { parseShapeForkArgs, runShapeDispatcher, runShapeFork } from '../shape.js';

const apiCallMock = vi.mocked(apiCall);

describe('parseShapeForkArgs', () => {
  it('parses a bare name', () => {
    expect(parseShapeForkArgs(['linear-ops'])).toEqual({
      name: 'linear-ops',
      as: undefined,
      captureCurrent: false,
    });
  });

  it('parses --as and --capture-current', () => {
    expect(parseShapeForkArgs(['linear-ops', '--as', 'my-ops', '--capture-current'])).toEqual({
      name: 'linear-ops',
      as: 'my-ops',
      captureCurrent: true,
    });
  });

  it('throws when the name is missing', () => {
    expect(() => parseShapeForkArgs([])).toThrow(/Missing required <name>/);
  });

  it('throws on an unknown option', () => {
    expect(() => parseShapeForkArgs(['x', '--nope'])).toThrow(/Unknown option/);
  });
});

describe('runShapeFork', () => {
  afterEach(() => vi.clearAllMocks());

  it('POSTs to the fork route with the body and returns 0', async () => {
    apiCallMock.mockResolvedValue({
      ok: true,
      name: 'my-ops',
      forkedFrom: 'linear-ops@local',
      installPath: '/home/.dork/shapes/my-ops',
    });

    const code = await runShapeFork({ name: 'linear-ops', as: 'my-ops', captureCurrent: true });
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('POST', '/api/shapes/linear-ops/fork', {
      as: 'my-ops',
      captureCurrent: true,
    });
  });

  it('returns 1 on an API error', async () => {
    apiCallMock.mockRejectedValue(new ApiError(404, { error: 'Shape not installed' }));
    const code = await runShapeFork({ name: 'ghost' });
    expect(code).toBe(1);
  });
});

describe('runShapeDispatcher', () => {
  afterEach(() => vi.clearAllMocks());

  it('routes fork to the fork handler', async () => {
    apiCallMock.mockResolvedValue({
      ok: true,
      name: 'linear-ops-fork',
      forkedFrom: 'linear-ops@local',
      installPath: '/x',
    });
    const code = await runShapeDispatcher(['fork', 'linear-ops']);
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('POST', '/api/shapes/linear-ops/fork', {});
  });

  it('returns 1 for an unknown subcommand', async () => {
    const code = await runShapeDispatcher(['bogus']);
    expect(code).toBe(1);
  });

  it('prints help and returns 0 for --help', async () => {
    const code = await runShapeDispatcher(['--help']);
    expect(code).toBe(0);
  });
});
