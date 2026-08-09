import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActivityService } from '../activity-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { activityEvents, type Db } from '@dorkos/db';

describe('ActivityService', () => {
  let service: ActivityService;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    service = new ActivityService(db);
  });

  // === emit() ===

  describe('emit()', () => {
    it('inserts a row with correct fields', async () => {
      await service.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'tasks',
        eventType: 'tasks.run_success',
        resourceType: 'schedule',
        resourceId: 'sched-1',
        resourceLabel: 'daily-digest',
        summary: 'daily-digest ran successfully (2m 14s)',
        linkPath: '/',
      });

      const rows = db.select().from(activityEvents).all();
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.id).toBeDefined();
      expect(row.actorType).toBe('user');
      expect(row.actorLabel).toBe('You');
      expect(row.category).toBe('tasks');
      expect(row.eventType).toBe('tasks.run_success');
      expect(row.resourceType).toBe('schedule');
      expect(row.resourceId).toBe('sched-1');
      expect(row.resourceLabel).toBe('daily-digest');
      expect(row.summary).toBe('daily-digest ran successfully (2m 14s)');
      expect(row.linkPath).toBe('/');
      expect(row.occurredAt).toBeDefined();
      expect(row.createdAt).toBeDefined();
    });

    it('never throws on DB error', async () => {
      // Create a service with a broken DB by closing the underlying connection
      const brokenDb = createTestDb();
      const brokenService = new ActivityService(brokenDb);

      // Spy on the insert to force an error
      vi.spyOn(brokenDb, 'insert').mockImplementation(() => {
        throw new Error('DB write failed');
      });

      // Should resolve without throwing
      await expect(
        brokenService.emit({
          actorType: 'system',
          actorLabel: 'System',
          category: 'system',
          eventType: 'system.started',
          summary: 'Server started',
        })
      ).resolves.toBeUndefined();
    });

    it('serializes metadata to JSON string', async () => {
      await service.emit({
        actorType: 'agent',
        actorLabel: 'Agent-1',
        category: 'agent',
        eventType: 'agent.error',
        summary: 'Agent timed out',
        metadata: { error: 'timeout', retries: 3 },
      });

      const rows = db.select().from(activityEvents).all();
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].metadata).toBe('string');
      expect(JSON.parse(rows[0].metadata!)).toEqual({ error: 'timeout', retries: 3 });
    });

    it('uses current time when occurredAt is omitted', async () => {
      const before = new Date().toISOString();

      await service.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'config',
        eventType: 'config.changed',
        summary: 'Updated theme',
      });

      const after = new Date().toISOString();
      const rows = db.select().from(activityEvents).all();
      expect(rows).toHaveLength(1);

      const occurredAt = rows[0].occurredAt;
      expect(occurredAt >= before).toBe(true);
      expect(occurredAt <= after).toBe(true);
    });
  });

  // === observe() ===

  describe('observe()', () => {
    it('hands each event to its observers, as it was written', async () => {
      const seen: string[] = [];
      service.observe((event) => seen.push(`${event.eventType}:${event.resourceLabel}`));

      await service.emit({
        actorType: 'tasks',
        actorLabel: 'Tasks',
        category: 'tasks',
        eventType: 'tasks.task_created',
        resourceType: 'schedule',
        resourceId: 'sched-1',
        resourceLabel: 'nightly digest',
        summary: 'Created nightly digest',
      });

      expect(seen).toEqual(['tasks.task_created:nightly digest']);
    });

    it('tells nobody about an event that failed to persist', async () => {
      const seen: string[] = [];
      // The whole reason observers fire after the insert: a moment detector that
      // reacted to a write that never landed would mark a milestone this install
      // has no record of.
      vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('DB write failed');
      });
      service.observe((event) => seen.push(event.eventType));

      await service.emit({
        actorType: 'system',
        actorLabel: 'System',
        category: 'system',
        eventType: 'system.started',
        summary: 'Server started',
      });

      expect(seen).toEqual([]);
    });

    it('keeps going when one observer throws, and stops when one unsubscribes', async () => {
      const seen: string[] = [];
      service.observe(() => {
        throw new Error('reaction failed');
      });
      const stop = service.observe((event) => seen.push(event.eventType));

      await service.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'agent',
        eventType: 'agent.created',
        summary: 'Created tangerines',
      });
      stop();
      await service.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'agent',
        eventType: 'agent.removed',
        summary: 'Removed tangerines',
      });

      expect(seen).toEqual(['agent.created']);
      // And the throwing observer never cost the write either.
      expect(db.select().from(activityEvents).all()).toHaveLength(2);
    });
  });

  // === list() ===

  describe('list()', () => {
    /** Helper to insert N events with sequential timestamps. */
    async function insertEvents(
      count: number,
      overrides: Partial<Parameters<typeof service.emit>[0]> = {}
    ) {
      for (let i = 0; i < count; i++) {
        const ts = new Date(Date.now() - (count - i) * 1000).toISOString();
        await service.emit({
          occurredAt: ts,
          actorType: 'system',
          actorLabel: 'System',
          category: 'system',
          eventType: 'system.test',
          summary: `Event ${i + 1}`,
          ...overrides,
        });
      }
    }

    it('returns paginated results with nextCursor', async () => {
      await insertEvents(5);

      const result = await service.list({ limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();
    });

    it('supports cursor-based pagination across pages', async () => {
      await insertEvents(5);

      const page1 = await service.list({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await service.list({ limit: 2, before: page1.nextCursor! });
      expect(page2.items).toHaveLength(2);

      // Pages should not overlap
      const page1Ids = page1.items.map((i) => i.id);
      const page2Ids = page2.items.map((i) => i.id);
      expect(page1Ids).not.toEqual(page2Ids);

      // Page 2 events should be older than page 1 events
      expect(page2.items[0].occurredAt < page1.items[1].occurredAt).toBe(true);
    });

    it('filters by category', async () => {
      await service.emit({
        occurredAt: new Date().toISOString(),
        actorType: 'system',
        actorLabel: 'System',
        category: 'tasks',
        eventType: 'tasks.run_success',
        summary: 'Tasks event',
      });
      await service.emit({
        occurredAt: new Date().toISOString(),
        actorType: 'system',
        actorLabel: 'System',
        category: 'relay',
        eventType: 'relay.message_delivered',
        summary: 'Relay event',
      });
      await service.emit({
        occurredAt: new Date().toISOString(),
        actorType: 'user',
        actorLabel: 'You',
        category: 'config',
        eventType: 'config.changed',
        summary: 'Config event',
      });

      const result = await service.list({ limit: 50, categories: 'tasks,relay' });
      expect(result.items).toHaveLength(2);
      const categories = result.items.map((i) => i.category);
      expect(categories).toContain('tasks');
      expect(categories).toContain('relay');
      expect(categories).not.toContain('config');
    });

    it('filters by actorType', async () => {
      await service.emit({
        occurredAt: new Date().toISOString(),
        actorType: 'agent',
        actorLabel: 'Agent-1',
        category: 'agent',
        eventType: 'agent.started',
        summary: 'Agent started',
      });
      await service.emit({
        occurredAt: new Date().toISOString(),
        actorType: 'user',
        actorLabel: 'You',
        category: 'config',
        eventType: 'config.changed',
        summary: 'Config changed',
      });

      const result = await service.list({ limit: 50, actorType: 'agent' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].actorType).toBe('agent');
    });

    it('returns null nextCursor when no more pages', async () => {
      await insertEvents(2);

      const result = await service.list({ limit: 50 });
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it('parses metadata back to object', async () => {
      await service.emit({
        occurredAt: new Date().toISOString(),
        actorType: 'agent',
        actorLabel: 'Agent-1',
        category: 'agent',
        eventType: 'agent.error',
        summary: 'Agent failed',
        metadata: { error: 'timeout', code: 504 },
      });

      const result = await service.list({ limit: 50 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].metadata).toEqual({ error: 'timeout', code: 504 });
      expect(typeof result.items[0].metadata).toBe('object');
    });
  });

  // === prune() ===

  describe('prune()', () => {
    it('removes old events beyond retention period', async () => {
      // Insert an event 40 days ago
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);

      await service.emit({
        occurredAt: oldDate.toISOString(),
        actorType: 'system',
        actorLabel: 'System',
        category: 'system',
        eventType: 'system.old',
        summary: 'Old event',
      });

      // Verify it exists
      const before = db.select().from(activityEvents).all();
      expect(before).toHaveLength(1);

      // Prune with 30-day retention
      const pruned = await service.prune(30);
      expect(pruned).toBe(1);

      // Verify it was deleted
      const after = db.select().from(activityEvents).all();
      expect(after).toHaveLength(0);
    });

    it('preserves recent events', async () => {
      // Insert a recent event (today)
      await service.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'config',
        eventType: 'config.changed',
        summary: 'Recent event',
      });

      // Insert an old event (40 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);
      await service.emit({
        occurredAt: oldDate.toISOString(),
        actorType: 'system',
        actorLabel: 'System',
        category: 'system',
        eventType: 'system.old',
        summary: 'Old event',
      });

      // Verify both exist
      const before = db.select().from(activityEvents).all();
      expect(before).toHaveLength(2);

      // Prune with 30-day retention
      const pruned = await service.prune(30);
      expect(pruned).toBe(1);

      // Only the recent event should remain
      const after = db.select().from(activityEvents).all();
      expect(after).toHaveLength(1);
      expect(after[0].summary).toBe('Recent event');
    });
  });
});
