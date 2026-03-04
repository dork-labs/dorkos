import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { parseSSEResponse } from '@dorkos/test-utils/sse-helpers';

// Mock the discovery scanner
const mockScanForAgents = vi.fn();
vi.mock('../../services/discovery/discovery-scanner.js', () => ({
  scanForAgents: (...args: unknown[]) => mockScanForAgents(...args),
}));

// Mock boundary module
const mockIsWithinBoundary = vi.fn();
vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: (...args: unknown[]) => mockIsWithinBoundary(...args),
  getBoundary: vi.fn().mockReturnValue('/home/user'),
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

/** Create a minimal Express app with the discovery router mounted. */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discovery', createDiscoveryRouter());
  return app;
}

describe('Discovery Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWithinBoundary.mockResolvedValue(true);
  });

  describe('POST /api/discovery/scan — validation', () => {
    it('returns 400 for maxDepth out of range', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({ maxDepth: 100 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 for timeout too small', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({ timeout: 500 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 for timeout too large', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({ timeout: 100000 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 for non-integer maxDepth', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({ maxDepth: 3.5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('POST /api/discovery/scan — boundary', () => {
    it('returns 403 when root is outside boundary', async () => {
      mockIsWithinBoundary.mockResolvedValue(false);
      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({ root: '/etc/secrets' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Root path outside directory boundary');
      expect(mockIsWithinBoundary).toHaveBeenCalledWith('/etc/secrets');
    });

    it('does not check boundary when root is not provided', async () => {
      mockScanForAgents.mockImplementation(async function* () {
        yield { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } };
      });

      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({})
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => { callback(null, data); });
        });

      expect(res.status).toBe(200);
      expect(mockIsWithinBoundary).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/discovery/scan — streaming', () => {
    it('calls scanForAgents with correct options', async () => {
      mockScanForAgents.mockImplementation(async function* () {
        yield { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } };
      });

      const app = createTestApp();

      await request(app)
        .post('/api/discovery/scan')
        .send({ root: '/home/user/projects', maxDepth: 3, timeout: 10000 })
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => { callback(null, data); });
        });

      expect(mockScanForAgents).toHaveBeenCalledWith({
        root: '/home/user/projects',
        maxDepth: 3,
        timeout: 10000,
      });
    });

    it('streams SSE events from scanner', async () => {
      const events = [
        {
          type: 'candidate' as const,
          data: {
            path: '/home/user/project-a',
            name: 'project-a',
            markers: ['CLAUDE.md'],
            gitBranch: 'main',
            gitRemote: null,
            hasDorkManifest: false,
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

      mockScanForAgents.mockImplementation(async function* () {
        for (const e of events) yield e;
      });

      const app = createTestApp();

      const res = await request(app)
        .post('/api/discovery/scan')
        .send({})
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => { callback(null, data); });
        });

      expect(res.status).toBe(200);
      expect(mockScanForAgents).toHaveBeenCalledTimes(1);

      const parsed = parseSSEResponse(res.body as string);

      expect(parsed).toHaveLength(3);
      expect(parsed[0].type).toBe('candidate');
      expect(parsed[0].data).toEqual(expect.objectContaining({ name: 'project-a' }));
      expect(parsed[1].type).toBe('progress');
      expect(parsed[2].type).toBe('complete');
    });

    it('passes undefined for omitted optional fields', async () => {
      mockScanForAgents.mockImplementation(async function* () {
        yield { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } };
      });

      const app = createTestApp();

      await request(app)
        .post('/api/discovery/scan')
        .send({})
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => { callback(null, data); });
        });

      expect(mockScanForAgents).toHaveBeenCalledWith({
        root: DEFAULT_CWD,
        maxDepth: undefined,
        timeout: undefined,
      });
    });
  });
});
