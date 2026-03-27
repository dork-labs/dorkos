import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRename = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    rename: (...args: unknown[]) => mockRename(...args),
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

/** Stub public record for test assertions. */
function stubPublicRecord(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'test-ext',
    manifest: {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      entrypoint: 'index.ts',
      extensionApiVersion: '0.1.0',
    },
    status: 'compiled',
    scope: 'global',
    bundleReady: true,
    ...overrides,
  };
}

/** Stub full record for manager.get() return values. */
function stubRecord(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'test-ext',
    manifest: {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      entrypoint: 'index.ts',
      extensionApiVersion: '0.1.0',
    },
    status: 'compiled',
    scope: 'global',
    path: '/tmp/extensions/test-ext',
    bundleReady: true,
    ...overrides,
  };
}

function createApp(
  manager: MockManager,
  getCwd: () => string | null = () => TEST_CWD
): express.Express {
  const app = express();
  app.use(express.json());
  // Cast to satisfy the type -- our mock fulfills the interface structurally
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

describe('Extension Routes', () => {
  let app: express.Express;
  let manager: MockManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockManager();
    app = createApp(manager);
  });

  describe('GET /api/extensions', () => {
    it('returns array of extension records', async () => {
      const records = [stubPublicRecord(), stubPublicRecord({ id: 'ext-2' })];
      manager.listPublic.mockReturnValue(records);

      const res = await request(app).get('/api/extensions');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].id).toBe('test-ext');
      expect(res.body[1].id).toBe('ext-2');
    });

    it('returns empty array when no extensions discovered', async () => {
      const res = await request(app).get('/api/extensions');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('POST /api/extensions/:id/enable', () => {
    it('returns updated record with reloadRequired', async () => {
      const result = { extension: stubPublicRecord({ status: 'compiled' }), reloadRequired: true };
      manager.enable.mockResolvedValue(result);

      const res = await request(app).post('/api/extensions/test-ext/enable');

      expect(res.status).toBe(200);
      expect(res.body.extension.status).toBe('compiled');
      expect(res.body.reloadRequired).toBe(true);
      expect(manager.enable).toHaveBeenCalledWith('test-ext');
    });

    it('returns 404 when extension not found or not enableable', async () => {
      manager.enable.mockResolvedValue(null);

      const res = await request(app).post('/api/extensions/missing/enable');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('missing');
    });
  });

  describe('POST /api/extensions/:id/disable', () => {
    it('returns updated record', async () => {
      const result = { extension: stubPublicRecord({ status: 'disabled' }), reloadRequired: true };
      manager.disable.mockResolvedValue(result);

      const res = await request(app).post('/api/extensions/test-ext/disable');

      expect(res.status).toBe(200);
      expect(res.body.extension.status).toBe('disabled');
      expect(manager.disable).toHaveBeenCalledWith('test-ext');
    });

    it('returns 404 when extension not found', async () => {
      manager.disable.mockResolvedValue(null);

      const res = await request(app).post('/api/extensions/missing/disable');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('missing');
    });
  });

  describe('POST /api/extensions/reload', () => {
    it('returns updated extension list', async () => {
      const records = [stubPublicRecord()];
      manager.reload.mockResolvedValue(records);

      const res = await request(app).post('/api/extensions/reload');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe('test-ext');
    });
  });

  describe('GET /api/extensions/:id/bundle', () => {
    it('returns JavaScript with correct Content-Type and Cache-Control', async () => {
      manager.readBundle.mockResolvedValue('console.log("hello");');

      const res = await request(app).get('/api/extensions/test-ext/bundle');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toBe('console.log("hello");');
    });

    it('returns 404 when bundle not available', async () => {
      manager.readBundle.mockResolvedValue(null);

      const res = await request(app).get('/api/extensions/missing/bundle');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('missing');
    });
  });

  describe('GET /api/extensions/:id/data', () => {
    it('returns JSON data when file exists', async () => {
      const record = stubRecord({ scope: 'global' });
      manager.get.mockReturnValue(record);
      mockReadFile.mockResolvedValue(JSON.stringify({ theme: 'dark' }));

      const res = await request(app).get('/api/extensions/test-ext/data');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ theme: 'dark' });
      expect(mockReadFile).toHaveBeenCalledWith(
        `${DORK_HOME}/extension-data/test-ext/data.json`,
        'utf-8'
      );
    });

    it('returns 204 when no data file exists', async () => {
      const record = stubRecord({ scope: 'global' });
      manager.get.mockReturnValue(record);
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const res = await request(app).get('/api/extensions/test-ext/data');

      expect(res.status).toBe(204);
    });

    it('returns 404 when extension not found', async () => {
      manager.get.mockReturnValue(undefined);

      const res = await request(app).get('/api/extensions/missing/data');

      expect(res.status).toBe(404);
    });

    it('resolves local extension data path from cwd', async () => {
      const record = stubRecord({ scope: 'local' });
      manager.get.mockReturnValue(record);
      mockReadFile.mockResolvedValue(JSON.stringify({ setting: true }));

      const res = await request(app).get('/api/extensions/test-ext/data');

      expect(res.status).toBe(200);
      expect(mockReadFile).toHaveBeenCalledWith(
        `${TEST_CWD}/.dork/extension-data/test-ext/data.json`,
        'utf-8'
      );
    });
  });

  describe('PUT /api/extensions/:id/data', () => {
    it('writes JSON and returns success', async () => {
      const record = stubRecord({ scope: 'global' });
      manager.get.mockReturnValue(record);

      const payload = { theme: 'dark', fontSize: 14 };
      const res = await request(app).put('/api/extensions/test-ext/data').send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('creates directory before writing', async () => {
      const record = stubRecord({ scope: 'global' });
      manager.get.mockReturnValue(record);

      await request(app).put('/api/extensions/test-ext/data').send({ key: 'value' });

      expect(mockMkdir).toHaveBeenCalledWith(`${DORK_HOME}/extension-data/test-ext`, {
        recursive: true,
      });
    });

    it('uses atomic write (temp file renamed to final path)', async () => {
      const record = stubRecord({ scope: 'global' });
      manager.get.mockReturnValue(record);
      const payload = { key: 'value' };

      await request(app).put('/api/extensions/test-ext/data').send(payload);

      const expectedPath = `${DORK_HOME}/extension-data/test-ext/data.json`;
      const expectedTmp = `${expectedPath}.tmp`;

      expect(mockWriteFile).toHaveBeenCalledWith(
        expectedTmp,
        JSON.stringify(payload, null, 2),
        'utf-8'
      );
      expect(mockRename).toHaveBeenCalledWith(expectedTmp, expectedPath);
    });

    it('returns 404 when extension not found', async () => {
      manager.get.mockReturnValue(undefined);

      const res = await request(app).put('/api/extensions/missing/data').send({ key: 'value' });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/extensions/cwd-changed', () => {
    it('returns changed=true when extensions differ after CWD switch', async () => {
      manager.updateCwd.mockResolvedValue({ added: ['ext-new'], removed: ['ext-old'] });

      const res = await request(app)
        .post('/api/extensions/cwd-changed')
        .send({ cwd: '/new/project' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        changed: true,
        added: ['ext-new'],
        removed: ['ext-old'],
      });
      expect(manager.updateCwd).toHaveBeenCalledWith('/new/project');
    });

    it('returns changed=false when extension set is unchanged', async () => {
      manager.updateCwd.mockResolvedValue({ added: [], removed: [] });

      const res = await request(app)
        .post('/api/extensions/cwd-changed')
        .send({ cwd: '/same/project' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        changed: false,
        added: [],
        removed: [],
      });
    });

    it('accepts null cwd to clear working directory', async () => {
      manager.updateCwd.mockResolvedValue({ added: [], removed: ['ext-local'] });

      const res = await request(app).post('/api/extensions/cwd-changed').send({ cwd: null });

      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(true);
      expect(manager.updateCwd).toHaveBeenCalledWith(null);
    });

    it('returns 400 when body is invalid', async () => {
      const res = await request(app).post('/api/extensions/cwd-changed').send({ invalid: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });
});
