import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockMkdir = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import request from 'supertest';
import express from 'express';
import { createTemplateRouter } from '../templates.js';

const DORK_HOME = '/tmp/dork-test';

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/templates', createTemplateRouter(DORK_HOME));
  return app;
}

/** Helper to make mockReadFile return a user catalog JSON string. */
function setUserCatalog(
  templates: Array<{
    id: string;
    name: string;
    description: string;
    source: string;
    category: string;
    builtin: boolean;
    tags: string[];
  }>
): void {
  mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, templates }));
}

describe('Template Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: file not found (no user catalog)
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    app = createApp();
  });

  describe('GET /api/templates', () => {
    it('returns 7 built-in templates when no user file exists', async () => {
      const res = await request(app).get('/api/templates');

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.body.templates).toHaveLength(7);
      expect(res.body.templates.every((t: { builtin: boolean }) => t.builtin)).toBe(true);
    });

    it('returns merged list with user templates when file exists', async () => {
      setUserCatalog([
        {
          id: 'my-custom',
          name: 'My Custom',
          description: 'A custom template',
          source: 'github:me/my-template',
          category: 'custom',
          builtin: false,
          tags: ['custom'],
        },
      ]);

      const res = await request(app).get('/api/templates');

      expect(res.status).toBe(200);
      expect(res.body.templates).toHaveLength(8);
      expect(res.body.templates.find((t: { id: string }) => t.id === 'my-custom')).toBeDefined();
    });

    it('handles malformed catalog file gracefully', async () => {
      mockReadFile.mockResolvedValue('{ not valid json !!!');

      const res = await request(app).get('/api/templates');

      expect(res.status).toBe(200);
      expect(res.body.templates).toHaveLength(7);
    });

    it('handles catalog with invalid schema gracefully', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ bad: 'data' }));

      const res = await request(app).get('/api/templates');

      expect(res.status).toBe(200);
      expect(res.body.templates).toHaveLength(7);
    });
  });

  describe('POST /api/templates', () => {
    it('creates user template with builtin: false forced', async () => {
      const newTemplate = {
        id: 'my-new',
        name: 'My New Template',
        description: 'A new template',
        source: 'github:me/my-new',
        category: 'custom',
        builtin: true, // should be forced to false
        tags: ['test'],
      };

      const res = await request(app).post('/api/templates').send(newTemplate);

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('my-new');
      expect(res.body.builtin).toBe(false);

      // Verify writeFile was called with the template
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written.templates).toHaveLength(1);
      expect(written.templates[0].builtin).toBe(false);
    });

    it('returns 400 on missing required fields', async () => {
      const res = await request(app).post('/api/templates').send({ id: 'incomplete' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when id is empty string', async () => {
      const res = await request(app).post('/api/templates').send({
        id: '',
        name: 'Test',
        description: 'desc',
        source: 'github:test',
        category: 'general',
      });

      expect(res.status).toBe(400);
    });

    it('returns 409 on ID conflict with built-in template', async () => {
      const res = await request(app).post('/api/templates').send({
        id: 'nextjs',
        name: 'My Next.js',
        description: 'Duplicate',
        source: 'github:me/nextjs',
        category: 'frontend',
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('built-in');
    });

    it('returns 409 on ID conflict with existing user template', async () => {
      setUserCatalog([
        {
          id: 'existing',
          name: 'Existing',
          description: 'Already exists',
          source: 'github:me/existing',
          category: 'custom',
          builtin: false,
          tags: [],
        },
      ]);

      const res = await request(app).post('/api/templates').send({
        id: 'existing',
        name: 'Duplicate',
        description: 'Conflict',
        source: 'github:me/dup',
        category: 'custom',
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('applies default values for optional fields', async () => {
      const res = await request(app).post('/api/templates').send({
        id: 'minimal',
        name: 'Minimal',
        description: 'Just the basics',
        source: 'github:me/minimal',
        category: 'general',
      });

      expect(res.status).toBe(201);
      expect(res.body.tags).toEqual([]);
      expect(res.body.builtin).toBe(false);
    });
  });

  describe('DELETE /api/templates/:id', () => {
    it('removes user template', async () => {
      setUserCatalog([
        {
          id: 'to-delete',
          name: 'Delete Me',
          description: 'Will be deleted',
          source: 'github:me/delete',
          category: 'custom',
          builtin: false,
          tags: [],
        },
      ]);

      const res = await request(app).delete('/api/templates/to-delete');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe('to-delete');

      // Verify writeFile was called with empty templates array
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
      expect(written.templates).toHaveLength(0);
    });

    it('returns 403 when trying to delete built-in template', async () => {
      const res = await request(app).delete('/api/templates/nextjs');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('built-in');
    });

    it('returns 404 for non-existent template', async () => {
      const res = await request(app).delete('/api/templates/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });
});
