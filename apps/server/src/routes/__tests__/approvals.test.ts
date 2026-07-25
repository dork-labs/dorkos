/**
 * Tests for the approvals routes (spec `agent-trust` §3.3) — the cockpit lists
 * what is waiting and records the operator's decision.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService, APPROVAL_TTL_MS } from '../../services/core/approvals/index.js';
import { hashApprovalInput } from '../../services/core/approvals/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { createApprovalsRouter } from '../approvals.js';

/** The action every test in this file asks approval for. */
const BINDING = {
  capabilityId: 'marketplace.uninstall',
  inputHash: hashApprovalInput({ name: 'sentry-monitor' }),
};

describe('approvals routes', () => {
  let approvals: ApprovalService;
  let app: express.Express;

  beforeEach(() => {
    approvals = new ApprovalService(createTestDb());
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    app = express();
    app.use(express.json());
    app.use('/api/approvals', createApprovalsRouter(approvals));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Ask for approval of the standard action. */
  function requestOne() {
    return approvals.request({
      ...BINDING,
      summary: 'Uninstall "sentry-monitor"',
      requestedBy: 'dorkbot',
      capabilityTitle: 'Uninstall a marketplace package',
    });
  }

  describe('GET /pending', () => {
    it('returns an empty list when nothing is waiting', async () => {
      const res = await request(app).get('/api/approvals/pending');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ approvals: [] });
    });

    it('returns the card payload and never the token', async () => {
      const ticket = requestOne();

      const res = await request(app).get('/api/approvals/pending');
      expect(res.status).toBe(200);
      expect(res.body.approvals).toHaveLength(1);
      expect(res.body.approvals[0]).toMatchObject({
        approvalId: ticket.approvalId,
        capabilityId: 'marketplace.uninstall',
        capabilityTitle: 'Uninstall a marketplace package',
        tier: 'destructive',
        summary: 'Uninstall "sentry-monitor"',
        requestedBy: 'dorkbot',
      });
      expect(res.text).not.toContain(ticket.token);
    });
  });

  describe('POST /:id/grant', () => {
    it('grants a pending approval so its token can be spent once', async () => {
      const ticket = requestOne();

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, approvalId: ticket.approvalId, outcome: 'granted' });
      expect(approvals.consume(ticket.token, BINDING).outcome).toBe('granted');
    });

    it('404s an approval that does not exist', async () => {
      const res = await request(app).post('/api/approvals/01JZZZZZZZZZZZZZZZZZZZZZZZ/grant').send();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNKNOWN_APPROVAL');
    });

    it('409s a second decision', async () => {
      const ticket = requestOne();
      await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('APPROVAL_NOT_PENDING');
    });

    it('410s an approval whose window closed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
      const ticket = requestOne();
      vi.setSystemTime(new Date(Date.now() + APPROVAL_TTL_MS + 1));

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/grant`).send();
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('APPROVAL_EXPIRED');
    });
  });

  describe('POST /:id/deny', () => {
    it('denies with a reason the requester sees', async () => {
      const ticket = requestOne();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/deny`)
        .send({ reason: 'not today' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, approvalId: ticket.approvalId, outcome: 'denied' });
      expect(approvals.consume(ticket.token, BINDING)).toEqual({
        outcome: 'denied',
        approvalId: ticket.approvalId,
        reason: 'not today',
      });
    });

    it('accepts a bare denial with no body at all (Express 5 leaves it undefined)', async () => {
      const ticket = requestOne();

      const res = await request(app).post(`/api/approvals/${ticket.approvalId}/deny`);
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('denied');
    });

    it('400s a reason that is not a string', async () => {
      const ticket = requestOne();

      const res = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/deny`)
        .send({ reason: 42 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_DENY_BODY');
      expect(res.body.details).toBeTruthy();
    });

    it('404s an approval that does not exist', async () => {
      const res = await request(app).post('/api/approvals/01JZZZZZZZZZZZZZZZZZZZZZZZ/deny').send();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNKNOWN_APPROVAL');
    });
  });

  it('removes an approval from the pending list once it is decided', async () => {
    const ticket = requestOne();
    await request(app).post(`/api/approvals/${ticket.approvalId}/deny`).send();

    const res = await request(app).get('/api/approvals/pending');
    expect(res.body.approvals).toEqual([]);
  });
});
