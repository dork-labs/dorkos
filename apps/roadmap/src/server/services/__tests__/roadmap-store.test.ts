import { describe, it, expect, beforeEach } from 'vitest';
import { Memory } from 'lowdb';
import { RoadmapStore, type RoadmapData } from '../roadmap-store.js';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

/** Helper to build a minimal valid CreateItemInput. */
function makeItemInput(overrides: Partial<RoadmapItem> = {}) {
  return {
    title: overrides.title ?? 'Test item',
    type: overrides.type ?? ('feature' as const),
    moscow: overrides.moscow ?? ('must-have' as const),
    status: overrides.status ?? ('not-started' as const),
    health: overrides.health ?? ('on-track' as const),
    timeHorizon: overrides.timeHorizon ?? ('now' as const),
    ...overrides,
  };
}

describe('RoadmapStore', () => {
  let store: RoadmapStore;

  beforeEach(async () => {
    store = new RoadmapStore(new Memory<RoadmapData>());
    await store.init();
  });

  describe('createItem', () => {
    it('creates an item with generated id and timestamps', async () => {
      const item = await store.createItem(makeItemInput({ title: 'My feature' }));

      expect(item.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(item.title).toBe('My feature');
      expect(item.createdAt).toBeTruthy();
      expect(item.updatedAt).toBeTruthy();
      expect(new Date(item.createdAt).getTime()).not.toBeNaN();
    });
  });

  describe('listItems', () => {
    it('lists all items', async () => {
      await store.createItem(makeItemInput({ title: 'A' }));
      await store.createItem(makeItemInput({ title: 'B' }));

      const items = store.listItems();
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    });
  });

  describe('getItem', () => {
    it('gets item by id', async () => {
      const created = await store.createItem(makeItemInput({ title: 'Find me' }));
      const found = store.getItem(created.id);

      expect(found).toBeDefined();
      expect(found!.title).toBe('Find me');
    });

    it('returns undefined for missing item', () => {
      const result = store.getItem('nonexistent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('updateItem', () => {
    it('updates an item and changes updatedAt', async () => {
      const created = await store.createItem(makeItemInput({ title: 'Original' }));
      const originalUpdatedAt = created.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5));

      const updated = await store.updateItem(created.id, { title: 'Changed' });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Changed');
      expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
    });

    it('returns null when updating nonexistent item', async () => {
      const result = await store.updateItem('nonexistent-id', { title: 'Nope' });
      expect(result).toBeNull();
    });
  });

  describe('deleteItem', () => {
    it('deletes an item', async () => {
      const created = await store.createItem(makeItemInput({ title: 'Delete me' }));

      const deleted = await store.deleteItem(created.id);
      expect(deleted).toBe(true);
      expect(store.listItems()).toHaveLength(0);
    });

    it('returns false when deleting nonexistent item', async () => {
      const result = await store.deleteItem('nonexistent-id');
      expect(result).toBe(false);
    });
  });

  describe('reorder', () => {
    it('reorders items by setting order field', async () => {
      const a = await store.createItem(makeItemInput({ title: 'A' }));
      const b = await store.createItem(makeItemInput({ title: 'B' }));
      const c = await store.createItem(makeItemInput({ title: 'C' }));

      await store.reorder([c.id, a.id, b.id]);

      expect(store.getItem(c.id)!.order).toBe(0);
      expect(store.getItem(a.id)!.order).toBe(1);
      expect(store.getItem(b.id)!.order).toBe(2);
    });
  });

  describe('getMeta / health stats', () => {
    it('computes health stats correctly', async () => {
      await store.createItem(
        makeItemInput({ moscow: 'must-have', status: 'in-progress', health: 'on-track' }),
      );
      await store.createItem(
        makeItemInput({ moscow: 'must-have', status: 'completed', health: 'on-track' }),
      );
      await store.createItem(
        makeItemInput({ moscow: 'should-have', status: 'not-started', health: 'at-risk' }),
      );
      await store.createItem(
        makeItemInput({ moscow: 'could-have', status: 'on-hold', health: 'blocked' }),
      );

      const meta = store.getMeta();
      expect(meta.health.totalItems).toBe(4);
      expect(meta.health.mustHavePercent).toBe(50);
      expect(meta.health.inProgressCount).toBe(1);
      expect(meta.health.atRiskCount).toBe(1);
      expect(meta.health.blockedCount).toBe(1);
      expect(meta.health.completedCount).toBe(1);
    });

    it('mustHavePercent is 0 when no items exist', () => {
      const meta = store.getMeta();
      expect(meta.health.totalItems).toBe(0);
      expect(meta.health.mustHavePercent).toBe(0);
    });
  });
});
