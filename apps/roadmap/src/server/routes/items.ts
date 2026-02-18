/**
 * CRUD routes for roadmap items.
 *
 * Mounts at `/api/roadmap/items`. Provides list, get, create, update, delete,
 * and reorder endpoints with Zod request validation.
 *
 * @module server/routes/items
 */
import { Router } from 'express';
import type { RoadmapStore } from '../services/roadmap-store.js';
import {
  CreateItemRequestSchema,
  UpdateItemRequestSchema,
  ReorderRequestSchema,
} from '@dorkos/shared/roadmap-schemas';
import { logger } from '../lib/logger.js';

/**
 * Create the items router with an injected RoadmapStore.
 *
 * @param store - Initialized RoadmapStore instance
 */
export function createItemsRouter(store: RoadmapStore): Router {
  const router = Router();

  // GET /api/roadmap/items — list all items
  router.get('/', (_req, res) => {
    const items = store.listItems();
    res.json(items);
  });

  // POST /api/roadmap/items/reorder — reorder items (must be before /:id)
  router.post('/reorder', async (req, res) => {
    const parsed = ReorderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
    }
    await store.reorder(parsed.data.orderedIds);
    res.json({ ok: true });
  });

  // GET /api/roadmap/items/:id — get single item
  router.get('/:id', (req, res) => {
    const item = store.getItem(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  });

  // POST /api/roadmap/items — create item
  router.post('/', async (req, res) => {
    const parsed = CreateItemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
    }
    const item = await store.createItem(parsed.data);
    logger.info(`Created item ${item.id}: ${item.title}`);
    res.status(201).json(item);
  });

  // PATCH /api/roadmap/items/:id — update item
  router.patch('/:id', async (req, res) => {
    const parsed = UpdateItemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
    }
    const updated = await store.updateItem(req.params.id, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(updated);
  });

  // DELETE /api/roadmap/items/:id — delete item
  router.delete('/:id', async (req, res) => {
    const deleted = await store.deleteItem(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Item not found' });
    }
    logger.info(`Deleted item ${req.params.id}`);
    res.status(204).end();
  });

  return router;
}
