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
    expect(apiCallMock).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/api/capabilities/catalog?detail=full&limit=200'
    );
    expect(apiCallMock).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/api/capabilities/test.echo/invoke',
      { msg: 'hi' },
      // No approval token presented, so no approval header is attached.
      undefined
    );
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

/**
 * `--approval` completes the dance for a capability that cannot be undone
 * (spec `agent-trust` §3.2): a first call comes back saying a person has to
 * approve, and the retry carries the token in the header the payload names.
 */
describe('runCall — approval flow', () => {
  it('sends the approval token as a header when --approval is passed', async () => {
    apiCallMock.mockResolvedValueOnce({ capabilities: [{ id: 'test.destroy' }] });
    apiCallMock.mockResolvedValueOnce({ destroyed: 'thing' });

    const code = await runCall({
      id: 'test.destroy',
      input: { name: 'thing' },
      approvalToken: 'abc123',
    });

    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/api/capabilities/test.destroy/invoke',
      { name: 'thing' },
      { 'X-DorkOS-Approval': 'abc123' }
    );
  });

  it('prints the approval_required payload and reports that nothing ran', async () => {
    apiCallMock.mockResolvedValueOnce({ capabilities: [{ id: 'test.destroy' }] });
    const payload = {
      status: 'approval_required',
      approvalId: '01JZ',
      approvalToken: 'abc123',
      message: 'A person has to approve this first.',
    };
    apiCallMock.mockResolvedValueOnce(payload);

    const code = await runCall({ id: 'test.destroy', input: { name: 'thing' } });

    // Non-zero, because the capability did NOT run — but the payload is still on
    // stdout so an agent can read the token and retry.
    expect(code).toBe(1);
    expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(payload, null, 2)}\n`);
  });

  it('parses --approval off the command line', () => {
    expect(parseCallArgs(['test.destroy', '--approval', ' abc123 '])).toEqual({
      id: 'test.destroy',
      input: {},
      approvalToken: 'abc123',
    });
  });

  it('ignores an empty --approval value', () => {
    expect(parseCallArgs(['test.destroy', '--approval', '  '])).toEqual({
      id: 'test.destroy',
      input: {},
    });
  });
});
