import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { Memory } from 'lowdb';
import { createApp } from '../../app.js';
import { RoadmapStore, type RoadmapData } from '../../services/roadmap-store.js';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

function makeValidItem(overrides: Partial<RoadmapItem> = {}) {
  return {
    title: 'Test feature',
    type: 'feature' as const,
    moscow: 'must-have' as const,
    status: 'not-started' as const,
    health: 'on-track' as const,
    timeHorizon: 'now' as const,
    ...overrides,
  };
}

describe('Items routes', () => {
  let store: RoadmapStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    store = new RoadmapStore(new Memory<RoadmapData>());
    await store.init();
    app = createApp({ store, projectRoot: '/tmp' });
  });

  describe('GET /api/roadmap/items', () => {
    it('returns empty array when no items exist', async () => {
      const res = await request(app).get('/api/roadmap/items');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns all items', async () => {
      await store.createItem(makeValidItem({ title: 'Item A' }));
      await store.createItem(makeValidItem({ title: 'Item B' }));

      const res = await request(app).get('/api/roadmap/items');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].title).toBe('Item A');
      expect(res.body[1].title).toBe('Item B');
    });
  });

  describe('POST /api/roadmap/items', () => {
    it('creates an item and returns 201', async () => {
      const res = await request(app)
        .post('/api/roadmap/items')
        .send(makeValidItem({ title: 'New feature' }));

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe('New feature');
      expect(res.body.createdAt).toBeDefined();
      expect(res.body.updatedAt).toBeDefined();
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app).post('/api/roadmap/items').send({ title: 'No type' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request');
    });

    it('returns 400 for title too short', async () => {
      const res = await request(app)
        .post('/api/roadmap/items')
        .send(makeValidItem({ title: 'ab' }));

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid enum value', async () => {
      const res = await request(app)
        .post('/api/roadmap/items')
        .send(makeValidItem({ type: 'invalid' as never }));

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/roadmap/items/:id', () => {
    it('returns a single item', async () => {
      const created = await store.createItem(makeValidItem({ title: 'Find me' }));

      const res = await request(app).get(`/api/roadmap/items/${created.id}`);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Find me');
    });

    it('returns 404 for non-existent item', async () => {
      const res = await request(app).get('/api/roadmap/items/00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Item not found');
    });
  });

  describe('PATCH /api/roadmap/items/:id', () => {
    it('updates an existing item', async () => {
      const created = await store.createItem(makeValidItem({ title: 'Original' }));

      const res = await request(app)
        .patch(`/api/roadmap/items/${created.id}`)
        .send({ title: 'Updated title' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Updated title');
      expect(res.body.updatedAt).not.toBe(created.updatedAt);
    });

    it('returns 404 for non-existent item', async () => {
      const res = await request(app)
        .patch('/api/roadmap/items/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Ghost update' });

      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid update payload', async () => {
      const created = await store.createItem(makeValidItem());

      const res = await request(app)
        .patch(`/api/roadmap/items/${created.id}`)
        .send({ status: 'bogus-status' });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/roadmap/items/:id', () => {
    it('deletes an existing item', async () => {
      const created = await store.createItem(makeValidItem());

      const res = await request(app).delete(`/api/roadmap/items/${created.id}`);
      expect(res.status).toBe(204);

      // Confirm gone
      const items = store.listItems();
      expect(items).toHaveLength(0);
    });

    it('returns 404 for non-existent item', async () => {
      const res = await request(app).delete(
        '/api/roadmap/items/00000000-0000-0000-0000-000000000000',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/roadmap/items/reorder', () => {
    it('reorders items by id array', async () => {
      const a = await store.createItem(makeValidItem({ title: 'A' }));
      const b = await store.createItem(makeValidItem({ title: 'B' }));
      const c = await store.createItem(makeValidItem({ title: 'C' }));

      const res = await request(app)
        .post('/api/roadmap/items/reorder')
        .send({ orderedIds: [c.id, a.id, b.id] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Verify order fields were set
      const items = store.listItems();
      const cItem = items.find((i) => i.id === c.id);
      const aItem = items.find((i) => i.id === a.id);
      const bItem = items.find((i) => i.id === b.id);
      expect(cItem?.order).toBe(0);
      expect(aItem?.order).toBe(1);
      expect(bItem?.order).toBe(2);
    });

    it('returns 400 for invalid reorder payload', async () => {
      const res = await request(app)
        .post('/api/roadmap/items/reorder')
        .send({ orderedIds: ['not-a-uuid'] });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing orderedIds', async () => {
      const res = await request(app).post('/api/roadmap/items/reorder').send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/roadmap/meta', () => {
    it('returns project metadata with health stats', async () => {
      await store.createItem(makeValidItem({ moscow: 'must-have', status: 'in-progress' }));

      const res = await request(app).get('/api/roadmap/meta');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('health');
      expect(res.body.health.totalItems).toBe(1);
      expect(res.body.health.mustHavePercent).toBe(100);
      expect(res.body.health.inProgressCount).toBe(1);
    });
  });
});
