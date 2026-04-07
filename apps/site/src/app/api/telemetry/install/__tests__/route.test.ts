import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/client';

import { POST } from '../route';

vi.mock('@/db/client', () => ({
  getDb: vi.fn(),
}));

const VALID_EVENT = {
  packageName: 'code-reviewer',
  marketplace: 'dorkos-community',
  type: 'agent' as const,
  outcome: 'success' as const,
  durationMs: 1234,
  installId: '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4',
  dorkosVersion: '0.4.2',
};

interface MockDb {
  insert: ReturnType<typeof vi.fn>;
}

let mockValues: ReturnType<typeof vi.fn>;
let mockInsert: ReturnType<typeof vi.fn>;
let mockDb: MockDb;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockValues = vi.fn().mockResolvedValue(undefined);
  mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  mockDb = { insert: mockInsert };
  vi.mocked(getDb).mockReturnValue(mockDb as never);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.clearAllMocks();
});

function makeRequest(
  body: unknown,
  init: { rawBody?: string; headers?: Record<string, string> } = {}
): Request {
  const { rawBody, headers } = init;
  return new Request('https://dorkos.ai/api/telemetry/install', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

describe('POST /api/telemetry/install', () => {
  describe('input validation', () => {
    it('returns 400 on malformed JSON body', async () => {
      const res = await POST(makeRequest(undefined, { rawBody: '{ not json' }));

      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toMatch(/invalid json/i);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('returns 400 with `issues` array on schema validation failure', async () => {
      const res = await POST(
        makeRequest({
          // missing required fields and wrong types throughout
          packageName: '',
          type: 'not-a-real-type',
        })
      );

      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string; issues: unknown[] };
      expect(payload.error).toBe('Invalid event');
      expect(Array.isArray(payload.issues)).toBe(true);
      expect(payload.issues.length).toBeGreaterThan(0);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('returns 400 when installId is not a UUID', async () => {
      const res = await POST(
        makeRequest({
          ...VALID_EVENT,
          installId: 'definitely-not-a-uuid',
        })
      );

      expect(res.status).toBe(400);
      const payload = (await res.json()) as { issues: Array<{ path: Array<string | number> }> };
      const installIdIssue = payload.issues.find((issue) => issue.path.includes('installId'));
      expect(installIdIssue).toBeDefined();
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('returns 200 and inserts the row on outcome=success', async () => {
      const res = await POST(makeRequest(VALID_EVENT));

      expect(res.status).toBe(200);
      const payload = (await res.json()) as { ok: boolean };
      expect(payload.ok).toBe(true);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockValues).toHaveBeenCalledTimes(1);
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success', packageName: 'code-reviewer' })
      );
    });

    it('returns 200 and inserts the row on outcome=failure', async () => {
      const res = await POST(
        makeRequest({
          ...VALID_EVENT,
          outcome: 'failure',
          errorCode: 'install_failed',
        })
      );

      expect(res.status).toBe(200);
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failure', errorCode: 'install_failed' })
      );
    });

    it('returns 200 and inserts the row on outcome=cancelled', async () => {
      const res = await POST(
        makeRequest({
          ...VALID_EVENT,
          outcome: 'cancelled',
        })
      );

      expect(res.status).toBe(200);
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled' }));
    });

    it('returns 200 even when db.insert rejects (graceful degradation)', async () => {
      mockValues.mockRejectedValueOnce(new Error('neon timeout'));

      const res = await POST(makeRequest(VALID_EVENT));

      expect(res.status).toBe(200);
      const payload = (await res.json()) as { ok: boolean };
      expect(payload.ok).toBe(true);
      expect(mockValues).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[api/telemetry/install] insert failed',
        expect.objectContaining({ error: expect.stringContaining('neon timeout') })
      );
    });

    it('inserts a row containing exactly the validated fields and nothing else', async () => {
      await POST(
        makeRequest({
          ...VALID_EVENT,
          errorCode: 'rate_limited',
        })
      );

      expect(mockValues).toHaveBeenCalledTimes(1);
      const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;

      // Exact-shape assertion: every persisted field is one of the 8 validated
      // InstallEvent fields, and nothing PII-shaped sneaks in.
      expect(inserted).toEqual({
        packageName: 'code-reviewer',
        marketplace: 'dorkos-community',
        type: 'agent',
        outcome: 'success',
        durationMs: 1234,
        errorCode: 'rate_limited',
        installId: VALID_EVENT.installId,
        dorkosVersion: '0.4.2',
      });
    });

    it('coerces missing errorCode to null', async () => {
      await POST(makeRequest(VALID_EVENT));

      const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
      expect(inserted.errorCode).toBeNull();
    });
  });

  describe('privacy contract — request headers must never reach the database', () => {
    it('does not persist x-forwarded-for, cookie, or user-agent header values', async () => {
      const PII_HEADERS = {
        'x-forwarded-for': '203.0.113.42, 70.41.3.18',
        cookie: 'session=abc123; userId=kai-nakamura',
        'user-agent':
          'DorkOS-CLI/0.4.2 (Macintosh; Intel Mac OS X 14_4_1) curl/8.7.1 dorian@example.com',
        'x-real-ip': '203.0.113.42',
      };

      const res = await POST(makeRequest(VALID_EVENT, { headers: PII_HEADERS }));

      expect(res.status).toBe(200);
      expect(mockValues).toHaveBeenCalledTimes(1);

      const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
      const insertedJson = JSON.stringify(inserted);

      // None of the PII header values may appear anywhere in the inserted row.
      for (const headerValue of Object.values(PII_HEADERS)) {
        expect(insertedJson).not.toContain(headerValue);
      }

      // None of the PII-shaped column names may appear in the inserted row.
      const forbiddenKeys = [
        'ipAddress',
        'ip',
        'userAgent',
        'cookie',
        'hostname',
        'username',
        'cwd',
        'xForwardedFor',
      ];
      for (const key of forbiddenKeys) {
        expect(inserted).not.toHaveProperty(key);
      }

      // Inserted row equals exactly the validated fields, regardless of headers.
      expect(inserted).toEqual({
        packageName: VALID_EVENT.packageName,
        marketplace: VALID_EVENT.marketplace,
        type: VALID_EVENT.type,
        outcome: VALID_EVENT.outcome,
        durationMs: VALID_EVENT.durationMs,
        errorCode: null,
        installId: VALID_EVENT.installId,
        dorkosVersion: VALID_EVENT.dorkosVersion,
      });
    });
  });
});
