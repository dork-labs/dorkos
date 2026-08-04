/**
 * @vitest-environment node
 */
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/client';
import { sendFeedbackShipped } from '@/lib/mailer';

vi.mock('@/db/client', () => ({ getDb: vi.fn() }));
vi.mock('@/lib/mailer', () => ({ sendFeedbackShipped: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/env', () => ({ env: { LINEAR_WEBHOOK_SECRET: 'test_webhook_secret' } }));

import { POST } from '../route';

const SECRET = 'test_webhook_secret';
const ROW_ID = 'row-uuid-1';
const LINEAR_ISSUE_ID = 'linear-issue-uuid';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

let mockLimit: ReturnType<typeof vi.fn>;
let mockWhereSelect: ReturnType<typeof vi.fn>;
let mockFrom: ReturnType<typeof vi.fn>;
let mockSelect: ReturnType<typeof vi.fn>;
let mockWhereUpdate: ReturnType<typeof vi.fn>;
let mockSet: ReturnType<typeof vi.fn>;
let mockUpdate: ReturnType<typeof vi.fn>;
let mockDb: MockDb;
let foundRow: Record<string, unknown> | undefined;

beforeEach(() => {
  foundRow = {
    id: ROW_ID,
    linearIssueId: LINEAR_ISSUE_ID,
    message: 'Chat stopped updating after the stream dropped.',
    reporterEmail: null,
    contact: null,
    shippedVersion: null,
    status: 'triaged',
  };

  mockLimit = vi.fn().mockImplementation(() => Promise.resolve(foundRow ? [foundRow] : []));
  mockWhereSelect = vi.fn().mockReturnValue({ limit: mockLimit });
  mockFrom = vi.fn().mockReturnValue({ where: mockWhereSelect });
  mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  mockWhereUpdate = vi.fn().mockResolvedValue(undefined);
  mockSet = vi.fn().mockReturnValue({ where: mockWhereUpdate });
  mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  mockDb = { select: mockSelect, update: mockUpdate };
  vi.mocked(getDb).mockReturnValue(mockDb as never);
  vi.mocked(sendFeedbackShipped).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Sign a body exactly as Linear does: HMAC-SHA256 hex over the raw bytes. */
function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function webhookRequest(
  body: unknown,
  opts?: { signature?: string | null; raw?: string }
): Request {
  const raw = opts?.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const signature = opts?.signature === undefined ? sign(raw) : opts.signature;
  if (signature !== null) headers['linear-signature'] = signature;
  return new Request('https://dorkos.ai/api/webhooks/linear', {
    method: 'POST',
    headers,
    body: raw,
  });
}

const ISSUE_UPDATE_SHIPPED = {
  action: 'update',
  type: 'Issue',
  data: {
    id: LINEAR_ISSUE_ID,
    state: { name: 'Done', type: 'completed' },
    projectMilestone: { name: '0.56.3' },
  },
};

describe('POST /api/webhooks/linear — signature verification', () => {
  it('rejects a request with no signature header (401)', async () => {
    const res = await POST(webhookRequest(ISSUE_UPDATE_SHIPPED, { signature: null }));
    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('rejects a request with a wrong signature (401)', async () => {
    const res = await POST(webhookRequest(ISSUE_UPDATE_SHIPPED, { signature: 'a'.repeat(64) }));
    expect(res.status).toBe(401);
    const payload = (await res.json()) as { ok: boolean; error: string };
    expect(payload).toEqual({ ok: false, error: 'Invalid signature' });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const raw = JSON.stringify(ISSUE_UPDATE_SHIPPED);
    const res = await POST(
      webhookRequest(ISSUE_UPDATE_SHIPPED, { raw, signature: sign(raw, 'wrong-secret') })
    );
    expect(res.status).toBe(401);
  });

  it('accepts a request with a correctly-signed body', async () => {
    const res = await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/webhooks/linear — status mapping', () => {
  it('maps a completed state to shipped and writes the row', async () => {
    const res = await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(res.status).toBe(200);

    expect(mockWhereSelect).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'shipped', shippedVersion: '0.56.3' })
    );
    expect(mockWhereUpdate).toHaveBeenCalledTimes(1);
  });

  it('maps a started state to in_progress with no shippedVersion write', async () => {
    const body = {
      action: 'update',
      type: 'Issue',
      data: { id: LINEAR_ISSUE_ID, state: { name: 'In Progress', type: 'started' } },
    };
    await POST(webhookRequest(body));

    expect(mockSet).toHaveBeenCalledWith(
      expect.not.objectContaining({ shippedVersion: expect.anything() })
    );
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_progress' }));
  });

  it('ignores a non-Issue event without touching the database', async () => {
    const body = { action: 'update', type: 'Comment', data: { id: LINEAR_ISSUE_ID } };
    const res = await POST(webhookRequest(body));
    expect(res.status).toBe(200);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('ignores a non-update action (e.g. create) without touching the database', async () => {
    const body = { ...ISSUE_UPDATE_SHIPPED, action: 'create' };
    const res = await POST(webhookRequest(body));
    expect(res.status).toBe(200);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('accepts but no-ops when the issue id matches no feedback row', async () => {
    foundRow = undefined;
    const res = await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('accepts but no-ops when the state has no mapping', async () => {
    const body = {
      action: 'update',
      type: 'Issue',
      data: { id: LINEAR_ISSUE_ID, state: { name: 'Some Custom State', type: 'future-type' } },
    };
    const res = await POST(webhookRequest(body));
    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/linear — shipped email (the core correctness claim)', () => {
  it('fires the shipped email when mapped to shipped and the row has a reporterEmail', async () => {
    foundRow = { ...foundRow, reporterEmail: 'kai@example.com' };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));

    expect(sendFeedbackShipped).toHaveBeenCalledTimes(1);
    expect(sendFeedbackShipped).toHaveBeenCalledWith('kai@example.com', {
      message: 'Chat stopped updating after the stream dropped.',
      shippedVersion: '0.56.3',
    });
  });

  it('fires the shipped email using an email-shaped contact when reporterEmail is absent', async () => {
    foundRow = { ...foundRow, contact: 'kai@example.com' };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(sendFeedbackShipped).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the shipped email when the row has no email at all', async () => {
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(sendFeedbackShipped).not.toHaveBeenCalled();
  });

  it('does NOT fire the shipped email when a non-email contact is present', async () => {
    foundRow = { ...foundRow, contact: '@kai_on_discord' };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(sendFeedbackShipped).not.toHaveBeenCalled();
  });

  it('does NOT fire the shipped email for a non-shipped status transition, even with an email on file', async () => {
    foundRow = { ...foundRow, reporterEmail: 'kai@example.com' };
    const body = {
      action: 'update',
      type: 'Issue',
      data: { id: LINEAR_ISSUE_ID, state: { name: 'In Progress', type: 'started' } },
    };
    await POST(webhookRequest(body));
    expect(sendFeedbackShipped).not.toHaveBeenCalled();
  });

  it('does NOT re-fire the shipped email for a later update on an issue that is already shipped (Linear sends an Issue update webhook for every field change)', async () => {
    // The row was already marked shipped by an earlier delivery — this
    // delivery is some unrelated later edit (label, assignee, description...)
    // that still resolves to the same completed/shipped state. Pins the
    // transition guard: `status === 'shipped'` alone is not enough, the prior
    // row status must NOT already be 'shipped'.
    foundRow = {
      ...foundRow,
      reporterEmail: 'kai@example.com',
      status: 'shipped',
      shippedVersion: '0.56.3',
    };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(sendFeedbackShipped).not.toHaveBeenCalled();
    // The row is still (harmlessly) re-written with the same status/version —
    // only the email send is gated, not the status write.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/webhooks/linear — unset signing secret (fail closed)', () => {
  it('rejects every delivery with 401 and never reads or writes the database when LINEAR_WEBHOOK_SECRET is unset', async () => {
    vi.resetModules();
    vi.doMock('@/env', () => ({ env: {} }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { POST: postWithoutSecret } = await import('../route');
    const res = await postWithoutSecret(webhookRequest(ISSUE_UPDATE_SHIPPED));

    expect(res.status).toBe(401);
    const payload = (await res.json()) as { ok: boolean; error: string };
    expect(payload).toEqual({ ok: false, error: 'Webhook not configured' });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(sendFeedbackShipped).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    vi.doUnmock('@/env');
  });
});
