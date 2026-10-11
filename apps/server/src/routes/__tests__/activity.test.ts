import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createActivityRoutes } from '../activity.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { ActivityService } from '../../services/activity/activity-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

// The routes are served through the `/api` chain, whose host guard and session
// gate read the login setting: off, as on a fresh install.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Activity routes', () => {
  let activityService: ActivityService;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    activityService = new ActivityService(db);
    fixtureTarget.mount(
      honoGroupListener({ path: '/api/activity', routes: createActivityRoutes(activityService) })
    );
  });

  describe('GET /api/activity', () => {
    it('returns 200 with empty items and null cursor', async () => {
      const res = await request(fixtureServer).get('/api/activity');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    });

    it('applies query param filtering', async () => {
      // Seed events with different categories and actor types
      await activityService.emit({
        actorType: 'user',
        actorLabel: 'You',
        category: 'tasks',
        eventType: 'tasks.run_success',
        summary: 'Tasks ran',
      });
      await activityService.emit({
        actorType: 'agent',
        actorLabel: 'Agent',
        category: 'relay',
        eventType: 'relay.message_delivered',
        summary: 'Message delivered',
      });
      await activityService.emit({
        actorType: 'system',
        actorLabel: 'System',
        category: 'agent',
        eventType: 'agent.registered',
        summary: 'Agent registered',
      });

      // Filter by categories
      const catRes = await request(fixtureServer).get('/api/activity?categories=tasks,relay');
      expect(catRes.status).toBe(200);
      expect(catRes.body.items).toHaveLength(2);
      const categories = catRes.body.items.map((i: { category: string }) => i.category);
      expect(categories).toContain('tasks');
      expect(categories).toContain('relay');

      // Filter by actorType
      const actorRes = await request(fixtureServer).get('/api/activity?actorType=agent');
      expect(actorRes.status).toBe(200);
      expect(actorRes.body.items).toHaveLength(1);
      expect(actorRes.body.items[0].actorType).toBe('agent');
    });

    it('rejects invalid params with 400', async () => {
      const res = await request(fixtureServer).get('/api/activity?limit=-1');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('applies default limit of 50', async () => {
      const listSpy = vi.spyOn(activityService, 'list');

      await request(fixtureServer).get('/api/activity');

      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });
  });
});
