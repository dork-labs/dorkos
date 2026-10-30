/**
 * DOR-3427: a person's yes on a quiet Needs-you row still lands after a
 * restart. Before, the restart ended the in-process wait that acts on the yes,
 * so the ticket said `granted` and nothing was recorded or projected.
 *
 * A "restart" here is the old wait dying (its store throws, as a dead process
 * would stop presenting), the open-card memory going, and a fresh
 * `ApprovalService` on the same database. Security's four conditions each have
 * a test: a yes records only what its ticket was raised for, only a person's
 * grant counts, a no still wins, and a live wait is never applied twice.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { ApprovalService } from '../../core/approvals/index.js';
import { raisePassiveHookRows, resumePassiveHookRows } from '../ask-withheld-hooks.js';
import {
  _internal as approvalInternal,
  describeHookProjectionCapability,
  type HookApprovalGateway,
} from '../hook-approval.js';
import {
  hookApprovalEntry,
  isHookProjectionApproved,
  recordHookRefusal,
  storedHookDecisions,
} from '../hook-consent.js';
import {
  passiveHookRowsPath,
  readPassiveHookRows,
  rememberPassiveHookRow,
} from '../passive-hook-rows.js';
import {
  setEscalationService,
  type EscalationService,
} from '../../notifications/escalation-service.js';
import type { WithheldHooks } from '../project-with-consent.js';

/** The package as it was when its row went up, running `run.sh` at version a. */
const V1: WithheldHooks = {
  reason: 'unasked',
  notInstalledByDorkos: true,
  request: {
    projectPath: '/repo',
    packageName: 'evil',
    hooks: [{ event: 'Stop', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"' }],
    scripts: [['hooks/run.sh', 'a'.repeat(64)]],
  },
};
/** The same package after `run.sh` was edited. */
const V2: WithheldHooks = {
  ...V1,
  request: { ...V1.request, scripts: [['hooks/run.sh', 'b'.repeat(64)]] },
};

let dorkHome: string;
let db: ReturnType<typeof createTestDb>;
const SHIPPED_POLL_MS = approvalInternal.pollIntervalMs;
const SHIPPED_SLEEP = approvalInternal.sleep;

/** A gateway over `service` that can be killed, the way a process ends. */
function killable(service: ApprovalService): HookApprovalGateway & { kill(): void } {
  let dead = false;
  const alive = (): void => {
    if (dead) throw new Error('the process ended');
  };
  return {
    request: (input) => (alive(), service.request(input)),
    consume: (token, binding) => (alive(), service.consume(token, binding)),
    reissue: (binding) => (alive(), service.reissue(binding)),
    retireSuperseded: (binding, family) => (alive(), service.retireSuperseded(binding, family)),
    kill: () => {
      dead = true;
    },
  };
}

/** A fresh server's approval store on the same database. */
function freshService(): ApprovalService {
  return new ApprovalService(db, { describeCapability: describeHookProjectionCapability });
}

/** Let every wait reach its next poll. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/** Raise the row for `withheld` before the restart, then end that process. */
async function raiseThenRestart(withheld: WithheldHooks): Promise<string> {
  const before = killable(freshService());
  raisePassiveHookRows([withheld], {
    projectPath: '/repo',
    approvals: before,
    dorkHome,
    reproject: () => undefined,
  });
  await settle();
  const [row] = freshService().listPending();
  before.kill();
  await settle();
  approvalInternal.forgetDecisions();
  return row!.approvalId;
}

beforeEach(() => {
  config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
  config.permissions = { preset: 'full' };
  dorkHome = mkdtempSync(join(tmpdir(), 'passive-restart-'));
  db = createTestDb();
  setEscalationService({ arm: vi.fn(), stop: vi.fn() } as unknown as EscalationService);
  approvalInternal.pollIntervalMs = 10;
  approvalInternal.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
});

afterEach(async () => {
  const service = freshService();
  for (const pending of service.listPending()) service.deny(pending.approvalId);
  await settle();
  approvalInternal.forgetDecisions();
  approvalInternal.pollIntervalMs = SHIPPED_POLL_MS;
  approvalInternal.sleep = SHIPPED_SLEEP;
  setEscalationService(null);
  rmSync(dorkHome, { recursive: true, force: true });
});

describe('a yes on a quiet row after a restart (DOR-3427)', () => {
  it('records the approval and projects', async () => {
    const approvalId = await raiseThenRestart(V1);
    const after = freshService();
    const reproject = vi.fn(async () => [] as WithheldHooks[]);

    expect(resumePassiveHookRows({ dorkHome, approvals: after, reproject })).toEqual(['evil']);
    await settle();
    // Picked up, not raised again.
    expect(after.listPending().map((row) => row.approvalId)).toEqual([approvalId]);

    expect(after.grant(approvalId)).toBeUndefined();
    await vi.waitFor(() => expect(reproject).toHaveBeenCalledTimes(1));
    expect(config.harness.approvedHooks).toEqual([hookApprovalEntry(V1.request)]);
    expect(readPassiveHookRows(dorkHome)).toEqual([]);
  });

  it('a yes given while the server was down is found on startup and spent once', async () => {
    const approvalId = await raiseThenRestart(V1);
    const after = freshService();
    after.grant(approvalId);
    const reproject = vi.fn(async () => [] as WithheldHooks[]);

    resumePassiveHookRows({ dorkHome, approvals: after, reproject });
    await vi.waitFor(() => expect(reproject).toHaveBeenCalledTimes(1));
    // A second startup finds nothing left to apply.
    approvalInternal.forgetDecisions();
    expect(resumePassiveHookRows({ dorkHome, approvals: freshService(), reproject })).toEqual([]);
    await settle();
    expect(reproject).toHaveBeenCalledTimes(1);
    expect(config.harness.approvedHooks).toHaveLength(1);
  });

  it('a yes for files since edited records those files only; the edit stays withheld', async () => {
    const approvalId = await raiseThenRestart(V1);
    const after = freshService();
    // The script was edited while the server was down: the next pass holds v2 back.
    const reproject = vi.fn(async () => [V2]);
    resumePassiveHookRows({ dorkHome, approvals: after, reproject });
    await settle();
    after.grant(approvalId);
    await vi.waitFor(() => expect(reproject).toHaveBeenCalledTimes(1));
    await settle();

    expect(config.harness.approvedHooks).toEqual([hookApprovalEntry(V1.request)]);
    expect(isHookProjectionApproved(V2.request, storedHookDecisions())).toBe(false);
    // One quiet row, for today's files.
    const pending = after.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.approvalId).not.toBe(approvalId);
    expect(pending[0]?.summary).toContain('b'.repeat(12));
    expect(readPassiveHookRows(dorkHome)).toEqual([V2.request]);
  });

  it('a no on record wins: the row is not picked up and a yes projects nothing', async () => {
    const approvalId = await raiseThenRestart(V1);
    recordHookRefusal(V1.request);
    const after = freshService();
    const reproject = vi.fn(async () => [] as WithheldHooks[]);

    expect(resumePassiveHookRows({ dorkHome, approvals: after, reproject })).toEqual([]);
    after.grant(approvalId);
    await settle();
    expect(reproject).not.toHaveBeenCalled();
    expect(config.harness.approvedHooks).toEqual([]);
    expect(readPassiveHookRows(dorkHome)).toEqual([]);
  });

  it('a no given while the server was down is recorded as a no', async () => {
    const approvalId = await raiseThenRestart(V1);
    const after = freshService();
    after.deny(approvalId);
    const reproject = vi.fn(async () => [] as WithheldHooks[]);

    resumePassiveHookRows({ dorkHome, approvals: after, reproject });
    await vi.waitFor(() => expect(config.harness.refusedHooks).toHaveLength(1));
    expect(reproject).not.toHaveBeenCalled();
    expect(config.harness.approvedHooks).toEqual([]);
    expect(readPassiveHookRows(dorkHome)).toEqual([]);
  });

  it('a saved row with no open ticket is dropped, and no new row goes up', async () => {
    rememberPassiveHookRow(dorkHome, V1.request);
    const after = freshService();

    expect(resumePassiveHookRows({ dorkHome, approvals: after, reproject: vi.fn() })).toEqual([
      'evil',
    ]);
    await settle();
    expect(after.listPending()).toEqual([]);
    expect(readPassiveHookRows(dorkHome)).toEqual([]);
  });

  it('with the first wait still alive, the yes is applied once', async () => {
    const service = freshService();
    const reproject = vi.fn(async () => [] as WithheldHooks[]);
    raisePassiveHookRows([V1], { projectPath: '/repo', approvals: service, dorkHome, reproject });
    await settle();
    // A resume in the same process finds the wait already there.
    expect(resumePassiveHookRows({ dorkHome, approvals: service, reproject })).toEqual([]);

    service.grant(service.listPending()[0]!.approvalId);
    await vi.waitFor(() => expect(reproject).toHaveBeenCalledTimes(1));
    await settle();
    expect(reproject).toHaveBeenCalledTimes(1);
    expect(config.harness.approvedHooks).toHaveLength(1);
  });

  it('a saved row that is not the right shape is dropped, and startup goes on', async () => {
    const file = passiveHookRowsPath(dorkHome);
    mkdirSync(join(dorkHome, 'harness'), { recursive: true });
    const good = { ...V1.request, packageName: 'good' };
    writeFileSync(
      file,
      JSON.stringify([
        // Each of these used to reach the entry digest, which threw at startup.
        { ...V1.request, packageName: 'null-hook', hooks: [null] },
        { ...V1.request, packageName: 'no-command', hooks: [{ event: 'Stop' }] },
        { ...V1.request, packageName: 'number-event', hooks: [{ event: 1, command: 'x' }] },
        {
          ...V1.request,
          packageName: 'bad-matcher',
          hooks: [{ ...V1.request.hooks[0], matcher: 3 }],
        },
        { ...V1.request, packageName: 'bad-pin', scripts: [['hooks/run.sh']] },
        'not a row',
        null,
        good,
      ])
    );

    expect(readPassiveHookRows(dorkHome)).toEqual([good]);
    expect(() =>
      resumePassiveHookRows({ dorkHome, approvals: freshService(), reproject: vi.fn() })
    ).not.toThrow();
    await settle();
  });
});
