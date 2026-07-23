/**
 * Tests for `dorkos activity` (`commands/activity.ts`).
 *
 * Covers argument parsing and the happy path with the api-client mocked.
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
import { parseActivityArgs, runActivity } from '../activity.js';

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

describe('parseActivityArgs', () => {
  it('parses filters', () => {
    expect(
      parseActivityArgs(['--actor', 'agent', '--category', 'tasks', '--type', 'x', '--limit', '20'])
    ).toEqual({
      actor: 'agent',
      category: 'tasks',
      type: 'x',
      limit: 20,
      json: false,
    });
  });

  it('rejects a non-positive --limit', () => {
    expect(() => parseActivityArgs(['--limit', '0'])).toThrow(/Invalid value for --limit/);
  });

  it('throws on an unknown option', () => {
    expect(() => parseActivityArgs(['--nope'])).toThrow(/Unknown option for 'activity'/);
  });
});

describe('runActivity', () => {
  it('GETs /api/activity mapping flags to query params', async () => {
    apiCallMock.mockResolvedValue({ items: [], nextCursor: null });
    expect(await runActivity({ actor: 'agent', category: 'tasks', limit: 20, json: false })).toBe(
      0
    );
    expect(apiCallMock).toHaveBeenCalledWith(
      'GET',
      '/api/activity?actorType=agent&categories=tasks&limit=20'
    );
  });

  it('applies --type client-side after the fetch', async () => {
    apiCallMock.mockResolvedValue({
      items: [
        {
          id: '1',
          occurredAt: 't',
          actorType: 'user',
          actorLabel: 'You',
          category: 'agent',
          eventType: 'agent.registered',
          summary: 's',
        },
        {
          id: '2',
          occurredAt: 't',
          actorType: 'user',
          actorLabel: 'You',
          category: 'agent',
          eventType: 'agent.status_changed',
          summary: 's',
        },
      ],
      nextCursor: null,
    });
    const writeSpy = process.stdout.write as unknown as ReturnType<typeof vi.fn>;
    await runActivity({ type: 'agent.registered', json: true });
    const printed = writeSpy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(printed) as Array<{ id: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('1');
  });

  it('returns 1 on an API error', async () => {
    apiCallMock.mockRejectedValue(new ApiError(500, { error: 'boom' }));
    expect(await runActivity({ json: false })).toBe(1);
  });
});
