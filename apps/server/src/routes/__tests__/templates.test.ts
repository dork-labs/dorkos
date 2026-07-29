/**
 * Template route tests run against a real temp directory rather than a mocked
 * `fs/promises`. The old mock pinned the write internals (which `writeFile`
 * call carried which JSON), and a mocked filesystem cannot lose a concurrent
 * update — the very defect DOR-697 fixed here. Asserting the catalog file's
 * actual content covers both.
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
import type { TemplateEntry } from '@dorkos/shared/template-catalog';
import { createTemplateRouter } from '../templates.js';

let DORK_HOME: string;

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/templates', createTemplateRouter(DORK_HOME));
  return app;
}

function catalogPath(): string {
  return path.join(DORK_HOME, 'agent-templates.json');
}

/** Write a user catalog to disk the way the route persists it. */
async function seedUserCatalog(templates: Array<Partial<TemplateEntry> & { id: string }>) {
  await fs.writeFile(catalogPath(), JSON.stringify({ version: 1, templates }, null, 2), 'utf-8');
}

/** Read the persisted catalog back; fails the test if it is missing or torn. */
async function readCatalog(): Promise<{ version: number; templates: TemplateEntry[] }> {
  return JSON.parse(await fs.readFile(catalogPath(), 'utf-8')) as {
    version: number;
    templates: TemplateEntry[];
  };
}

const USER_TEMPLATE: Omit<TemplateEntry, 'id'> = {
  name: 'My Custom',
  description: 'A custom template',
  source: 'github:me/my-template',
  category: 'custom',
  builtin: false,
  tags: ['custom'],
};

describe('Template Routes', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    DORK_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'templates-routes-'));
    app = createApp();
  });

  afterEach(async () => {
    await fs.rm(DORK_HOME, { recursive: true, force: true });
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
      await seedUserCatalog([{ id: 'my-custom', ...USER_TEMPLATE }]);

      const res = await request(app).get('/api/templates');

      expect(res.status).toBe(200);
      expect(res.body.templates).toHaveLength(8);
      expect(res.body.templates.find((t: { id: string }) => t.id === 'my-custom')).toBeDefined();
    });

    it('handles malformed catalog file gracefully', async () => {
      await fs.writeFile(catalogPath(), '{ not valid json !!!', 'utf-8');

      const res = await request(app).get('/api/templates');

      expect(res.status).toBe(200);
      expect(res.body.templates).toHaveLength(7);
    });

    it('handles catalog with invalid schema gracefully', async () => {
      await fs.writeFile(catalogPath(), JSON.stringify({ bad: 'data' }), 'utf-8');

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

      const written = await readCatalog();
      expect(written.templates).toHaveLength(1);
      expect(written.templates[0]!.builtin).toBe(false);
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
      await seedUserCatalog([{ id: 'existing', ...USER_TEMPLATE }]);

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

    // DOR-697. Both POST and DELETE read the catalog, mutate, and write it
    // back — a read-modify-write over one file — and the old write was a plain
    // truncating `writeFile`, so a reader could catch the mid-truncation state,
    // parse-fail to `[]`, and the next write would erase the whole catalog.
    // Concurrency is the reproduction; sequentially these cannot fail.
    describe('concurrent requests', () => {
      it('keeps every template when many POSTs land at once', async () => {
        const N = 10;

        const responses = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            request(app)
              .post('/api/templates')
              .send({
                id: `tpl-${i}`,
                name: `Template ${i}`,
                description: 'Concurrent write test',
                source: `github:me/tpl-${i}`,
                category: 'custom',
              })
          )
        );

        expect(responses.map((r) => r.status)).toEqual(Array.from({ length: N }, () => 201));

        // Every 201 must be durable: a lost update also returns 201.
        const written = await readCatalog();
        expect(written.templates.map((t) => t.id).sort()).toEqual(
          Array.from({ length: N }, (_, i) => `tpl-${i}`).sort()
        );
      });

      it('a concurrent DELETE and POST both survive', async () => {
        await seedUserCatalog([{ id: 'doomed', ...USER_TEMPLATE }]);

        const [del, post] = await Promise.all([
          request(app).delete('/api/templates/doomed'),
          request(app).post('/api/templates').send({
            id: 'fresh',
            name: 'Fresh',
            description: 'Added during delete',
            source: 'github:me/fresh',
            category: 'custom',
          }),
        ]);

        expect(del.status).toBe(200);
        expect(post.status).toBe(201);
        const ids = (await readCatalog()).templates.map((t) => t.id);
        expect(ids).toEqual(['fresh']);
      });
    });
  });

  describe('DELETE /api/templates/:id', () => {
    it('removes user template', async () => {
      await seedUserCatalog([{ id: 'to-delete', ...USER_TEMPLATE }]);

      const res = await request(app).delete('/api/templates/to-delete');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe('to-delete');

      const written = await readCatalog();
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
