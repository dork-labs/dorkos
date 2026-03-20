import { describe, it, expect, vi, beforeEach } from 'vitest';
import multer from 'multer';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue({
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 10,
      allowedTypes: ['*/*'],
    }),
  },
}));

// memoryStorage avoids filesystem writes but does not populate filename/path.
// The route maps f.path -> savedPath and f.filename -> filename, which will be
// undefined with memoryStorage. Tests verify the fields that are always present.
vi.mock('../../services/core/upload-handler.js', () => ({
  uploadHandler: {
    getUploadDir: vi.fn().mockReturnValue('/test/project/.dork/.temp/uploads'),
    createMulterMiddleware: vi.fn().mockReturnValue(multer({ storage: multer.memoryStorage() })),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';

const app = createApp();

describe('POST /api/uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when cwd query param is missing', async () => {
    const res = await request(app).post('/api/uploads').send();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cwd/i);
  });

  it('returns 400 when no files are attached', async () => {
    const res = await request(app).post('/api/uploads?cwd=/test/project').send();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  it('returns 200 with upload results for valid file', async () => {
    const res = await request(app)
      .post('/api/uploads?cwd=/test/project')
      .attach('files', Buffer.from('hello world'), 'test.txt');

    expect(res.status).toBe(200);
    expect(res.body.uploads).toBeDefined();
    expect(res.body.uploads).toHaveLength(1);
    expect(res.body.uploads[0]).toHaveProperty('originalName', 'test.txt');
    expect(res.body.uploads[0]).toHaveProperty('size', 11);
    expect(res.body.uploads[0]).toHaveProperty('mimeType');
  });

  it('returns 200 with multiple upload results', async () => {
    const res = await request(app)
      .post('/api/uploads?cwd=/test/project')
      .attach('files', Buffer.from('file one'), 'one.txt')
      .attach('files', Buffer.from('file two'), 'two.txt');

    expect(res.status).toBe(200);
    expect(res.body.uploads).toHaveLength(2);
    expect(res.body.uploads[0].originalName).toBe('one.txt');
    expect(res.body.uploads[1].originalName).toBe('two.txt');
  });

  it('returns 403 when cwd fails boundary validation', async () => {
    vi.mocked(validateBoundary).mockRejectedValueOnce(
      new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
    );

    const res = await request(app)
      .post('/api/uploads?cwd=/etc/passwd')
      .attach('files', Buffer.from('evil'), 'hack.txt');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('returns 403 for null byte paths', async () => {
    vi.mocked(validateBoundary).mockRejectedValueOnce(
      new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
    );

    const res = await request(app)
      .post('/api/uploads?cwd=/home/user%00')
      .attach('files', Buffer.from('data'), 'file.txt');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NULL_BYTE');
  });

  it('calls validateBoundary with the cwd query parameter', async () => {
    await request(app)
      .post('/api/uploads?cwd=/test/project')
      .attach('files', Buffer.from('content'), 'doc.txt');

    expect(validateBoundary).toHaveBeenCalledWith('/test/project');
  });
});

describe('GET /api/uploads/:filename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when cwd query param is missing', async () => {
    const res = await request(app).get('/api/uploads/test.png');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cwd/i);
  });

  it('returns 404 for nonexistent file', async () => {
    const res = await request(app).get('/api/uploads/missing.png?cwd=/test/project');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('File not found');
  });

  it('returns 403 when cwd fails boundary validation', async () => {
    vi.mocked(validateBoundary).mockRejectedValueOnce(
      new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
    );

    const res = await request(app).get('/api/uploads/test.png?cwd=/etc/passwd');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('strips directory traversal via path.basename and returns 404', async () => {
    const res = await request(app).get('/api/uploads/..%2F..%2Fetc%2Fpasswd?cwd=/test/project');

    // path.basename strips traversal, resulting in just "passwd" which won't exist
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('File not found');
  });
});
