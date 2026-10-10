/**
 * `GET /api/keep-awake` — whether DorkOS is keeping this computer awake, in the
 * shape the app and the OpenAPI document promise.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { KeepAwakeStatusSchema } from '@dorkos/shared/schemas';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { createApp } from '../../app.js';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import { keepAwakeService } from '../../services/core/keep-awake/index.js';

const admission = new MainRequestAdmission();
const app = createApp({ admission });
// Routed as the running server routes: the moved groups answer from Hono.
const testServer = listeningServer(composedListener(app, admission));

describe('GET /api/keep-awake', () => {
  it('answers the status, valid against its schema', async () => {
    const res = await request(testServer).get('/api/keep-awake');
    expect(res.status).toBe(200);
    expect(KeepAwakeStatusSchema.parse(res.body)).toEqual(res.body);
  });

  it('counts the work in flight, each piece once', async () => {
    const chat = keepAwakeService.holdTurn({ sessionId: 'route-chat', room: false });
    const room = keepAwakeService.holdTurn({ sessionId: 'route-room', room: true });
    const task = keepAwakeService.holdTask('route-run');
    task.attachSession('route-task-session');
    const taskTurn = keepAwakeService.holdTurn({ sessionId: 'route-task-session', room: false });
    try {
      const res = await request(testServer).get('/api/keep-awake');
      expect(res.body.working).toEqual({ chats: 1, rooms: 1, tasks: 1, waking: false });
    } finally {
      for (const hold of [chat, room, task, taskTurn]) hold.release();
    }
  });
});
