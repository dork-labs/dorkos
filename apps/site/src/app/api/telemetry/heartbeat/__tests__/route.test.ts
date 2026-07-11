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

/**
 * Fake keyed store that mimics `insert().values(row).onConflictDoUpdate({...})`
 * as a real upsert on `instanceId`. A first ping inserts; later pings from the
 * same id update the same key. `store.size` is therefore the distinct-instance
 * row count — the exact property the schema's UNIQUE(instance_id) guarantees.
 */
function createUpsertStore() {
  const store = new Map<string, Record<string, unknown>>();
  const conflictSpy = vi.fn();
  const insert = vi.fn(() => ({
    values: (row: Record<string, unknown>) => ({
      onConflictDoUpdate: (args: { set: Record<string, unknown> }) => {
        conflictSpy(args);
        const key = String(row.instanceId);
        if (store.has(key)) {
          store.set(key, { ...store.get(key), ...args.set });
        } else {
          store.set(key, { ...row });
        }
        return Promise.resolve(undefined);
      },
    }),
  }));
  return { store, insert, conflictSpy };
}

let db: ReturnType<typeof createUpsertStore>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = createUpsertStore();
  vi.mocked(getDb).mockReturnValue({ insert: db.insert } as never);
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
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects a payload missing required fields with 400', async () => {
      const noCounts: Record<string, unknown> = { ...VALID_HEARTBEAT };
      delete noCounts.counts;
      const res = await POST(makeRequest(noCounts));
      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects a non-uuid instanceId with 400', async () => {
      const res = await POST(makeRequest({ ...VALID_HEARTBEAT, instanceId: 'nope' }));
      expect(res.status).toBe(400);
    });
  });

  describe('upsert persistence (bounded, last-seen)', () => {
    it('upserts a valid heartbeat and returns 200', async () => {
      const res = await POST(makeRequest(VALID_HEARTBEAT));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });

      expect(db.store.size).toBe(1);
      expect(db.store.get(VALID_HEARTBEAT.instanceId)).toMatchObject({
        instanceId: VALID_HEARTBEAT.instanceId,
        dorkosVersion: '0.46.0',
        countAgents: 4,
        countTasks: 2,
        countRelayAdapters: 1,
      });
      // The conflict clause refreshes receivedAt and the mutable payload.
      const conflictArgs = db.conflictSpy.mock.calls[0]?.[0] as { set: Record<string, unknown> };
      expect(conflictArgs.set).toHaveProperty('receivedAt');
      expect(conflictArgs.set).toHaveProperty('dorkosVersion', '0.46.0');
    });

    it('repeated pings from the same instanceId keep exactly one row', async () => {
      await POST(makeRequest(VALID_HEARTBEAT));
      await POST(makeRequest({ ...VALID_HEARTBEAT, dorkosVersion: '0.47.0' }));
      await POST(makeRequest({ ...VALID_HEARTBEAT, dorkosVersion: '0.48.0' }));

      expect(db.store.size).toBe(1);
      // Last write wins on the mutable fields.
      expect(db.store.get(VALID_HEARTBEAT.instanceId)).toMatchObject({
        dorkosVersion: '0.48.0',
      });
    });

    it('a different instanceId adds a distinct row', async () => {
      await POST(makeRequest(VALID_HEARTBEAT));
      await POST(
        makeRequest({ ...VALID_HEARTBEAT, instanceId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' })
      );

      expect(db.store.size).toBe(2);
    });

    it('still returns 200 when the database upsert fails', async () => {
      vi.mocked(getDb).mockReturnValue({
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => Promise.reject(new Error('neon down')),
          }),
        }),
      } as never);

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

      const serialized = JSON.stringify(Object.fromEntries(db.store));
      expect(serialized).not.toContain('1.2.3.4');
      expect(serialized).not.toContain('abc');
      expect(serialized).not.toContain('SuperSecretAgent');
    });
  });
});
