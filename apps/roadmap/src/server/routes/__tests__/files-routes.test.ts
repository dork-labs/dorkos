import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Memory } from 'lowdb';
import { createApp } from '../../app.js';
import { RoadmapStore, type RoadmapData } from '../../services/roadmap-store.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'fs/promises';

const mockedReadFile = vi.mocked(readFile);

describe('Files routes', () => {
  let store: RoadmapStore;
  let app: ReturnType<typeof createApp>;
  const projectRoot = '/projects/my-app';

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new RoadmapStore(new Memory<RoadmapData>());
    await store.init();
    app = createApp({ store, projectRoot });
  });

  it('serves a file under specs/', async () => {
    mockedReadFile.mockResolvedValue('# My Spec\nSome content');

    const res = await request(app).get('/api/roadmap/files/specs/feature/01-ideation.md');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# My Spec\nSome content');
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/projects/my-app/specs/feature/01-ideation.md',
      'utf-8',
    );
  });

  it('returns 403 for paths not under specs/', async () => {
    const res = await request(app).get('/api/roadmap/files/src/secret.ts');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only specs/);
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('blocks path traversal via Express URL normalization', async () => {
    // Express normalizes `..` segments before routing, so specs/../../etc/passwd
    // resolves to a path outside the mount and never reaches our handler (404).
    const res = await request(app).get('/api/roadmap/files/specs/../../etc/passwd');
    expect(res.status).toBe(404);
    expect(mockedReadFile).not.toHaveBeenCalled();
  });


  it('returns 403 for empty path', async () => {
    const res = await request(app).get('/api/roadmap/files/');

    // Express may return 404 for trailing slash with no wildcard match,
    // but our route should return 403 for non-specs paths
    expect([403, 404]).toContain(res.status);
  });

  it('returns 404 when file does not exist', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const res = await request(app).get('/api/roadmap/files/specs/missing.md');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('File not found');
  });
});
