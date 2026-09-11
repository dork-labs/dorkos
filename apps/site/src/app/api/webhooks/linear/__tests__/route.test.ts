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
/**
 * The release-notes link every shipped email carries. A fixed public URL, not
 * one derived from the request origin — pinned here so a change to
 * origin-derivation cannot silently start mailing preview or localhost links.
 */
const CHANGELOG_URL = 'https://dorkos.ai/docs/changelog';

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
/**
 * The status the *database* holds, when a test needs it to differ from the
 * snapshot a delivery read (`foundRow.status`). That divergence is the
 * concurrent-delivery race: two deliveries each read a stale `triaged` while
 * the row is already `shipped`. Left undefined, the database simply agrees
 * with the snapshot.
 */
let persistedStatus: string | undefined;

/**
 * Literal values bound into a Drizzle condition, read out of its query
 * chunks.
 *
 * This lets the update mock below tell a claim (`id = ? AND status <>
 * 'shipped'`) from a bare id match, so it can honour the predicate it was
 * actually given instead of faking a result by call order. That is what
 * makes dropping the `ne()` from production a genuine red rather than a
 * mutation the mock cheerfully absorbs.
 */
function literalParams(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { value?: unknown; queryChunks?: unknown[] };
  if ('value' in n && (typeof n.value === 'string' || typeof n.value === 'number')) {
    out.push(n.value);
  }
  if (Array.isArray(n.queryChunks)) for (const chunk of n.queryChunks) literalParams(chunk, out);
  return out;
}

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
  persistedStatus = undefined;

  mockLimit = vi.fn().mockImplementation(() => Promise.resolve(foundRow ? [foundRow] : []));
  mockWhereSelect = vi.fn().mockReturnValue({ limit: mockLimit });
  mockFrom = vi.fn().mockReturnValue({ where: mockWhereSelect });
  mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  // A small honest stand-in for the row: `.returning()` reports the rows the
  // UPDATE would have matched, so a guarded UPDATE against an already-shipped
  // row reports none.
  let pendingStatus: string | undefined;
  mockWhereUpdate = vi.fn().mockImplementation((condition: unknown) => ({
    returning: vi.fn().mockImplementation(() => {
      const isClaim = literalParams(condition).includes('shipped');
      const dbStatus = persistedStatus ?? (foundRow?.status as string | undefined);
      if (isClaim && dbStatus === 'shipped') return Promise.resolve([]);
      if (pendingStatus) persistedStatus = pendingStatus;
      return Promise.resolve([{ id: ROW_ID }]);
    }),
  }));
  mockSet = vi.fn().mockImplementation((values: { status?: string }) => {
    pendingStatus = values.status;
    return { where: mockWhereUpdate };
  });
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

/**
 * What a real feedback-team delivery actually looks like: no
 * `projectMilestone`, no `cycle`, so `resolveShippedVersion` resolves
 * `undefined`. The FB team has no projects and cycles are disabled, so this
 * — not the milestone-bearing fixture above — is the shape every production
 * shipped transition arrives in.
 */
const ISSUE_UPDATE_SHIPPED_NO_VERSION = {
  action: 'update',
  type: 'Issue',
  data: {
    id: LINEAR_ISSUE_ID,
    state: { name: 'Done', type: 'completed' },
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
      changelogUrl: CHANGELOG_URL,
    });
  });

  it('does NOT require a version to fire the shipped email', async () => {
    // The bug this test exists for: the send used to be gated on
    // `if (to && version)`, and no feedback issue can ever carry a version
    // (the FB team has no projects and cycles are off). Moving a report to
    // Done flipped its public status to "shipped" and emailed nobody.
    // Re-tighten the gate to `if (to && version)` and this reds.
    foundRow = { ...foundRow, reporterEmail: 'kai@example.com', shippedVersion: null };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED_NO_VERSION));

    expect(sendFeedbackShipped).toHaveBeenCalledTimes(1);
    expect(sendFeedbackShipped).toHaveBeenCalledWith('kai@example.com', {
      message: 'Chat stopped updating after the stream dropped.',
      shippedVersion: undefined,
      changelogUrl: CHANGELOG_URL,
    });
  });

  it('passes the release-notes link on every shipped email', async () => {
    foundRow = { ...foundRow, reporterEmail: 'kai@example.com' };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED_NO_VERSION));

    expect(sendFeedbackShipped).toHaveBeenCalledWith(
      'kai@example.com',
      expect.objectContaining({ changelogUrl: CHANGELOG_URL })
    );
  });

  it('fires the shipped email using an email-shaped contact when reporterEmail is absent', async () => {
    // Deliberately the versionless delivery shape, so the production-shaped
    // payload is exercised here too rather than only in the test above.
    foundRow = { ...foundRow, contact: 'kai@example.com' };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED_NO_VERSION));
    expect(sendFeedbackShipped).toHaveBeenCalledTimes(1);
    expect(sendFeedbackShipped).toHaveBeenCalledWith(
      'kai@example.com',
      expect.objectContaining({ shippedVersion: undefined })
    );
  });

  it('still prefers a version already on the row when this delivery carries none', async () => {
    // An earlier delivery filled in shippedVersion; this one has no
    // milestone. The row's value must still reach the email.
    foundRow = {
      ...foundRow,
      reporterEmail: 'kai@example.com',
      shippedVersion: '0.56.3',
      status: 'in_progress',
    };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED_NO_VERSION));

    expect(sendFeedbackShipped).toHaveBeenCalledWith(
      'kai@example.com',
      expect.objectContaining({ shippedVersion: '0.56.3' })
    );
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
    // that still resolves to the same completed/shipped state.
    foundRow = {
      ...foundRow,
      reporterEmail: 'kai@example.com',
      status: 'shipped',
      shippedVersion: '0.56.3',
    };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED));
    expect(sendFeedbackShipped).not.toHaveBeenCalled();

    // The UPDATE still runs — it is the claim — but it is issued with the
    // `status <> 'shipped'` guard, so it matches nothing and reports no rows.
    // That empty result, not the snapshot comparison it replaced, is what
    // withholds the email.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(literalParams(mockWhereUpdate.mock.calls[0][0])).toContain('shipped');
  });

  it('sends exactly one email when two concurrent deliveries both read a stale row', async () => {
    // The real shape of the race. Linear fires several `update` deliveries
    // for one state change and Vercel runs them concurrently, so both read
    // the pre-transition snapshot. Only the database can break the tie:
    // whichever guarded UPDATE lands first claims the row, the other matches
    // nothing. `foundRow.status` deliberately stays `triaged` for BOTH
    // deliveries — that is the stale read.
    foundRow = { ...foundRow, reporterEmail: 'kai@example.com' };

    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED_NO_VERSION));
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED_NO_VERSION));

    expect(foundRow.status).toBe('triaged');
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(sendFeedbackShipped).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire on a versionless redelivery of an already-shipped issue', async () => {
    // The shape every real redelivery takes: no milestone, no cycle, and the
    // row already shipped. Covered separately from the milestone-bearing
    // fixture above so the production payload shape is exercised here too.
    foundRow = {
      ...foundRow,
      reporterEmail: 'kai@example.com',
      status: 'shipped',
      shippedVersion: null,
    };
    await POST(webhookRequest(ISSUE_UPDATE_SHIPPED_NO_VERSION));
    expect(sendFeedbackShipped).not.toHaveBeenCalled();
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
