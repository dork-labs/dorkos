/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals, eq } from '@dorkos/db';
import { ApprovalService } from '../../core/approvals/approval-service.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import {
  HOOK_CARD_PRESENTATION,
  describeHookProjection,
  summariseHookProjection,
} from '../hook-card.js';
import { _internal, hookProjectionBinding } from '../hook-approval.js';
import { raisePassiveHookRows, resumePassiveHookRows } from '../ask-withheld-hooks.js';
import { hookApprovalEntry, isHookProjectionRefused, recordHookRefusal } from '../hook-consent.js';
import type { HookProjectionRequest } from '../hook-consent.js';

const config = {
  harness: { autoSync: true, approvedHooks: [] as string[], refusedHooks: [] as string[] },
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
const full: HookProjectionRequest = {
  projectPath: '/workspaces/cedar',
  packageName: 'lunar-hooks',
  hooks: [{ event: 'Stop', command: 'node ./loop.mjs' }],
  scripts: [['loop.mjs', 'a'.repeat(64)]],
};
const input = (request = full) => ({
  ...hookProjectionBinding(request, true),
  summary: summariseHookProjection(request),
  detail: describeHookProjection(request),
  passive: true,
  packageRequest: {
    kind: 'hooks' as const,
    presentation: HOOK_CARD_PRESENTATION,
    request,
    options: { notInstalledByDorkos: true },
  },
});
let db: ReturnType<typeof createTestDb>;
let service: ApprovalService;
let home: string;
const sleep = _internal.sleep;
const interval = _internal.pollIntervalMs;
beforeEach(() => {
  db = createTestDb();
  service = new ApprovalService(db);
  home = mkdtempSync(join(tmpdir(), 'hook-reask-'));
  config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  _internal.pollIntervalMs = 5;
  _internal.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
});
afterEach(async () => {
  for (const row of service.listPending()) service.deny(row.approvalId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  _internal.forgetDecisions();
  _internal.sleep = sleep;
  _internal.pollIntervalMs = interval;
  db.$client.close();
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function declined() {
  const ticket = service.request(input());
  service.deny(ticket.approvalId);
  recordHookRefusal(full);
  return ticket;
}

describe('individual hook re-asks', () => {
  it('keeps the original denial and refusal while one fresh review waits', () => {
    const source = declined();
    const next = service.reaskHook(source.approvalId, input());
    expect(typeof next).toBe('object');
    expect(service.reaskHook(source.approvalId, input())).toBe('already_reasked');
    expect(isHookProjectionRefused(full)).toBe(true);
    expect(config.harness.approvedHooks).toEqual([]);
    expect(
      db.select().from(approvals).where(eq(approvals.id, source.approvalId)).get()
    ).toMatchObject({ state: 'denied', declineKind: 'refused' });
    expect(db.select().from(approvals).all()).toHaveLength(2);
    expect(service.declinedHooks()[0]).toMatchObject({ canAskAgain: false, askedAgain: true });
    expect(JSON.stringify(service.declinedHooks())).not.toMatch(
      /packageRequest|tokenHash|inputHash/
    );
  });

  it('allows only one active review per package and project across declined rows', () => {
    const first = declined();
    const second = declined();
    expect(typeof service.reaskHook(first.approvalId, input())).toBe('object');
    expect(service.reaskHook(second.approvalId, input())).toBe('already_reasked');
    expect(service.declinedHooks().every((row) => !row.canAskAgain && row.reviewPending)).toBe(
      true
    );
  });

  it('cannot re-ask a different capability, a pending row, or another project', () => {
    const pending = service.request(input());
    expect(service.reaskHook(pending.approvalId, input())).toBe('not_declined');
    service.deny(pending.approvalId);
    expect(
      service.reaskHook(pending.approvalId, input({ ...full, projectPath: '/workspaces/other' }))
    ).toBe('unavailable');
    const other = service.request({
      capabilityId: 'marketplace.uninstall',
      inputHash: 'other',
      summary: 'Remove package',
    });
    service.deny(other.approvalId);
    expect(service.reaskHook(other.approvalId, input())).toBe('not_declined');
  });

  it('a new yes after restart replaces exactly the old refusal and pins the reviewed files', async () => {
    const source = declined();
    const changed = { ...full, scripts: [['loop.mjs', 'b'.repeat(64)]] as [string, string][] };
    db.update(approvals)
      .set({ expiresAt: new Date(Date.now() - 3 * 86400000).toISOString() })
      .where(eq(approvals.id, source.approvalId))
      .run();
    const next = service.reaskHook(source.approvalId, input(changed));
    if (typeof next === 'string') throw new Error(next);
    // Cleanup must keep the original denial while its fresh review is still live.
    expect(service.purgeExpired()).toBe(0);
    const restarted = new ApprovalService(db);
    expect(restarted.isReaskedHook(hookProjectionBinding(changed, true))).toBe(true);
    expect(restarted.grant(next.approvalId)).toBeUndefined();
    const reproject = vi.fn(async () => []);
    expect(resumePassiveHookRows({ dorkHome: home, approvals: restarted, reproject })).toEqual([
      'lunar-hooks',
    ]);
    await vi.waitFor(() => expect(reproject).toHaveBeenCalledTimes(1));
    expect(config.harness.refusedHooks).toEqual([]);
    expect(config.harness.approvedHooks).toEqual([hookApprovalEntry(changed)]);
    expect(restarted.grant(source.approvalId)).toBe('not_pending');
    expect(restarted.declinedHooks()).toEqual([]);
    expect(restarted.consume(next.token, hookProjectionBinding(changed, true)).outcome).toBe(
      'unknown'
    );
    expect(
      db.select().from(approvals).where(eq(approvals.id, next.approvalId)).get()?.consumedAt
    ).not.toBeNull();
  });

  it('an incomplete decline never creates a lasting refusal', async () => {
    const huge = { ...full, hooks: [{ event: 'Stop', command: 'x'.repeat(4001) }] };
    raisePassiveHookRows([{ reason: 'unasked', request: huge, notInstalledByDorkos: true }], {
      projectPath: full.projectPath,
      approvals: service,
      dorkHome: home,
      reproject: vi.fn(),
    });
    const row = service.listPending()[0]!;
    expect(row.cannotAllow).toBe(true);
    service.deny(row.approvalId);
    await vi.waitFor(() => expect(service.declineKind(row.approvalId)).toBe('incomplete'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(config.harness.refusedHooks).toEqual([]);
    expect(service.declinedHooks()[0]).toMatchObject({
      declineKind: 'incomplete',
      canAskAgain: true,
    });
  });
});
