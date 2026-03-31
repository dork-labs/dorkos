import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSSEResponse } from '@dorkos/test-utils/sse-helpers';

// Mock boundary module
const mockIsWithinBoundary = vi.fn();
const mockGetBoundary = vi.fn().mockReturnValue('/home/user');
vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: (...args: unknown[]) => mockIsWithinBoundary(...args),
  getBoundary: () => mockGetBoundary(),
  initBoundary: vi.fn(),
  validateBoundary: vi.fn(),
  BoundaryError: class BoundaryError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

import request from 'supertest';
import express from 'express';
import { createDiscoveryRouter } from '../discovery.js';

/** Mock MeshCore with a controllable discover() async generator. */
const mockDiscover = vi.fn();
const mockMeshCore = { discover: mockDiscover } as unknown as import('@dorkos/mesh').MeshCore;

/** Create a minimal Express app with the discovery router mounted. */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discovery', createDiscoveryRouter(mockMeshCore));
  return app;
}

describe('Discovery Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWithinBoundary.mockResolvedValue(true);
    mockGetBoundary.mockReturnValue('/home/user');
  });

  describe('POST /api/discovery/scan — validation', () => {
    it('returns 400 for maxDepth out of range', async () => {
      const app = createTestApp();

      const res = await request(app).post('/api/discovery/scan').send({ maxDepth: 100 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 for timeout too small', async () => {
      const app = createTestApp();

      const res = await request(app).post('/api/discovery/scan').send({ timeout: 500 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 for timeout too large', async () => {
      const app = createTestApp();

      const res = await request(app).post('/api/discovery/scan').send({ timeout: 200000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 for non-integer maxDepth', async () => {
      const app = createTestApp();

      const res = await request(app).post('/api/discovery/scan').send({ maxDepth: 3.5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('POST /api/discovery/scan — boundary', () => {
    it('returns 403 when root is outside boundary', async () => {
      mockIsWithinBoundary.mockResolvedValue(false);
      const app = createTestApp();

      const res = await request(app).post('/api/discovery/scan').send({ root: '/etc/secrets' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Root path outside directory boundary');
      expect(mockIsWithinBoundary).toHaveBeenCalledWith('/etc/secrets');
    });

    it('returns 403 when any root in roots array is outside boundary', async () => {
      mockIsWithinBoundary.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({ roots: ['/home/user/ok', '/etc/secrets'] });

      expect(res.status).toBe(403);
    });

    it('defaults to boundary (home dir) when no root or roots provided', async () => {
      mockDiscover.mockImplementation(async function* () {
        yield { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } };
      });

      const app = createTestApp();

      await request(app)
        .post('/api/discovery/scan')
        .send({})
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      // Should validate boundary path and call discover with it
      expect(mockIsWithinBoundary).toHaveBeenCalledWith('/home/user');
      expect(mockDiscover).toHaveBeenCalledWith(['/home/user'], expect.objectContaining({}));
    });
  });

  describe('POST /api/discovery/scan — streaming', () => {
    it('calls meshCore.discover with correct options', async () => {
      mockDiscover.mockImplementation(async function* () {
        yield { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } };
      });

      const app = createTestApp();

      await request(app)
        .post('/api/discovery/scan')
        .send({ root: '/home/user/projects', maxDepth: 3, timeout: 10000 })
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      expect(mockDiscover).toHaveBeenCalledWith(['/home/user/projects'], {
        maxDepth: 3,
        timeout: 10000,
      });
    });

    it('passes roots array through to meshCore.discover', async () => {
      mockDiscover.mockImplementation(async function* () {
        yield { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } };
      });

      const app = createTestApp();

      await request(app)
        .post('/api/discovery/scan')
        .send({ roots: ['/home/user/a', '/home/user/b'] })
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      expect(mockDiscover).toHaveBeenCalledWith(
        ['/home/user/a', '/home/user/b'],
        expect.objectContaining({})
      );
    });

    it('streams SSE events from scanner', async () => {
      const events = [
        {
          type: 'candidate' as const,
          data: {
            path: '/home/user/project-a',
            strategy: 'claude-code',
            hints: { name: 'project-a' },
            discoveredAt: '2026-01-01T00:00:00.000Z',
          },
        },
        {
          type: 'progress' as const,
          data: { scannedDirs: 100, foundAgents: 1 },
        },
        {
          type: 'complete' as const,
          data: { scannedDirs: 200, foundAgents: 1, timedOut: false },
        },
      ];

      mockDiscover.mockImplementation(async function* () {
        for (const e of events) yield e;
      });

      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({})
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      expect(res.status).toBe(200);
      expect(mockDiscover).toHaveBeenCalledTimes(1);

      const parsed = parseSSEResponse(res.body as string);

      expect(parsed).toHaveLength(3);
      expect(parsed[0].type).toBe('candidate');
      expect(parsed[0].data).toEqual(expect.objectContaining({ path: '/home/user/project-a' }));
      expect(parsed[1].type).toBe('progress');
      expect(parsed[2].type).toBe('complete');
    });

    it('surfaces auto-import events as existing-agent events', async () => {
      mockDiscover.mockImplementation(async function* () {
        yield {
          type: 'auto-import',
          data: {
            manifest: { name: 'MyAgent', runtime: 'claude-code', description: 'A test agent' },
            path: '/home/user/proj',
          },
        };
        yield {
          type: 'candidate',
          data: { path: '/home/user/proj', strategy: 'claude-code', hints: {}, discoveredAt: '' },
        };
        yield { type: 'complete', data: { scannedDirs: 1, foundAgents: 1, timedOut: false } };
      });

      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({})
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      const parsed = parseSSEResponse(res.body as string);
      expect(parsed).toHaveLength(3);
      expect(parsed.find((e) => e.type === 'auto-import')).toBeUndefined();
      const existing = parsed.find((e) => e.type === 'existing-agent');
      expect(existing).toBeDefined();
      expect(existing!.data).toEqual({
        path: '/home/user/proj',
        name: 'MyAgent',
        runtime: 'claude-code',
        description: 'A test agent',
      });
    });

    it('passes undefined for omitted optional fields', async () => {
      mockDiscover.mockImplementation(async function* () {
        yield { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } };
      });

      const app = createTestApp();

      await request(app)
        .post('/api/discovery/scan')
        .send({})
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      expect(mockDiscover).toHaveBeenCalledWith(['/home/user'], {
        maxDepth: undefined,
        timeout: undefined,
      });
    });
  });
});
