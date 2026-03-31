/**
 * Integration tests for the discovery SSE endpoint.
 *
 * These tests verify the SSE wire format, event sequencing, and error handling
 * of POST /api/discovery/scan by mounting the router in a real Express app
 * and using supertest to make requests.
 *
 * The scanner is mocked via a fake meshCore.discover() async generator —
 * the focus is on the route/SSE layer, not the filesystem scanning logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSSEResponse } from '@dorkos/test-utils/sse-helpers';
import type { MeshCore } from '@dorkos/mesh';
import type { ScanEvent } from '@dorkos/mesh';

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

/** Mock MeshCore with a controllable discover() async generator. */
const mockDiscover = vi.fn();
const mockMeshCore = { discover: mockDiscover } as unknown as MeshCore;

/** Helper to create a minimal Express app with the discovery router mounted. */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discovery', createDiscoveryRouter(mockMeshCore));
  return app;
}

/**
 * Helper to send a POST to /api/discovery/scan and collect the raw SSE response.
 *
 * Supertest's default parser doesn't handle SSE streams, so we use a custom
 * parser that collects all chunks into a single string.
 */
async function postScan(app: express.Express, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/discovery/scan')
    .send(body)
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
}

/** Create a mock async generator that yields the given events. */
function mockGenerator(events: ScanEvent[]) {
  return async function* () {
    for (const e of events) yield e;
  };
}

describe('Discovery SSE Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWithinBoundary.mockResolvedValue(true);
  });

  // -------------------------------------------------------------------------
  // SSE format
  // -------------------------------------------------------------------------

  describe('SSE format', () => {
    it('returns text/event-stream content type', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('returns no-cache and keep-alive headers', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);

      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
      expect(res.headers['x-accel-buffering']).toBe('no');
    });

    it('formats each event as event: + data: lines separated by double newlines', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 5, foundAgents: 1, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);
      const raw = res.body as string;

      expect(raw).toContain('event: complete\n');
      expect(raw).toContain('data: ');
      expect(raw).toMatch(/data: .+\n\n/);
    });
  });

  // -------------------------------------------------------------------------
  // Candidate events
  // -------------------------------------------------------------------------

  describe('candidate events', () => {
    it('emits candidate events for discovered projects', async () => {
      const candidates: ScanEvent[] = [
        {
          type: 'candidate',
          data: {
            path: '/home/user/project-alpha',
            strategy: 'claude-code',
            hints: { name: 'project-alpha' },
            discoveredAt: '2026-01-01T00:00:00.000Z',
          },
        },
        {
          type: 'candidate',
          data: {
            path: '/home/user/project-beta',
            strategy: 'dork-manifest',
            hints: { name: 'project-beta' },
            discoveredAt: '2026-01-01T00:00:00.000Z',
          },
        },
        {
          type: 'complete',
          data: { scannedDirs: 50, foundAgents: 2, timedOut: false },
        },
      ];

      mockDiscover.mockImplementation(mockGenerator(candidates));

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      expect(parsed).toHaveLength(3);

      // First candidate
      expect(parsed[0].type).toBe('candidate');
      expect(parsed[0].data).toEqual(
        expect.objectContaining({
          path: '/home/user/project-alpha',
          strategy: 'claude-code',
        })
      );

      // Second candidate
      expect(parsed[1].type).toBe('candidate');
      expect(parsed[1].data).toEqual(
        expect.objectContaining({
          path: '/home/user/project-beta',
          strategy: 'dork-manifest',
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Progress events
  // -------------------------------------------------------------------------

  describe('progress events', () => {
    it('emits progress events with scanned dir and agent counts', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'progress', data: { scannedDirs: 100, foundAgents: 2 } },
          { type: 'progress', data: { scannedDirs: 200, foundAgents: 5 } },
          { type: 'complete', data: { scannedDirs: 250, foundAgents: 5, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      const progressEvents = parsed.filter((e) => e.type === 'progress');
      expect(progressEvents).toHaveLength(2);
      expect(progressEvents[0].data).toEqual({ scannedDirs: 100, foundAgents: 2 });
      expect(progressEvents[1].data).toEqual({ scannedDirs: 200, foundAgents: 5 });
    });

    it('handles zero progress events when scan completes quickly', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 3, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      const progressEvents = parsed.filter((e) => e.type === 'progress');
      expect(progressEvents).toHaveLength(0);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe('complete');
    });
  });

  // -------------------------------------------------------------------------
  // Complete event
  // -------------------------------------------------------------------------

  describe('complete event', () => {
    it('emits a complete event with summary counts', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 500, foundAgents: 12, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      const complete = parsed.find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      expect(complete!.data).toEqual({
        scannedDirs: 500,
        foundAgents: 12,
        timedOut: false,
      });
    });

    it('reports timedOut: true when scan exceeds timeout', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'progress', data: { scannedDirs: 100, foundAgents: 1 } },
          { type: 'complete', data: { scannedDirs: 100, foundAgents: 1, timedOut: true } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      const complete = parsed.find((e) => e.type === 'complete');
      expect(complete!.data).toEqual(expect.objectContaining({ timedOut: true }));
    });

    it('is the last event in the stream', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          {
            type: 'candidate',
            data: {
              path: '/home/user/proj',
              strategy: 'claude-code',
              hints: {},
              discoveredAt: '',
            },
          },
          { type: 'progress', data: { scannedDirs: 100, foundAgents: 1 } },
          { type: 'complete', data: { scannedDirs: 150, foundAgents: 1, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      expect(parsed[parsed.length - 1].type).toBe('complete');
    });
  });

  // -------------------------------------------------------------------------
  // Auto-import filtering
  // -------------------------------------------------------------------------

  describe('auto-import to existing-agent transformation', () => {
    it('surfaces auto-import events as existing-agent events', async () => {
      mockDiscover.mockImplementation(async function* () {
        yield {
          type: 'auto-import',
          data: {
            manifest: { name: 'test', runtime: 'claude-code', description: 'A test agent' },
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
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      expect(parsed).toHaveLength(3);
      expect(parsed.find((e) => e.type === 'auto-import')).toBeUndefined();
      const existing = parsed.find((e) => e.type === 'existing-agent');
      expect(existing).toBeDefined();
      expect(existing!.data).toEqual({
        path: '/home/user/proj',
        name: 'test',
        runtime: 'claude-code',
        description: 'A test agent',
      });
      expect(parsed[1].type).toBe('candidate');
      expect(parsed[2].type).toBe('complete');
    });
  });

  // -------------------------------------------------------------------------
  // Validation errors (400)
  // -------------------------------------------------------------------------

  describe('validation errors', () => {
    it('returns 400 for maxDepth below 1', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/discovery/scan').send({ maxDepth: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 for maxDepth above 10', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/discovery/scan').send({ maxDepth: 11 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns JSON error body with details', async () => {
      const app = createTestApp();
      const res = await request(app).post('/api/discovery/scan').send({ maxDepth: -1 });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('details');
    });

    it('does not call scanner when validation fails', async () => {
      const app = createTestApp();
      await request(app).post('/api/discovery/scan').send({ maxDepth: 999 });

      expect(mockDiscover).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Boundary violation (403)
  // -------------------------------------------------------------------------

  describe('boundary violation', () => {
    it('returns 403 when root is outside the directory boundary', async () => {
      mockIsWithinBoundary.mockResolvedValue(false);

      const app = createTestApp();
      const res = await request(app).post('/api/discovery/scan').send({ root: '/root/forbidden' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Root path outside directory boundary');
    });

    it('does not call scanner when boundary check fails', async () => {
      mockIsWithinBoundary.mockResolvedValue(false);

      const app = createTestApp();
      await request(app).post('/api/discovery/scan').send({ root: '/root/forbidden' });

      expect(mockDiscover).not.toHaveBeenCalled();
    });

    it('validates boundary for default root when no root/roots provided', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      await postScan(app, {});

      // Default root (boundary) is still validated
      expect(mockIsWithinBoundary).toHaveBeenCalledWith('/home/user');
      expect(mockDiscover).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Timeout parameter passthrough
  // -------------------------------------------------------------------------

  describe('timeout parameter', () => {
    it('passes timeout to the scanner', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      await postScan(app, { timeout: 5000 });

      expect(mockDiscover).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('passes maxDepth to the scanner', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      await postScan(app, { maxDepth: 7 });

      expect(mockDiscover).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ maxDepth: 7 })
      );
    });

    it('passes root to the scanner after boundary check', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      await postScan(app, { root: '/home/user/projects' });

      expect(mockIsWithinBoundary).toHaveBeenCalledWith('/home/user/projects');
      expect(mockDiscover).toHaveBeenCalledWith(
        ['/home/user/projects'],
        expect.objectContaining({})
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scanner error handling
  // -------------------------------------------------------------------------

  describe('scanner error handling', () => {
    it('emits an error SSE event when the scanner throws', async () => {
      mockDiscover.mockImplementation(async function* () {
        yield { type: 'progress', data: { scannedDirs: 10, foundAgents: 0 } };
        throw new Error('Permission denied');
      });

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      const errorEvent = parsed.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.data).toEqual({ error: 'Permission denied' });
    });

    it('emits a generic error message for non-Error exceptions', async () => {
      mockDiscover.mockImplementation(async function* () {
        throw 'string-error';
      });

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      const errorEvent = parsed.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.data).toEqual({ error: 'Scan failed' });
    });

    it('still returns 200 status for scanner errors (error is in SSE stream)', async () => {
      mockDiscover.mockImplementation(async function* () {
        throw new Error('Boom');
      });

      const app = createTestApp();
      const res = await postScan(app);

      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Full event sequence
  // -------------------------------------------------------------------------

  describe('full event sequence', () => {
    it('streams a realistic mix of candidate, progress, and complete events', async () => {
      const events: ScanEvent[] = [
        {
          type: 'candidate',
          data: {
            path: '/home/user/web-app',
            strategy: 'claude-code',
            hints: { name: 'web-app' },
            discoveredAt: '2026-01-01T00:00:00.000Z',
          },
        },
        { type: 'progress', data: { scannedDirs: 100, foundAgents: 1 } },
        {
          type: 'candidate',
          data: {
            path: '/home/user/api-server',
            strategy: 'dork-manifest',
            hints: { name: 'api-server' },
            discoveredAt: '2026-01-01T00:00:00.000Z',
          },
        },
        { type: 'progress', data: { scannedDirs: 200, foundAgents: 2 } },
        { type: 'progress', data: { scannedDirs: 300, foundAgents: 2 } },
        { type: 'complete', data: { scannedDirs: 350, foundAgents: 2, timedOut: false } },
      ];

      mockDiscover.mockImplementation(mockGenerator(events));

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      expect(parsed).toHaveLength(6);

      const types = parsed.map((e) => e.type);
      expect(types).toEqual([
        'candidate',
        'progress',
        'candidate',
        'progress',
        'progress',
        'complete',
      ]);

      const candidates = parsed.filter((e) => e.type === 'candidate');
      expect(candidates).toHaveLength(2);
      expect((candidates[0].data as Record<string, unknown>).path).toBe('/home/user/web-app');
      expect((candidates[1].data as Record<string, unknown>).path).toBe('/home/user/api-server');
    });

    it('handles an empty scan with only a complete event', async () => {
      mockDiscover.mockImplementation(
        mockGenerator([
          { type: 'complete', data: { scannedDirs: 0, foundAgents: 0, timedOut: false } },
        ])
      );

      const app = createTestApp();
      const res = await postScan(app);
      const parsed = parseSSEResponse(res.body as string);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe('complete');
      expect(parsed[0].data).toEqual({
        scannedDirs: 0,
        foundAgents: 0,
        timedOut: false,
      });
    });
  });
});
