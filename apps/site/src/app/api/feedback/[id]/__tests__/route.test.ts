/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/client';

vi.mock('@/db/client', () => ({ getDb: vi.fn() }));

import { GET } from '../route';

const VALID_ID = '00000000-0000-0000-0000-000000000000';

let mockLimit: ReturnType<typeof vi.fn>;
let mockWhere: ReturnType<typeof vi.fn>;
let mockFrom: ReturnType<typeof vi.fn>;
let mockSelect: ReturnType<typeof vi.fn>;
let row: Record<string, unknown> | undefined;

beforeEach(() => {
  row = {
    status: 'in_progress',
    kind: 'bug',
    createdAt: new Date('2026-07-28T12:00:00.000Z'),
    shippedVersion: null,
  };
  mockLimit = vi.fn().mockImplementation(() => Promise.resolve(row ? [row] : []));
  mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  vi.mocked(getDb).mockReturnValue({ select: mockSelect } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

function get(id: string): Promise<Response> {
  return GET(new Request(`https://dorkos.ai/api/feedback/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/feedback/[id]', () => {
  it('returns the public status shape for a known id', async () => {
    const res = await get(VALID_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: 'in_progress',
      kind: 'bug',
      createdAt: '2026-07-28T12:00:00.000Z',
    });
  });

  it('includes shippedVersion only when the row has one', async () => {
    row = { ...row, status: 'shipped', shippedVersion: '0.56.3' };
    const res = await get(VALID_ID);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.shippedVersion).toBe('0.56.3');
  });

  it('never leaks message, contact, reporter identity, or Linear internals', async () => {
    row = {
      ...row,
      message: 'secret report text',
      contact: 'kai@example.com',
      reporterEmail: 'kai@example.com',
      reporterName: 'Kai',
      linearIssueId: 'linear-uuid',
      linearIssueUrl: 'https://linear.app/dor/issue/DOR-1',
    };
    const res = await get(VALID_ID);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'kind', 'status']);
    expect(JSON.stringify(body)).not.toMatch(/secret report text|linear|Kai/i);
  });

  it('the select projection itself never requests message/contact/reporter/linear columns', async () => {
    await get(VALID_ID);
    const projection = mockSelect.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual([
      'createdAt',
      'kind',
      'shippedVersion',
      'status',
    ]);
  });

  it('returns 404 for a syntactically invalid id (no database lookup)', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(404);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns 404 for a well-formed id that matches no row', async () => {
    row = undefined;
    const res = await get(VALID_ID);
    expect(res.status).toBe(404);
  });

  it('the not-found response body is identical for a bad id and a missing id (enumeration-safe)', async () => {
    const badIdRes = await get('not-a-uuid');
    row = undefined;
    const missingRowRes = await get(VALID_ID);
    expect(await badIdRes.json()).toEqual(await missingRowRes.json());
    expect(badIdRes.status).toBe(missingRowRes.status);
  });
});
