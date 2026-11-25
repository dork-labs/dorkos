/**
 * A person's work queue doors, served by the capability mount on
 * `/api/agents/{id}/work-queue/*` and `/api/work-queues/stop` (DOR-3462,
 * ADR 261123-170830): the same paths, bodies and statuses the hand routes had,
 * and every one refuses an agent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { CapabilityDeps } from '../../services/core/capabilities/index.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { workQueuePersonDomain } from '../../services/work-queue/work-queue-person-capabilities.js';
import { WorkQueueError } from '../../services/work-queue/work-queue-service.js';

type QueueDeps = NonNullable<CapabilityDeps['workQueuePersonDeps']>;

const QUEUE = { agentId: 'scout', enabled: true, target: 1, dailyStartCap: 5, items: [] };
const ITEM = { id: 'item-1', agentId: 'scout', title: 'Tidy', prompt: 'Tidy up', state: 'queued' };

const fixtureTarget = swappableServer();

// The `/api` chain's host guard and session gate read the real config: login off.
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dorkos-work-queue-http-'));
  initConfigManager(home);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

let service: { [K in keyof QueueDeps['service']]: ReturnType<typeof vi.fn> };

function serve() {
  const deps: QueueDeps = {
    service: service as unknown as QueueDeps['service'],
    agentExists: (id) => id === 'scout',
  };
  return fixtureTarget.mount(
    honoGroupListener(capabilityGroup(workQueuePersonDomain, { workQueuePersonDeps: deps }))
  );
}

beforeEach(() => {
  service = {
    read: vi.fn(() => QUEUE),
    add: vi.fn(() => ITEM),
    remove: vi.fn(),
    update: vi.fn(() => ({ ...QUEUE, enabled: false })),
    reorder: vi.fn(() => QUEUE),
    requeue: vi.fn(() => ITEM),
    setAllStopped: vi.fn(),
  };
});

describe('work queue doors', () => {
  it('refuses an agent on every door, before anything is read or changed', async () => {
    const server = serve();
    const calls = [
      request(server).get('/api/agents/scout/work-queue'),
      request(server).patch('/api/agents/scout/work-queue').send({ enabled: true }),
      request(server).put('/api/work-queues/stop').send({ stopped: false }),
      request(server)
        .put('/api/agents/scout/work-queue/order')
        .send({ itemIds: ['item-1'] }),
      request(server).post('/api/agents/scout/work-queue/items').send({ title: 't', prompt: 'p' }),
      request(server).delete('/api/agents/scout/work-queue/items/item-1'),
      request(server).post('/api/agents/scout/work-queue/items/item-1/requeue'),
    ];
    for (const call of calls) {
      const res = await call.set('X-DorkOS-Agent', 'x');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('reads a queue, and answers 404 for an agent not on the team', async () => {
    const server = serve();
    const res = await request(server).get('/api/agents/scout/work-queue');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(QUEUE);
    expect(service.read).toHaveBeenCalledWith('scout');

    const missing = await request(server).get('/api/agents/nobody/work-queue');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      code: 'not_found',
      detail: 'No agent on the team has that id.',
    });
  });

  it('changes a queue’s settings, and refuses a body that changes nothing', async () => {
    const server = serve();
    const res = await request(server)
      .patch('/api/agents/scout/work-queue')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith('scout', { enabled: false });

    const empty = await request(server).patch('/api/agents/scout/work-queue').send({});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('invalid_request');
  });

  it('stops every queue and answers with the stop', async () => {
    const res = await request(serve()).put('/api/work-queues/stop').send({ stopped: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stopped: true });
    expect(service.setAllStopped).toHaveBeenCalledWith(true);
  });

  it('sets the order of what waits', async () => {
    const res = await request(serve())
      .put('/api/agents/scout/work-queue/order')
      .send({ itemIds: ['b', 'a'] });
    expect(res.status).toBe(200);
    expect(service.reorder).toHaveBeenCalledWith('scout', ['b', 'a']);
  });

  it('adds an item as the person (201), and a full queue is a 409', async () => {
    const server = serve();
    const res = await request(server)
      .post('/api/agents/scout/work-queue/items')
      .send({ title: 'Tidy', prompt: 'Tidy up' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(ITEM);
    expect(service.add).toHaveBeenCalledWith({ kind: 'person' }, 'scout', {
      title: 'Tidy',
      prompt: 'Tidy up',
    });

    service.add.mockImplementation(() => {
      throw new WorkQueueError('FULL', 'This queue already has 200 items waiting.');
    });
    const full = await request(server)
      .post('/api/agents/scout/work-queue/items')
      .send({ title: 'Tidy', prompt: 'Tidy up' });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({
      code: 'conflict',
      detail: 'This queue already has 200 items waiting.',
    });
  });

  it('removes a waiting item (204), and one that started is a 409', async () => {
    const server = serve();
    const res = await request(server).delete('/api/agents/scout/work-queue/items/item-1');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(service.remove).toHaveBeenCalledWith({ kind: 'person' }, 'item-1');

    service.remove.mockImplementation(() => {
      throw new WorkQueueError('NOT_QUEUED', 'That item has already started.');
    });
    const started = await request(server).delete('/api/agents/scout/work-queue/items/item-1');
    expect(started.status).toBe(409);
    expect(started.body.detail).toBe('That item has already started.');
  });

  it('requeues an ended item, and an unknown one is a 404', async () => {
    const server = serve();
    const res = await request(server).post('/api/agents/scout/work-queue/items/item-1/requeue');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ITEM);

    service.requeue.mockImplementation(() => {
      throw new WorkQueueError('NOT_FOUND', 'No item in a work queue has that id.');
    });
    const missing = await request(server).post('/api/agents/scout/work-queue/items/x/requeue');
    expect(missing.status).toBe(404);
    expect(missing.body.detail).toBe('No item in a work queue has that id.');
  });
});
