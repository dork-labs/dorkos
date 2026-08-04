/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/client';

vi.mock('@/db/client', () => ({ getDb: vi.fn() }));

import { GET } from '../route';

const INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

let mockLimit: ReturnType<typeof vi.fn>;
let mockOrderBy: ReturnType<typeof vi.fn>;
let mockWhere: ReturnType<typeof vi.fn>;
let mockFrom: ReturnType<typeof vi.fn>;
let mockSelect: ReturnType<typeof vi.fn>;
let rows: Array<Record<string, unknown>>;

beforeEach(() => {
  rows = [
    {
      id: 'row-1',
      kind: 'idea',
      message: 'Let me pin a session to the top of the list',
      status: 'shipped',
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      shippedVersion: '0.56.3',
      hasScreenshot: false,
      hasTranscript: false,
    },
    {
      id: 'row-2',
      kind: 'bug',
      message: 'Chat stopped updating after the stream dropped',
      status: 'in_progress',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      shippedVersion: null,
      hasScreenshot: true,
      hasTranscript: true,
    },
  ];

  mockLimit = vi.fn().mockImplementation(() => Promise.resolve(rows));
  mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
  mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
  mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  vi.mocked(getDb).mockReturnValue({ select: mockSelect } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

function get(query: string): Promise<Response> {
  return GET(new Request(`https://dorkos.ai/api/feedback/mine${query}`));
}

describe('GET /api/feedback/mine', () => {
  it('returns the list, scoped to the given instanceId, with shippedVersion only when present', async () => {
    const res = await get(`?instanceId=${INSTANCE_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([
      {
        id: 'row-1',
        kind: 'idea',
        message: 'Let me pin a session to the top of the list',
        status: 'shipped',
        createdAt: '2026-07-28T00:00:00.000Z',
        shippedVersion: '0.56.3',
        hasScreenshot: false,
        hasTranscript: false,
      },
      {
        id: 'row-2',
        kind: 'bug',
        message: 'Chat stopped updating after the stream dropped',
        status: 'in_progress',
        createdAt: '2026-08-01T00:00:00.000Z',
        hasScreenshot: true,
        hasTranscript: true,
      },
    ]);
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it('never includes contact, reporter identity, or Linear ids/urls in the projection', async () => {
    await get(`?instanceId=${INSTANCE_ID}`);
    const projection = mockSelect.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual([
      'createdAt',
      'hasScreenshot',
      'hasTranscript',
      'id',
      'kind',
      'message',
      'shippedVersion',
      'status',
    ]);
  });

  it('returns [] (200) for an instanceId that matches nothing — never an error', async () => {
    rows = [];
    const res = await get('?instanceId=00000000-0000-0000-0000-000000000099');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns 400 when instanceId is missing', async () => {
    const res = await get('');
    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns 400 when instanceId is empty', async () => {
    const res = await get('?instanceId=');
    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns 400 when instanceId exceeds the length cap', async () => {
    const res = await get(`?instanceId=${'x'.repeat(200)}`);
    expect(res.status).toBe(400);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
