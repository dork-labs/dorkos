/**
 * Tests for `dorkos capabilities` (`commands/capabilities.ts`).
 *
 * Covers argument parsing, the table happy path, `--json` stdout purity, and the
 * error path (stderr + non-zero exit) with the api-client mocked.
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
import { parseCapabilitiesArgs, runCapabilities } from '../capabilities.js';

const apiCallMock = vi.mocked(apiCall);

const CATALOG = {
  catalogVersion: 'abc123def456',
  generatedAt: '2026-07-22T00:00:00.000Z',
  capabilities: [
    {
      id: 'operator.config_get',
      title: 'Get configuration',
      description: 'd',
      tier: 'observe',
    },
    { id: 'capabilities.list', title: 'List capabilities', description: 'd', tier: 'observe' },
  ],
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('parseCapabilitiesArgs', () => {
  it('defaults json to false', () => {
    expect(parseCapabilitiesArgs([])).toEqual({ json: false });
  });

  it('parses --json', () => {
    expect(parseCapabilitiesArgs(['--json'])).toEqual({ json: true });
  });

  it('throws on an unknown option', () => {
    expect(() => parseCapabilitiesArgs(['--nope'])).toThrow(/Unknown option for 'capabilities'/);
  });
});

describe('runCapabilities', () => {
  it('GETs the catalog and renders a table', async () => {
    apiCallMock.mockResolvedValue(CATALOG);
    expect(await runCapabilities({ json: false })).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/capabilities/catalog');
  });

  it('--json writes only the raw catalog to stdout', async () => {
    apiCallMock.mockResolvedValue(CATALOG);
    const writeSpy = process.stdout.write as unknown as ReturnType<typeof vi.fn>;
    expect(await runCapabilities({ json: true })).toBe(0);
    const printed = writeSpy.mock.calls.at(-1)?.[0] as string;
    // stdout is exactly the catalog JSON — nothing else.
    expect(JSON.parse(printed)).toEqual(CATALOG);
  });

  it('returns 1 on an API error (server unreachable)', async () => {
    apiCallMock.mockRejectedValue(new ApiError(500, { error: 'boom' }));
    expect(await runCapabilities({ json: false })).toBe(1);
  });
});
