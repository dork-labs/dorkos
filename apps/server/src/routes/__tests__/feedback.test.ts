/**
 * Tests for the feedback route (DOR-317, ADR 260713-143958 Phase 5).
 *
 * The route is thin over {@link sendFeedback}, so this proves wiring + response
 * shapes: valid submissions relay the forwarder's honest `{ ok }`, and invalid
 * bodies are rejected with 400. The forwarder itself is covered by
 * feedback-reporter.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../services/core/feedback-reporter.js', () => ({
  sendFeedback: vi.fn(),
}));
vi.mock('../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dork-test'),
}));
vi.mock('../../lib/version.js', () => ({
  SERVER_VERSION: '0.47.0',
  IS_DEV_BUILD: false,
}));

import { sendFeedback } from '../../services/core/feedback-reporter.js';
import feedbackRouter from '../feedback.js';

const mockSend = vi.mocked(sendFeedback);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/feedback', feedbackRouter);
  return app;
}

describe('feedback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards a valid submission and relays ok:true', async () => {
    mockSend.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .post('/api/feedback')
      .send({ kind: 'bug', message: 'it broke', contact: 'a@b.com', route: '/agents' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      submission: { kind: 'bug', message: 'it broke', contact: 'a@b.com', route: '/agents' },
      dorkosVersion: '0.47.0',
    });
  });

  it('relays ok:false when the forwarder could not deliver (still 200, honest)', async () => {
    mockSend.mockResolvedValue({ ok: false });
    const res = await request(buildApp())
      .post('/api/feedback')
      .send({ kind: 'feedback', message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });

  it('accepts the idea kind', async () => {
    mockSend.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .post('/api/feedback')
      .send({ kind: 'idea', message: 'add dark mode' });
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty message with 400 and never calls the forwarder', async () => {
    const res = await request(buildApp()).post('/api/feedback').send({ kind: 'bug', message: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FEEDBACK');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind with 400', async () => {
    const res = await request(buildApp())
      .post('/api/feedback')
      .send({ kind: 'praise', message: 'nice' });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects unknown body keys (strict) with 400', async () => {
    const res = await request(buildApp())
      .post('/api/feedback')
      .send({ kind: 'bug', message: 'hi', surface: 'cockpit', distinctId: 'x' });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
