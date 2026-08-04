/**
 * Tests for the feedback route (DOR-317, ADR 260713-143958 Phase 5; identity +
 * diagnostics plumbing per feedback-pipeline spec Parts 1-2, ADR 260803-205037).
 *
 * The route is thin over {@link sendFeedback}, so this proves wiring + response
 * shapes: valid submissions relay the forwarder's honest `{ ok }`, invalid
 * bodies are rejected with 400, identity is resolved from the verified session
 * ONLY (never the request body), and a server log excerpt is gathered only
 * under the documented conditions. The forwarder itself is covered by
 * feedback-reporter.test.ts; the excerpt's own scrubbing/bounding is covered by
 * log-excerpt.test.ts — this file proves the ROUTE wires them correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

vi.mock('../../services/core/feedback-reporter.js', () => ({
  sendFeedback: vi.fn(),
  resolveFeedbackIdentity: vi.fn(),
  listMyFeedback: vi.fn(),
}));
vi.mock('../../lib/log-excerpt.js', () => ({
  getRecentLogExcerpt: vi.fn(),
}));
vi.mock('../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dork-test'),
}));
vi.mock('../../lib/version.js', () => ({
  SERVER_VERSION: '0.47.0',
  IS_DEV_BUILD: false,
}));

import {
  sendFeedback,
  resolveFeedbackIdentity,
  listMyFeedback,
} from '../../services/core/feedback-reporter.js';
import { getRecentLogExcerpt } from '../../lib/log-excerpt.js';
import feedbackRouter from '../feedback.js';

const mockSend = vi.mocked(sendFeedback);
const mockResolveIdentity = vi.mocked(resolveFeedbackIdentity);
const mockGetLogExcerpt = vi.mocked(getRecentLogExcerpt);
const mockListMyFeedback = vi.mocked(listMyFeedback);

/**
 * Build the test app. `sessionUser`, when passed, simulates what `sessionGate`
 * would have attached to `res.locals.user` for an authenticated request — the
 * route never reads identity from anywhere else.
 */
function buildApp(sessionUser?: { userId: string; credential: 'cookie' | 'api-key' }) {
  const app = express();
  app.use(express.json());
  if (sessionUser) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.locals.user = sessionUser;
      next();
    });
  }
  app.use('/api/feedback', feedbackRouter);
  return app;
}

describe('feedback route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveIdentity.mockResolvedValue(undefined);
    mockGetLogExcerpt.mockResolvedValue(undefined);
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

  describe('identity — resolved from the verified session only (ADR 260803-205037)', () => {
    it('rejects a client-supplied reporterEmail with 400 — the field does not exist on the submission', async () => {
      // The security boundary is structural: reporterEmail/reporterName have no
      // slot on FeedbackSubmissionSchema at all, so a client that tries to spoof
      // one is rejected outright by the strict allowlist, never silently ignored
      // and never reaching resolveFeedbackIdentity/sendFeedback.
      const res = await request(buildApp({ userId: 'user_1', credential: 'cookie' }))
        .post('/api/feedback')
        .send({ kind: 'bug', message: 'hi', reporterEmail: 'attacker@evil.test' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_FEEDBACK');
      expect(mockResolveIdentity).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves identity from res.locals.user and forwards it to sendFeedback', async () => {
      mockSend.mockResolvedValue({ ok: true });
      mockResolveIdentity.mockResolvedValue({
        userId: 'user_1',
        email: 'dorian@example.com',
        name: 'Dorian',
      });

      const res = await request(buildApp({ userId: 'user_1', credential: 'cookie' }))
        .post('/api/feedback')
        .send({ kind: 'bug', message: 'hi' });

      expect(res.status).toBe(200);
      expect(mockResolveIdentity).toHaveBeenCalledWith('user_1');
      expect(mockSend.mock.calls[0][0]).toMatchObject({
        identity: { userId: 'user_1', email: 'dorian@example.com', name: 'Dorian' },
      });
    });

    it('never resolves or forwards identity when there is no session (auth off / anonymous)', async () => {
      mockSend.mockResolvedValue({ ok: true });

      const res = await request(buildApp())
        .post('/api/feedback')
        .send({ kind: 'bug', message: 'hi' });

      expect(res.status).toBe(200);
      expect(mockResolveIdentity).not.toHaveBeenCalled();
      expect(mockSend.mock.calls[0][0]).toMatchObject({ identity: undefined });
    });
  });

  describe('server log excerpt (feedback-pipeline spec Part 2)', () => {
    it('gathers and attaches a log excerpt for a bug report that asked for one', async () => {
      mockSend.mockResolvedValue({ ok: true });
      mockGetLogExcerpt.mockResolvedValue('warn: something scrubbed');

      const res = await request(buildApp())
        .post('/api/feedback')
        .send({
          kind: 'bug',
          message: 'it crashed',
          includeServerLogs: true,
          diagnostics: {
            clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
          },
        });

      expect(res.status).toBe(200);
      expect(mockGetLogExcerpt).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0]).toMatchObject({
        submission: {
          diagnostics: {
            clientReport: { version: '0.47.0' },
            serverLogExcerpt: 'warn: something scrubbed',
          },
        },
      });
    });

    it('does NOT gather a log excerpt when includeServerLogs is not set', async () => {
      mockSend.mockResolvedValue({ ok: true });
      await request(buildApp())
        .post('/api/feedback')
        .send({
          kind: 'bug',
          message: 'it crashed',
          diagnostics: {
            clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
          },
        });
      expect(mockGetLogExcerpt).not.toHaveBeenCalled();
    });

    it('does NOT gather a log excerpt for a non-bug kind, even with includeServerLogs set', async () => {
      mockSend.mockResolvedValue({ ok: true });
      await request(buildApp()).post('/api/feedback').send({
        kind: 'feedback',
        message: 'nice work',
        includeServerLogs: true,
      });
      expect(mockGetLogExcerpt).not.toHaveBeenCalled();
    });

    it('does NOT gather a log excerpt when the submission carries no diagnostics', async () => {
      mockSend.mockResolvedValue({ ok: true });
      await request(buildApp()).post('/api/feedback').send({
        kind: 'bug',
        message: 'it crashed',
        includeServerLogs: true,
      });
      expect(mockGetLogExcerpt).not.toHaveBeenCalled();
    });

    it('never reads the log file for an invalid submission (validation runs first)', async () => {
      const res = await request(buildApp())
        .post('/api/feedback')
        .send({ kind: 'bug', message: '', includeServerLogs: true });
      expect(res.status).toBe(400);
      expect(mockGetLogExcerpt).not.toHaveBeenCalled();
    });

    it('leaves the submission unchanged when no excerpt was found', async () => {
      mockSend.mockResolvedValue({ ok: true });
      mockGetLogExcerpt.mockResolvedValue(undefined);

      await request(buildApp())
        .post('/api/feedback')
        .send({
          kind: 'bug',
          message: 'it crashed',
          includeServerLogs: true,
          diagnostics: {
            clientReport: { version: '0.47.0', platform: 'darwin-arm64', runtimes: [], flags: {} },
          },
        });

      const submitted = mockSend.mock.calls[0][0] as {
        submission: { diagnostics?: { serverLogExcerpt?: string } };
      };
      expect(submitted.submission.diagnostics?.serverLogExcerpt).toBeUndefined();
    });
  });

  describe('GET /api/feedback/mine (feedback-pipeline Part 4)', () => {
    it('returns the items resolved by listMyFeedback', async () => {
      const items = [
        {
          id: 'row-1',
          kind: 'bug' as const,
          message: 'it broke',
          status: 'in_progress' as const,
          createdAt: '2026-08-01T00:00:00.000Z',
          hasScreenshot: false,
          hasTranscript: false,
        },
      ];
      mockListMyFeedback.mockResolvedValue(items);

      const res = await request(buildApp()).get('/api/feedback/mine');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(items);
      expect(mockListMyFeedback).toHaveBeenCalledWith({ dorkHome: '/tmp/dork-test' });
    });

    it('returns 502 when listMyFeedback throws (site unreachable or non-OK)', async () => {
      mockListMyFeedback.mockRejectedValue(new Error('Feedback tracking read failed: HTTP 500'));

      const res = await request(buildApp()).get('/api/feedback/mine');

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Could not reach the feedback service' });
    });
  });
});
