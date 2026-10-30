/**
 * DOR-3427: on Full, the Needs-you row for a package DorkOS did not install is
 * quiet. It never escalates (no phone push, no chat message), it never runs out
 * (so it never comes back), and its words say what it is. Below Full an
 * ordinary approval still escalates.
 *
 * Drives the real `ApprovalService` on a test database, the real notification
 * registry, and a recording stand-in for the escalation service.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const config: {
  harness: { autoSync: boolean; approvedHooks: string[]; refusedHooks: string[] };
  permissions: { preset: string | null };
} = {
  harness: { autoSync: true, approvedHooks: [], refusedHooks: [] },
  permissions: { preset: 'full' },
};
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (config as Record<string, unknown>)[key],
    set: (key: string, value: unknown) => {
      (config as Record<string, unknown>)[key] = value;
    },
  },
}));

import { ApprovalService, hashApprovalInput } from '../../core/approvals/index.js';
import { PASSIVE_APPROVAL_EXPIRES_AT } from '../../core/approvals/passive-approval.js';
import { raisePassiveHookRows } from '../ask-withheld-hooks.js';
import {
  _internal as approvalInternal,
  describeHookProjectionCapability,
  HOOK_PROJECTION_CAPABILITY_ID,
} from '../hook-approval.js';
import {
  setEscalationService,
  type EscalationService,
} from '../../notifications/escalation-service.js';
import { notificationEntry, resolvePerKind } from '../../notifications/notification-registry.js';
import { capabilityApprovalPayload } from '../../notifications/emitters/capability-approval.js';
import type { WithheldHooks } from '../project-with-consent.js';

/** One package Full held back because DorkOS did not install it. */
const HELD_BACK: WithheldHooks = {
  reason: 'unasked',
  notInstalledByDorkos: true,
  request: {
    projectPath: '/repo',
    packageName: 'evil',
    hooks: [{ event: 'Stop', command: 'echo evil' }],
  },
};

let approvals: ApprovalService;
const arm = vi.fn();
const SHIPPED_POLL_MS = approvalInternal.pollIntervalMs;
const SHIPPED_SLEEP = approvalInternal.sleep;

/** Raise the passive row the way a sync does. */
function sync(): string[] {
  return raisePassiveHookRows([HELD_BACK], {
    projectPath: '/repo',
    approvals,
    reproject: () => undefined,
  });
}

/** Let the row's asking reach its first poll. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
  config.permissions = { preset: 'full' };
  // A one-second window, so "an expiry window" passes inside a test.
  approvals = new ApprovalService(createTestDb(), {
    ttlMs: 1_000,
    describeCapability: describeHookProjectionCapability,
  });
  arm.mockReset();
  setEscalationService({ arm, stop: vi.fn() } as unknown as EscalationService);
  approvalInternal.pollIntervalMs = 10;
  approvalInternal.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
});

afterEach(async () => {
  // End every wait: a no stops the poll. Let each poll hear it before the next
  // test resets the config it would write that no into.
  for (const pending of approvals.listPending()) approvals.deny(pending.approvalId);
  await settle();
  approvalInternal.forgetDecisions();
  approvalInternal.pollIntervalMs = SHIPPED_POLL_MS;
  approvalInternal.sleep = SHIPPED_SLEEP;
  setEscalationService(null);
});

describe('on Full, a held-back package’s Needs-you row is quiet (DOR-3427)', () => {
  it('raises one passive ticket that arms no escalation', async () => {
    expect(sync()).toEqual(['evil']);
    await settle();

    const pending = approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.capabilityId).toBe(HOOK_PROJECTION_CAPABILITY_ID);
    expect(pending[0]?.expiresAt).toBe(PASSIVE_APPROVAL_EXPIRES_AT);
    expect(arm).not.toHaveBeenCalled();

    // And at boot: the rebuilt payload says passive, so its tier is notable.
    const payload = capabilityApprovalPayload(pending[0]!);
    expect(payload.passive).toBe(true);
    expect(resolvePerKind(notificationEntry('approval.pending').tier, payload)).toBe('notable');
  });

  it('three syncs and an expiry window leave one ticket and no push', async () => {
    sync();
    sync();
    sync();
    await settle();
    // Longer than the ordinary one-second window.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    approvals.sweepExpired();
    sync();
    // As after a restart: the in-process memory is gone, and the open ticket
    // is picked up again rather than raised a second time.
    approvalInternal.forgetDecisions();
    sync();
    await settle();

    expect(approvals.listPending()).toHaveLength(1);
    expect(arm).not.toHaveBeenCalled();
  });

  it('says what it is: no "cannot be undone", nothing waiting', async () => {
    sync();
    await settle();
    const payload = capabilityApprovalPayload(approvals.listPending()[0]!);
    const entry = notificationEntry('approval.pending');
    const body = entry.body?.(payload) ?? '';
    expect(body).not.toContain('cannot be undone');
    expect(body).toContain('Nothing waits on your answer');
    expect(entry.title(payload)).not.toContain('needs your approval');
  });

  it('a row for newer files closes the older one, across a restart, and refuses nothing (DOR-3433)', async () => {
    const db = createTestDb();
    const before = new ApprovalService(db, {
      describeCapability: describeHookProjectionCapability,
    });
    const v1: WithheldHooks = {
      ...HELD_BACK,
      request: { ...HELD_BACK.request, scripts: [['hooks/run.sh', 'a'.repeat(64)]] },
    };
    const v2: WithheldHooks = {
      ...HELD_BACK,
      request: { ...HELD_BACK.request, scripts: [['hooks/run.sh', 'b'.repeat(64)]] },
    };
    raisePassiveHookRows([v1], {
      projectPath: '/repo',
      approvals: before,
      reproject: () => undefined,
    });
    await settle();
    const [old] = before.listPending();

    // As after a restart: the open-card memory is gone, the rows are not.
    approvalInternal.forgetDecisions();
    const after = new ApprovalService(db, { describeCapability: describeHookProjectionCapability });
    raisePassiveHookRows([v2], {
      projectPath: '/repo',
      approvals: after,
      reproject: () => undefined,
    });
    await settle();

    const pending = after.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.approvalId).not.toBe(old?.approvalId);
    expect(pending[0]?.summary).toContain('b'.repeat(12));
    // Another package in the same project keeps its own row.
    raisePassiveHookRows(
      [{ ...HELD_BACK, request: { ...HELD_BACK.request, packageName: 'other' } }],
      { projectPath: '/repo', approvals: after, reproject: () => undefined }
    );
    await settle();
    expect(after.listPending()).toHaveLength(2);
    expect(config.harness.refusedHooks).toEqual([]);
    expect(arm).not.toHaveBeenCalled();
    for (const row of after.listPending()) after.deny(row.approvalId);
    await settle();
  });

  it('a yes on the row records the approval and projects again', async () => {
    const reproject = vi.fn();
    raisePassiveHookRows([HELD_BACK], { projectPath: '/repo', approvals, reproject });
    await settle();
    approvals.grant(approvals.listPending()[0]!.approvalId);
    await vi.waitFor(() => expect(reproject).toHaveBeenCalledTimes(1));
    expect(config.harness.approvedHooks).toHaveLength(1);
  });
});

describe('below Full, an ordinary approval still escalates', () => {
  it('arms the clock, expires, and says it cannot be undone', () => {
    const ticket = approvals.request({
      capabilityId: HOOK_PROJECTION_CAPABILITY_ID,
      inputHash: hashApprovalInput({ packageName: 'acme' }),
      summary: 'Let the installed package "acme" run 1 command automatically',
    });

    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0]?.[0]).toBe('approval.pending');
    const pending = approvals.getPending(ticket.approvalId)!;
    expect(pending.expiresAt).not.toBe(PASSIVE_APPROVAL_EXPIRES_AT);
    const payload = capabilityApprovalPayload(pending);
    expect(payload.passive).toBeUndefined();
    expect(resolvePerKind(notificationEntry('approval.pending').tier, payload)).toBe('blocking');
    expect(notificationEntry('approval.pending').body?.(payload)).toContain('cannot be undone');
  });
});
