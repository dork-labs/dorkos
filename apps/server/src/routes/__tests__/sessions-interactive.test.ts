import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies that createApp imports
vi.mock('../../services/session/transcript-reader.js', () => ({
  transcriptReader: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    readTranscript: vi.fn(),
    listTranscripts: vi.fn(),
  },
}));

vi.mock('../../services/core/agent-manager.js', () => ({
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    submitAnswers: vi.fn(),
    updateSession: vi.fn(),
    hasSession: vi.fn(),
    checkSessionHealth: vi.fn(),
    getSdkSessionId: vi.fn(),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { agentManager } from '../../services/core/agent-manager.js';

const app = createApp();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/sessions/:id/submit-answers', () => {
  it('returns 200 when pending question exists', async () => {
    vi.mocked(agentManager.submitAnswers).mockReturnValue(true);

    const res = await request(app)
      .post('/api/sessions/test-session/submit-answers')
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(agentManager.submitAnswers).toHaveBeenCalledWith('test-session', 'tc-1', {
      '0': 'Option A',
    });
  });

  it('returns 404 when no pending question exists', async () => {
    vi.mocked(agentManager.submitAnswers).mockReturnValue(false);

    const res = await request(app)
      .post('/api/sessions/test-session/submit-answers')
      .send({ toolCallId: 'tc-1', answers: { '0': 'Option A' } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending question');
  });

  it('returns 400 when toolCallId is missing', async () => {
    const res = await request(app)
      .post('/api/sessions/test-session/submit-answers')
      .send({ answers: { '0': 'Option A' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });

  it('returns 400 when answers is missing', async () => {
    const res = await request(app)
      .post('/api/sessions/test-session/submit-answers')
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });
});

describe('POST /api/sessions/:id/approve', () => {
  it('returns 200 when pending approval exists', async () => {
    vi.mocked(agentManager.approveTool).mockReturnValue(true);

    const res = await request(app)
      .post('/api/sessions/test-session/approve')
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(agentManager.approveTool).toHaveBeenCalledWith('test-session', 'tc-1', true);
  });

  it('returns 404 when no pending approval exists', async () => {
    vi.mocked(agentManager.approveTool).mockReturnValue(false);

    const res = await request(app)
      .post('/api/sessions/test-session/approve')
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No pending approval');
  });
});

describe('POST /api/sessions/:id/deny', () => {
  it('returns 200 when pending approval exists', async () => {
    vi.mocked(agentManager.approveTool).mockReturnValue(true);

    const res = await request(app)
      .post('/api/sessions/test-session/deny')
      .send({ toolCallId: 'tc-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(agentManager.approveTool).toHaveBeenCalledWith('test-session', 'tc-1', false);
  });
});
