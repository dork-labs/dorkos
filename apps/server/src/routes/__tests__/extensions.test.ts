/**
 * The data routes run against a real temp directory rather than a mocked
 * `fs/promises`. They used to assert the write internals (`writeFile` to a
 * `.tmp` path, then `rename`), which pinned the very fixed-temp-name pattern
 * that DOR-697 had to remove. Asserting the file's actual content instead lets
 * the route change how it writes, and lets the concurrency cases below say
 * something a mock never could.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import request from 'supertest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import { createExtensionsRouter } from '../extensions.js';

let DORK_HOME: string;
let TEST_CWD: string;

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
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
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
    origin: 'user',
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

  beforeEach(async () => {
    vi.clearAllMocks();
    DORK_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-routes-home-'));
    TEST_CWD = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-routes-cwd-'));
    manager = createMockManager();
    app = createApp(manager);
  });

  afterEach(async () => {
    await fs.rm(DORK_HOME, { recursive: true, force: true });
    await fs.rm(TEST_CWD, { recursive: true, force: true });
  });

  /** Absolute path the routes resolve for a global-scope extension's data blob. */
  function globalBlobPath(id = 'test-ext'): string {
    return path.join(DORK_HOME, 'extension-data', id, 'data.json');
  }

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
      expect(res.body.extension.origin).toBe('user');
      expect(res.body.reloadRequired).toBe(true);
      expect(manager.enable).toHaveBeenCalledWith('test-ext');
    });

    it('surfaces a default-on core extension enable (manager handles list routing)', async () => {
      // The route is tier-agnostic: it delegates to the manager, which decides
      // whether to mutate `enabled` or `disabled`. The route just relays the result.
      const result = {
        extension: stubPublicRecord({ id: 'marketplace', origin: 'core', status: 'compiled' }),
        reloadRequired: true,
      };
      manager.enable.mockResolvedValue(result);

      const res = await request(app).post('/api/extensions/marketplace/enable');

      expect(res.status).toBe(200);
      expect(res.body.extension.origin).toBe('core');
      expect(manager.enable).toHaveBeenCalledWith('marketplace');
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

    it('returns 409 (not 404) when a required core extension cannot be disabled', async () => {
      // The manager refuses to disable a locked (canDisable:false) core extension
      // and returns null. Because the record still EXISTS (manager.get returns it),
      // the route must report an honest 409 Conflict rather than a misleading 404 —
      // the extension is forbidden, not missing. Defense in depth behind the
      // settings UI, which hides the toggle entirely.
      manager.disable.mockResolvedValue(null);
      manager.get.mockReturnValue(stubRecord({ id: 'locked-core', origin: 'core' }));

      const res = await request(app).post('/api/extensions/locked-core/disable');

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('required');
      expect(manager.disable).toHaveBeenCalledWith('locked-core');
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
      manager.get.mockReturnValue(stubRecord({ scope: 'global' }));
      await fs.mkdir(path.dirname(globalBlobPath()), { recursive: true });
      await fs.writeFile(globalBlobPath(), JSON.stringify({ theme: 'dark' }));

      const res = await request(app).get('/api/extensions/test-ext/data');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ theme: 'dark' });
    });

    it('returns 204 when no data file exists', async () => {
      manager.get.mockReturnValue(stubRecord({ scope: 'global' }));

      const res = await request(app).get('/api/extensions/test-ext/data');

      expect(res.status).toBe(204);
    });

    it('returns 404 when extension not found', async () => {
      manager.get.mockReturnValue(undefined);

      const res = await request(app).get('/api/extensions/missing/data');

      expect(res.status).toBe(404);
    });

    it('resolves local extension data path from cwd', async () => {
      manager.get.mockReturnValue(stubRecord({ scope: 'local' }));
      const localPath = path.join(TEST_CWD, '.dork', 'extension-data', 'test-ext', 'data.json');
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, JSON.stringify({ setting: true }));

      const res = await request(app).get('/api/extensions/test-ext/data');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ setting: true });
    });
  });

  describe('PUT /api/extensions/:id/data', () => {
    it('writes JSON and returns success', async () => {
      manager.get.mockReturnValue(stubRecord({ scope: 'global' }));

      const payload = { theme: 'dark', fontSize: 14 };
      const res = await request(app).put('/api/extensions/test-ext/data').send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(JSON.parse(await fs.readFile(globalBlobPath(), 'utf-8'))).toEqual(payload);
    });

    it('creates the data directory when it does not exist yet', async () => {
      manager.get.mockReturnValue(stubRecord({ scope: 'global' }));

      const res = await request(app).put('/api/extensions/test-ext/data').send({ key: 'value' });

      expect(res.status).toBe(200);
      expect(JSON.parse(await fs.readFile(globalBlobPath(), 'utf-8'))).toEqual({ key: 'value' });
    });

    it('returns 404 when extension not found', async () => {
      manager.get.mockReturnValue(undefined);

      const res = await request(app).put('/api/extensions/missing/data').send({ key: 'value' });

      expect(res.status).toBe(404);
    });

    // DOR-697: a person with two cockpit tabs open can race the same path.
    // These must stay concurrent — issued sequentially they cannot fail.
    describe('concurrent saves to one extension', () => {
      it('never 500s when many saves land at once', async () => {
        manager.get.mockReturnValue(stubRecord({ scope: 'global' }));
        const N = 20;

        const responses = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            request(app)
              .put('/api/extensions/test-ext/data')
              .send({ writer: i, pad: 'x'.repeat(i * 64) })
          )
        );

        expect(responses.map((r) => r.status)).toEqual(Array.from({ length: N }, () => 200));
      });

      it('leaves one writer payload on disk, never a blend of two', async () => {
        manager.get.mockReturnValue(stubRecord({ scope: 'global' }));
        const N = 20;

        // Status alone is blind to the case that matters: a crossed write also
        // returns 200. Only the file's content shows whether the bytes that
        // landed belong to a single writer.
        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            request(app)
              .put('/api/extensions/test-ext/data')
              .send({ writer: i, pad: 'x'.repeat(i * 64) })
          )
        );

        const parsed = JSON.parse(await fs.readFile(globalBlobPath(), 'utf-8')) as {
          writer: number;
          pad: string;
        };
        expect(parsed.pad).toBe('x'.repeat(parsed.writer * 64));
      });

      it('leaves no temp files in the extension data directory', async () => {
        manager.get.mockReturnValue(stubRecord({ scope: 'global' }));

        await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            request(app).put('/api/extensions/test-ext/data').send({ writer: i })
          )
        );

        const entries = await fs.readdir(path.dirname(globalBlobPath()));
        expect(entries).toEqual(['data.json']);
      });
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
