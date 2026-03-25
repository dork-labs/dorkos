import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

// Declared at module scope so the vi.mock factory closure can reference it.
// Initialized in beforeEach so each test starts with a fresh spy instance.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';

const app = createApp();

/** Valid UUID for session ID params (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
});

describe('POST /api/sessions/:id/submit-answers', () => {
  it('returns 200 when pending question exists', async () => {
    fakeRuntime.submitAnswers.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fakeRuntime.submitAnswers).toHaveBeenCalledWith(SESSION_ID, 'tc-1', {
      '0': 'Option A',
    });
  });

  it('returns 404 when session does not exist (submit-answers)', async () => {
    fakeRuntime.submitAnswers.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending question');
  });

  it('returns 409 when session exists but question already resolved', async () => {
    fakeRuntime.submitAnswers.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Interaction already resolved');
    expect(res.body.code).toBe('INTERACTION_ALREADY_RESOLVED');
  });

  it('returns 400 when toolCallId is missing', async () => {
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ answers: { '0': 'Option A' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });

  it('returns 400 when answers is missing', async () => {
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/submit-answers`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });
});

describe('POST /api/sessions/:id/approve', () => {
  it('returns 200 when pending approval exists', async () => {
    fakeRuntime.approveTool.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fakeRuntime.approveTool).toHaveBeenCalledWith(SESSION_ID, 'tc-1', true);
  });

  it('returns 404 when session does not exist (approve)', async () => {
    fakeRuntime.approveTool.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending approval');
  });

  it('returns 409 when session exists but approval already resolved', async () => {
    fakeRuntime.approveTool.mockReturnValue(false);
    fakeRuntime.hasSession.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/approve`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Interaction already resolved');
    expect(res.body.code).toBe('INTERACTION_ALREADY_RESOLVED');
  });
});

describe('POST /api/sessions/:id/deny', () => {
  it('returns 200 when pending approval exists', async () => {
    fakeRuntime.approveTool.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fakeRuntime.approveTool).toHaveBeenCalledWith(SESSION_ID, 'tc-1', false);
  });
});
