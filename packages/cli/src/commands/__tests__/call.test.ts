/**
 * Tests for `dorkos call` (`commands/call.ts`).
 *
 * Covers argument parsing and the invoke flow with the api-client mocked — no
 * running server is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: string; details?: unknown }
    ) {
      super(body.error ?? `HTTP ${status}`);
    }
  }
  return { ApiError, apiCall: vi.fn() };
});

import { ApiError, apiCall } from '../../lib/api-client.js';
import { parseCallArgs, runCall } from '../call.js';

const apiCallMock = vi.mocked(apiCall);

/** A minimal catalog whose only id is `test.echo`, used to validate ids. */
const catalog = { capabilities: [{ id: 'test.echo' }] };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('parseCallArgs', () => {
  it('parses the id with default empty input', () => {
    expect(parseCallArgs(['operator.check_update'])).toEqual({
      id: 'operator.check_update',
      input: {},
    });
  });

  it('parses --input JSON', () => {
    expect(parseCallArgs(['test.echo', '--input', '{"msg":"hi"}'])).toEqual({
      id: 'test.echo',
      input: { msg: 'hi' },
    });
  });

  it('throws when the id is missing', () => {
    expect(() => parseCallArgs([])).toThrow(/Missing required <capability-id>/);
  });

  it('rejects both --input and --input-file together', () => {
    expect(() => parseCallArgs(['x', '--input', '{}', '--input-file', 'p.json'])).toThrow(
      /only one of --input or --input-file/
    );
  });

  it('throws on invalid JSON input', () => {
    expect(() => parseCallArgs(['x', '--input', '{not json'])).toThrow(/Invalid JSON input/);
  });

  it('throws on an unknown option', () => {
    expect(() => parseCallArgs(['x', '--nope'])).toThrow(/Unknown option for 'call'/);
  });
});

describe('runCall', () => {
  it('validates the id, POSTs to the invoke endpoint, and prints the result', async () => {
    apiCallMock.mockResolvedValueOnce(catalog); // catalog fetch
    apiCallMock.mockResolvedValueOnce({ echoed: 'hi' }); // invoke
    const writeSpy = process.stdout.write as unknown as ReturnType<typeof vi.fn>;

    const code = await runCall({ id: 'test.echo', input: { msg: 'hi' } });
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenNthCalledWith(1, 'GET', '/api/capabilities/catalog');
    expect(apiCallMock).toHaveBeenNthCalledWith(2, 'POST', '/api/capabilities/test.echo/invoke', {
      msg: 'hi',
    });
    const printed = writeSpy.mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(printed)).toEqual({ echoed: 'hi' });
  });

  it('rejects an unknown id without calling invoke', async () => {
    apiCallMock.mockResolvedValueOnce(catalog);
    const code = await runCall({ id: 'test.ghost', input: {} });
    expect(code).toBe(1);
    expect(apiCallMock).toHaveBeenCalledTimes(1); // catalog only, no invoke
  });

  it('surfaces a server validation error on stderr and exits non-zero', async () => {
    apiCallMock.mockResolvedValueOnce(catalog);
    apiCallMock.mockRejectedValueOnce(
      new ApiError(400, { error: 'Validation failed', details: { fieldErrors: {} } })
    );
    const errSpy = console.error as unknown as ReturnType<typeof vi.fn>;
    const code = await runCall({ id: 'test.echo', input: {} });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('Error: Validation failed');
  });

  it('returns 1 when the server is unreachable (catalog fetch fails)', async () => {
    apiCallMock.mockRejectedValueOnce(new Error('Cannot reach DorkOS server'));
    const code = await runCall({ id: 'test.echo', input: {} });
    expect(code).toBe(1);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });
});
