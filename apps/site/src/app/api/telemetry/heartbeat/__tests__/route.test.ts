import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/client';

import { POST } from '../route';

vi.mock('@/db/client', () => ({
  getDb: vi.fn(),
}));

const VALID_HEARTBEAT = {
  instanceId: '7c6d2b9a-9f44-4f3a-bf67-3f3aa6bbf7c4',
  dorkosVersion: '0.46.0',
  os: 'darwin-arm64',
  runtimesConfigured: ['claude-code', 'codex'],
  tunnelEnabled: false,
  cloudLinked: false,
  counts: { agents: 4, tasks: 2, relayAdapters: 1 },
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
  return new Request('https://dorkos.ai/api/telemetry/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody ?? JSON.stringify(body),
  });
}

describe('POST /api/telemetry/heartbeat', () => {
  describe('input validation', () => {
    it('rejects malformed JSON with 400', async () => {
      const res = await POST(makeRequest(undefined, { rawBody: '{not json' }));
      expect(res.status).toBe(400);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('rejects a payload missing required fields with 400', async () => {
      const noCounts: Record<string, unknown> = { ...VALID_HEARTBEAT };
      delete noCounts.counts;
      const res = await POST(makeRequest(noCounts));
      expect(res.status).toBe(400);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('rejects a non-uuid instanceId with 400', async () => {
      const res = await POST(makeRequest({ ...VALID_HEARTBEAT, instanceId: 'nope' }));
      expect(res.status).toBe(400);
    });
  });

  describe('persistence', () => {
    it('inserts a valid heartbeat and returns 200', async () => {
      const res = await POST(makeRequest(VALID_HEARTBEAT));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockValues).toHaveBeenCalledWith({
        instanceId: VALID_HEARTBEAT.instanceId,
        dorkosVersion: VALID_HEARTBEAT.dorkosVersion,
        os: VALID_HEARTBEAT.os,
        runtimesConfigured: VALID_HEARTBEAT.runtimesConfigured,
        tunnelEnabled: false,
        cloudLinked: false,
        countAgents: 4,
        countTasks: 2,
        countRelayAdapters: 1,
      });
    });

    it('still returns 200 when the database insert fails', async () => {
      mockValues.mockRejectedValueOnce(new Error('neon down'));
      const res = await POST(makeRequest(VALID_HEARTBEAT));
      expect(res.status).toBe(200);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('privacy — request headers are never persisted', () => {
    it('ignores IP / cookie / user-agent headers entirely', async () => {
      await POST(
        makeRequest(VALID_HEARTBEAT, {
          headers: {
            'x-forwarded-for': '1.2.3.4',
            cookie: 'session=abc',
            'user-agent': 'SuperSecretAgent/1.0',
          },
        })
      );

      const inserted = mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const serialized = JSON.stringify(inserted);
      expect(serialized).not.toContain('1.2.3.4');
      expect(serialized).not.toContain('abc');
      expect(serialized).not.toContain('SuperSecretAgent');
    });
  });
});
