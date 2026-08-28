import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/client';
import { createFeedbackIssue } from '@/lib/feedback/linear';
import { FEEDBACK_RATE_LIMIT, resetFeedbackRateLimit } from '@/lib/feedback/submit-rate-limit';
import { sendFeedbackReceipt } from '@/lib/mailer';

import { POST } from '../route';

vi.mock('@/db/client', () => ({ getDb: vi.fn() }));
vi.mock('@/lib/feedback/linear', () => ({ createFeedbackIssue: vi.fn() }));
vi.mock('@/lib/mailer', () => ({ sendFeedbackReceipt: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/auth', () => ({ resolveBaseURL: () => 'https://dorkos.ai' }));

const VALID_SUBMISSION = {
  instanceId: '00000000-0000-0000-0000-000000000000',
  kind: 'bug' as const,
  message: 'The session list flickers on refresh.',
  surface: 'cockpit' as const,
  contact: 'kai@example.com',
  reporterEmail: 'kai@example.com',
  reporterName: 'Kai',
  route: '/session',
  hasScreenshot: true,
  hasTranscript: false,
};

const INSERTED_ROW_ID = 'row-uuid-1';

interface MockDb {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

let mockReturning: ReturnType<typeof vi.fn>;
let mockValues: ReturnType<typeof vi.fn>;
let mockInsert: ReturnType<typeof vi.fn>;
let mockWhere: ReturnType<typeof vi.fn>;
let mockSet: ReturnType<typeof vi.fn>;
let mockUpdate: ReturnType<typeof vi.fn>;
let mockDb: MockDb;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockReturning = vi.fn().mockResolvedValue([{ id: INSERTED_ROW_ID }]);
  mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  mockWhere = vi.fn().mockResolvedValue(undefined);
  mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  mockUpdate = vi.fn().mockReturnValue({ set: mockSet });

  mockDb = { insert: mockInsert, update: mockUpdate };
  vi.mocked(getDb).mockReturnValue(mockDb as never);
  vi.mocked(createFeedbackIssue).mockReset();
  vi.mocked(sendFeedbackReceipt).mockClear();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  resetFeedbackRateLimit();
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.clearAllMocks();
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://dorkos.ai/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/feedback — input validation', () => {
  it('returns 400 on malformed JSON', async () => {
    const res = await POST(post('{ not json'));
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { ok: boolean; error: string };
    expect(payload).toEqual({ ok: false, error: 'Invalid JSON body' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 with issues on schema violation (missing required message)', async () => {
    const res = await POST(post({ instanceId: 'i', kind: 'bug', surface: 'cockpit' }));
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { ok: boolean; error: string; issues: unknown[] };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Invalid submission');
    expect(Array.isArray(payload.issues)).toBe(true);
    expect(payload.issues.length).toBeGreaterThan(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 on an unknown field (.strict())', async () => {
    const res = await POST(post({ ...VALID_SUBMISSION, notAllowed: 'nope' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid kind', async () => {
    const res = await POST(post({ ...VALID_SUBMISSION, kind: 'complaint' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 413 when the body exceeds the size cap', async () => {
    const res = await POST(post({ ...VALID_SUBMISSION, message: 'x'.repeat(100_000) }));
    expect(res.status).toBe(413);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/feedback — honeypot', () => {
  it('drops the submission and persists nothing when the honeypot field is filled', async () => {
    const res = await POST(post({ ...VALID_SUBMISSION, website: 'i-am-a-bot' }));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; id: string | null };
    expect(payload).toEqual({ ok: true, id: null });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(createFeedbackIssue).not.toHaveBeenCalled();
  });

  it('proceeds normally when the honeypot field is empty', async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue(null);
    const res = await POST(post({ ...VALID_SUBMISSION, website: '' }));
    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/feedback — Neon insert failure', () => {
  it('returns 500 { ok: false } and never calls Linear when the insert throws', async () => {
    mockReturning.mockRejectedValueOnce(new Error('neon timeout'));

    const res = await POST(post(VALID_SUBMISSION));

    expect(res.status).toBe(500);
    const payload = (await res.json()) as { ok: boolean; error: string };
    expect(payload).toEqual({ ok: false, error: 'Failed to record submission' });
    expect(createFeedbackIssue).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[api/feedback] insert failed',
      expect.objectContaining({ error: expect.stringContaining('neon timeout') })
    );
  });
});

describe('POST /api/feedback — Linear success', () => {
  it('inserts the exact validated row, then updates it to triaged with the Linear ids', async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue({
      issueId: 'linear-issue-uuid',
      issueUrl: 'https://linear.app/dor/issue/DOR-123',
    });

    const res = await POST(post(VALID_SUBMISSION));

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; id: string };
    expect(payload).toEqual({ ok: true, id: INSERTED_ROW_ID });

    // The specific row written — exact shape, not "a row exists".
    expect(mockValues).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledWith({
      instanceId: VALID_SUBMISSION.instanceId,
      kind: 'bug',
      message: VALID_SUBMISSION.message,
      contact: VALID_SUBMISSION.contact,
      reporterEmail: VALID_SUBMISSION.reporterEmail,
      reporterName: VALID_SUBMISSION.reporterName,
      route: VALID_SUBMISSION.route,
      surface: 'cockpit',
      hasScreenshot: true,
      hasTranscript: false,
    });

    // The Linear client received the reporter identity and message.
    expect(createFeedbackIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bug',
        message: VALID_SUBMISSION.message,
        reporterEmail: 'kai@example.com',
        reporterName: 'Kai',
        route: '/session',
      })
    );

    // The specific status transition — triaged, with the Linear ids attached.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        linearIssueId: 'linear-issue-uuid',
        linearIssueUrl: 'https://linear.app/dor/issue/DOR-123',
        status: 'triaged',
      })
    );
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/feedback — Linear failure (the core correctness claim)', () => {
  it('still responds { ok: true, id } and leaves the row received when Linear throws', async () => {
    vi.mocked(createFeedbackIssue).mockRejectedValue(new Error('Linear API error: 500'));

    const res = await POST(post(VALID_SUBMISSION));

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; id: string };
    expect(payload).toEqual({ ok: true, id: INSERTED_ROW_ID });

    // The row was durably inserted with the exact validated fields, status
    // defaulting to 'received' (no explicit status in the insert values —
    // the schema default carries it).
    expect(mockValues).toHaveBeenCalledTimes(1);
    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).not.toHaveProperty('status');
    expect(inserted).not.toHaveProperty('linearIssueId');
    expect(inserted).toMatchObject({
      instanceId: VALID_SUBMISSION.instanceId,
      kind: 'bug',
      message: VALID_SUBMISSION.message,
    });

    // No update was ever attempted — the row is left exactly as inserted.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[api/feedback] Linear create failed (row stays received)',
      expect.objectContaining({
        id: INSERTED_ROW_ID,
        error: expect.stringContaining('Linear API error: 500'),
      })
    );
  });

  it('still responds { ok: true, id } and leaves the row received when Linear resolves null (unconfigured)', async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue(null);

    const res = await POST(post(VALID_SUBMISSION));

    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; id: string };
    expect(payload).toEqual({ ok: true, id: INSERTED_ROW_ID });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/feedback — receipt email (the core correctness claim)', () => {
  it('fires the receipt email with the tracking URL when reporterEmail is present', async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue(null);
    const res = await POST(post(VALID_SUBMISSION));
    expect(res.status).toBe(200);

    expect(sendFeedbackReceipt).toHaveBeenCalledTimes(1);
    expect(sendFeedbackReceipt).toHaveBeenCalledWith(
      'kai@example.com',
      `https://dorkos.ai/feedback/${INSERTED_ROW_ID}`
    );
  });

  it('fires the receipt email using an email-shaped contact when reporterEmail is absent', async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue(null);
    const withoutReporterEmail = { ...VALID_SUBMISSION, reporterEmail: undefined };
    await POST(post(withoutReporterEmail));
    expect(sendFeedbackReceipt).toHaveBeenCalledTimes(1);
    expect(sendFeedbackReceipt).toHaveBeenCalledWith(
      'kai@example.com',
      expect.stringContaining('/feedback/')
    );
  });

  it('does NOT fire the receipt email when no email or email-shaped contact is present', async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue(null);
    const bare = {
      ...VALID_SUBMISSION,
      reporterEmail: undefined,
      contact: '@kai_on_discord',
    };
    await POST(post(bare));
    expect(sendFeedbackReceipt).not.toHaveBeenCalled();
  });

  it('does NOT fire the receipt email when the insert fails', async () => {
    mockReturning.mockRejectedValueOnce(new Error('neon timeout'));
    await POST(post(VALID_SUBMISSION));
    expect(sendFeedbackReceipt).not.toHaveBeenCalled();
  });

  it('fires the receipt email before attempting the Linear mirror', async () => {
    const callOrder: string[] = [];
    vi.mocked(sendFeedbackReceipt).mockImplementationOnce(async () => {
      callOrder.push('receipt');
    });
    vi.mocked(createFeedbackIssue).mockImplementationOnce(async () => {
      callOrder.push('linear');
      return null;
    });
    await POST(post(VALID_SUBMISSION));
    expect(callOrder).toEqual(['receipt', 'linear']);
  });
});

describe('POST /api/feedback — rate limiting', () => {
  const ip = { 'x-real-ip': '203.0.113.40' };

  it('lets one IP through up to the limit, then answers 429', async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue(null);
    for (let i = 0; i < FEEDBACK_RATE_LIMIT; i += 1) {
      expect((await POST(post(VALID_SUBMISSION, ip))).status).toBe(200);
    }
    expect(mockInsert).toHaveBeenCalledTimes(FEEDBACK_RATE_LIMIT);

    const blocked = await POST(post(VALID_SUBMISSION, ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('600');
    await expect(blocked.json()).resolves.toEqual({
      ok: false,
      error: 'Too many requests. Retry after the number of seconds in the Retry-After header.',
    });
    // Nothing was persisted, mailed, or filed for the throttled request.
    expect(mockInsert).toHaveBeenCalledTimes(FEEDBACK_RATE_LIMIT);
    expect(sendFeedbackReceipt).toHaveBeenCalledTimes(FEEDBACK_RATE_LIMIT);
    expect(createFeedbackIssue).toHaveBeenCalledTimes(FEEDBACK_RATE_LIMIT);
  });

  it("does not charge one IP for another IP's submissions", async () => {
    vi.mocked(createFeedbackIssue).mockResolvedValue(null);
    for (let i = 0; i <= FEEDBACK_RATE_LIMIT; i += 1) await POST(post(VALID_SUBMISSION, ip));
    expect((await POST(post(VALID_SUBMISSION, ip))).status).toBe(429);

    const bystander = await POST(post(VALID_SUBMISSION, { 'x-real-ip': '203.0.113.41' }));
    expect(bystander.status).toBe(200);
  });

  it('charges rejected payloads too, so a garbage flood still gets throttled', async () => {
    for (let i = 0; i < FEEDBACK_RATE_LIMIT; i += 1) {
      expect((await POST(post({ kind: 'nope' }, ip))).status).toBe(400);
    }
    expect((await POST(post(VALID_SUBMISSION, ip))).status).toBe(429);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('charges an oversized body before it is read, so a 413 flood is throttled too', async () => {
    // Charged ahead of the content-length check, so the route never buffers
    // a flood of oversized bodies just to reject them one at a time.
    const oversized = { ...ip, 'content-length': '999999' };
    for (let i = 0; i < FEEDBACK_RATE_LIMIT; i += 1) {
      expect((await POST(post(VALID_SUBMISSION, oversized))).status).toBe(413);
    }
    expect((await POST(post(VALID_SUBMISSION, ip))).status).toBe(429);
  });
});
