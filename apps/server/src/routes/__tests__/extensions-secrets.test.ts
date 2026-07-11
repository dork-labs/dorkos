import { describe, it, expect, vi, beforeEach } from 'vitest';

/** In-memory mock secret store keyed by extensionId -> key -> value. */
const mockSecretStores = new Map<string, Map<string, string>>();

vi.mock('@dorkos/shared/extension-secrets', () => ({
  ExtensionSecretStore: vi.fn().mockImplementation(function (extensionId: string) {
    if (!mockSecretStores.has(extensionId)) {
      mockSecretStores.set(extensionId, new Map());
    }
    const store = mockSecretStores.get(extensionId)!;
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      has: vi.fn(async (key: string) => store.has(key)),
    };
  }),
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import request from 'supertest';
import express from 'express';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import { createExtensionsRouter } from '../extensions.js';

const DORK_HOME = '/tmp/dork-test';
const TEST_CWD = '/tmp/test-project';

/** Minimal mock matching the ExtensionManager public interface. */
function createMockManager() {
  return {
    listPublic: vi.fn<() => ExtensionRecordPublic[]>().mockReturnValue([]),
    get: vi.fn<(id: string) => ExtensionRecord | undefined>().mockReturnValue(undefined),
    enable:
      vi.fn<
        (
          id: string
        ) => Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null>
      >(),
    disable:
      vi.fn<
        (
          id: string
        ) => Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null>
      >(),
    reload: vi.fn<() => Promise<ExtensionRecordPublic[]>>().mockResolvedValue([]),
    readBundle: vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue(null),
    reportActivated: vi.fn(),
    reportActivateError: vi.fn(),
    updateCwd: vi
      .fn<(cwd: string | null) => Promise<{ added: string[]; removed: string[] }>>()
      .mockResolvedValue({ added: [], removed: [] }),
  };
}

type MockManager = ReturnType<typeof createMockManager>;

/** Create a record with serverCapabilities.secrets declared. */
function stubRecordWithSecrets(
  secrets: Array<{ key: string; label: string; description?: string; required?: boolean }>,
  overrides: Partial<ExtensionRecord> = {}
): ExtensionRecord {
  return {
    id: 'test-ext',
    manifest: {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      serverCapabilities: {
        secrets,
      },
    },
    status: 'compiled',
    scope: 'global',
    path: '/tmp/extensions/test-ext',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    ...overrides,
  };
}

/** Create a record with no serverCapabilities. */
function stubRecordNoSecrets(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'test-ext',
    manifest: {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
    },
    status: 'compiled',
    scope: 'global',
    path: '/tmp/extensions/test-ext',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    ...overrides,
  };
}

function createApp(
  manager: MockManager,
  getCwd: () => string | null = () => TEST_CWD
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/extensions',
    createExtensionsRouter(
      manager as unknown as Parameters<typeof createExtensionsRouter>[0],
      DORK_HOME,
      getCwd
    )
  );
  return app;
}

describe('Extension Secrets Routes', () => {
  let app: express.Express;
  let manager: MockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretStores.clear();
    manager = createMockManager();
    app = createApp(manager);
  });

  describe('GET /api/extensions/:id/secrets', () => {
    it('returns declared secrets with isSet status', async () => {
      const record = stubRecordWithSecrets([
        { key: 'api_key', label: 'API Key', description: 'Your API key', required: true },
        { key: 'webhook_url', label: 'Webhook URL' },
      ]);
      manager.get.mockReturnValue(record);

      const res = await request(app).get('/api/extensions/test-ext/secrets');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toEqual({
        key: 'api_key',
        label: 'API Key',
        description: 'Your API key',
        required: true,
        isSet: false,
      });
      expect(res.body[1]).toEqual({
        key: 'webhook_url',
        label: 'Webhook URL',
        required: false,
        isSet: false,
      });
    });

    it('reflects isSet: true after a secret has been stored', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      // Set the secret first
      await request(app)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: 'sk-test-123' });

      const res = await request(app).get('/api/extensions/test-ext/secrets');

      expect(res.status).toBe(200);
      expect(res.body[0].isSet).toBe(true);
    });

    it('never returns actual secret values', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      // Set a secret
      await request(app)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: 'sk-secret-value' });

      const res = await request(app).get('/api/extensions/test-ext/secrets');

      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('sk-secret-value');
      // Only expected keys present — no 'value' key ever appears
      const allowedKeys = new Set(['key', 'label', 'description', 'required', 'isSet']);
      for (const entry of res.body) {
        for (const k of Object.keys(entry)) {
          expect(allowedKeys.has(k)).toBe(true);
        }
        expect(entry).not.toHaveProperty('value');
      }
    });

    it('returns empty array for extension without serverCapabilities', async () => {
      const record = stubRecordNoSecrets();
      manager.get.mockReturnValue(record);

      const res = await request(app).get('/api/extensions/test-ext/secrets');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 404 for non-existent extension', async () => {
      manager.get.mockReturnValue(undefined);

      const res = await request(app).get('/api/extensions/missing/secrets');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('missing');
    });

    it('returns 400 for invalid extension ID', async () => {
      const res = await request(app).get('/api/extensions/INVALID_ID/secrets');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid extension ID');
    });
  });

  describe('PUT /api/extensions/:id/secrets/:key', () => {
    it('stores a secret and returns success', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      const res = await request(app)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: 'sk-test-123' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('rejects undeclared secret key with 400', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      const res = await request(app)
        .put('/api/extensions/test-ext/secrets/unknown_key')
        .send({ value: 'some-value' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('unknown_key');
      expect(res.body.error).toContain('not declared');
    });

    it('rejects empty value with 400', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      const res = await request(app)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('rejects missing value field with 400', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      const res = await request(app).put('/api/extensions/test-ext/secrets/api_key').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 404 for non-existent extension', async () => {
      manager.get.mockReturnValue(undefined);

      const res = await request(app)
        .put('/api/extensions/missing/secrets/api_key')
        .send({ value: 'test' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('missing');
    });

    it('returns 400 for invalid extension ID', async () => {
      const res = await request(app)
        .put('/api/extensions/INVALID_ID/secrets/api_key')
        .send({ value: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid extension ID');
    });
  });

  describe('DELETE /api/extensions/:id/secrets/:key', () => {
    it('deletes a secret and returns success', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      // Set the secret first
      await request(app)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: 'sk-test-123' });

      // Delete it
      const res = await request(app).delete('/api/extensions/test-ext/secrets/api_key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('shows isSet: false after deletion', async () => {
      const record = stubRecordWithSecrets([{ key: 'api_key', label: 'API Key', required: true }]);
      manager.get.mockReturnValue(record);

      // Set then delete
      await request(app)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: 'sk-test-123' });

      await request(app).delete('/api/extensions/test-ext/secrets/api_key');

      // List should show isSet: false
      const res = await request(app).get('/api/extensions/test-ext/secrets');

      expect(res.status).toBe(200);
      expect(res.body[0].isSet).toBe(false);
    });

    it('returns 404 for non-existent extension', async () => {
      manager.get.mockReturnValue(undefined);

      const res = await request(app).delete('/api/extensions/missing/secrets/api_key');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('missing');
    });

    it('returns 400 for invalid extension ID', async () => {
      const res = await request(app).delete('/api/extensions/INVALID_ID/secrets/api_key');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid extension ID');
    });
  });
});
