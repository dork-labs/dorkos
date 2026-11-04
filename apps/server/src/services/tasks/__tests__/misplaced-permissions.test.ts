import fs from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { MISPLACED_SCHEDULE_PERMISSIONS } from '@dorkos/shared/schedule-file-problems';
import { TaskStore } from '../task-store.js';
import { readScheduleFromSkill } from '../skills-root-discovery.js';
import { describeArmBlocker } from '../task-file-update.js';
import { applyTaskFileUpdate } from '../lifecycle/update-task-file.js';
import { checkMisplacedMode } from '../execution/misplaced-mode.js';
import { needsScheduleApprovalAttention } from '../schedule-permission-clamp.js';
import { armToolApproval } from '../../runtimes/claude-code/mcp-tools/tasks/task-tool-mode.js';
import { grantOf } from '../agent-mode/__tests__/agent-mode-fixtures.js';
import { agentModeSnapshotOf } from '../agent-mode/agent-mode-door.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';

let folder: string;
let file: string;
let store: TaskStore;
const content = (top: string, nested = '') =>
  `---\nname: sample\ndescription: Sample\n${top}schedule:\n  cron: '0 3 * * *'\n${nested}---\nRead the sample list.\n`;
function discover(text: string) {
  const parsed = parseSkillFile(file, text, SkillFrontmatterSchema);
  if (!parsed.ok) throw new Error(parsed.error);
  const found = readScheduleFromSkill(parsed.definition, { resolvedPath: file, scope: 'global' });
  if (!found) throw new Error('No schedule');
  return found;
}
beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'misplaced-mode-'));
  await fs.mkdir(path.join(folder, 'sample'));
  file = path.join(folder, 'sample', 'SKILL.md');
  store = new TaskStore(createTestDb());
  const auditDb = createTestDb();
  initAuditTrail({
    log: new AuditLog(auditDb),
    accounts: new AccountIds({ db: auditDb, installId: 'sample', readOwnerAccount: () => null }),
  });
});
afterEach(async () => {
  resetAuditTrail();
  store.close();
  await fs.rm(folder, { recursive: true, force: true });
});

describe('a misplaced schedule mode', () => {
  it.each(['active', 'pending_approval'] as const)(
    'an MCP approval cannot arm a faulty %s file',
    async (status) => {
      const valid = content('');
      await fs.writeFile(file, valid);
      const first = store.fileSync.upsertFromFile(discover(valid).def);
      const before = status === 'active' ? first : store.updateTask(first.id, { status })!;
      await fs.writeFile(file, content('permissions: plan\n'));
      const snapshot = agentModeSnapshotOf(before, store.approvals.agentEditsOf(before.id), {
        setsMode: false,
      });
      const result = await armToolApproval(
        { dorkHome: folder, taskStore: store } as McpToolDeps,
        { grant: grantOf({ approves: true, aboveDontAsk: false, snapshot }) },
        before,
        { structural: true, resolved: 'home', marked: false }
      );
      expect(result).toBeNull();
      expect(store.getTask(first.id)?.status).toBe(status);
      expect(await fs.readFile(file, 'utf8')).toBe(content('permissions: plan\n'));
      await fs.writeFile(file, valid);
      const controlSnapshot = agentModeSnapshotOf(before, store.approvals.agentEditsOf(before.id), {
        setsMode: false,
      });
      const control = await armToolApproval(
        { dorkHome: folder, taskStore: store } as McpToolDeps,
        { grant: grantOf({ approves: true, aboveDontAsk: false, snapshot: controlSnapshot }) },
        before,
        { structural: true, resolved: 'home', marked: false }
      );
      expect(control).not.toBeNull();
      expect(store.getTask(first.id)?.status).toBe('active');
    }
  );
  it('reports a misplaced key even when the skill name differs from its folder', () => {
    expect(
      describeArmBlocker(
        file,
        content('permissions: plan\n').replace('name: sample', 'name: other-sample')
      )
    ).toBe(MISPLACED_SCHEDULE_PERMISSIONS);
  });

  it.each([
    'oversized',
    'directory',
    'duplicate',
    ...(process.platform === 'win32' ? [] : ['fifo']),
  ])('refuses a tick before the watcher sees an unreadable %s file', async (kind) => {
    const valid = content('');
    await fs.writeFile(file, valid);
    const task = store.fileSync.upsertFromFile(discover(valid).def);
    await fs.unlink(file);
    if (kind === 'directory') await fs.mkdir(file);
    else if (kind === 'fifo') execFileSync('mkfifo', [file]);
    else
      await fs.writeFile(
        file,
        kind === 'oversized'
          ? 'x'.repeat(1024 * 1024 + 1)
          : content('permissions: plan\npermissions: plan\n')
      );
    const run = store.createRun(task.id, 'scheduled');
    await expect(checkMisplacedMode(task, run, store)).rejects.toThrow(
      'The schedule file could not be read.'
    );
  });

  it.each(['plan', 'auto', 'bypassPermissions', 'imaginary', 'null', '42', '{}'])(
    'parks %s even on the operator sync path',
    async (value) => {
      const text = content(`permissions: ${value}\n`);
      await fs.writeFile(file, text);
      const found = discover(text);
      // Neither the caller supplying a problem nor discovery is needed for this guard.
      const task = store.fileSync.upsertFromFile(found.def);
      expect(task).toMatchObject({
        status: 'pending_approval',
        permissionMode: 'acceptEdits',
        cron: '0 3 * * *',
        reason: MISPLACED_SCHEDULE_PERMISSIONS,
      });
      expect(store.approvals.personApprovedCurrent(task.id)).toBe(false);
      expect(needsScheduleApprovalAttention(task)).toBe(true);
      expect(describeArmBlocker(file, text)).toBe(MISPLACED_SCHEDULE_PERMISSIONS);
      const approval = await applyTaskFileUpdate(
        { dorkHome: folder },
        { existing: task, data: { status: 'active' } }
      );
      expect(approval.ok).toBe(false);
      expect(store.getTask(task.id)?.status).toBe('pending_approval');
    }
  );

  it('keeps an invalid block visible even when discovery cannot read its settings', () => {
    const found = discover(
      '---\nname: sample\ndescription: Sample\npermissions: plan\nschedule: broken\n---\nRead the sample list.'
    );
    const task = store.fileSync.upsertFromFile(found.def, undefined, {
      source: 'discovery',
      problem: found.problem,
    });
    expect(task.enabled).toBe(false);
    expect(needsScheduleApprovalAttention(task)).toBe(true);
    expect(task.reason).toBe(MISPLACED_SCHEDULE_PERMISSIONS);
  });

  it('withdraws an old approval and clears the warning only when the file is fixed', async () => {
    const valid = content('');
    await fs.writeFile(file, valid);
    const first = store.fileSync.upsertFromFile(discover(valid).def);
    expect(first.status).toBe('active');
    const bad = content('permissions: plan\n');
    await fs.writeFile(file, bad);
    const broken = discover(bad);
    const parked = store.fileSync.upsertFromFile(broken.def, undefined, {
      source: 'discovery',
      problem: broken.problem,
    });
    expect(parked.status).toBe('pending_approval');
    expect(store.approvals.personApprovedCurrent(first.id)).toBe(false);
    const fixed = content('', '  permissions: plan\n');
    await fs.writeFile(file, fixed);
    const synced = store.fileSync.upsertFromFile(discover(fixed).def, undefined, {
      source: 'discovery',
    });
    expect(synced.status).toBe('pending_approval');
    expect(synced.reason).not.toBe(MISPLACED_SCHEDULE_PERMISSIONS);
    expect(synced.permissionMode).toBe('plan');
    expect(
      (
        await applyTaskFileUpdate(
          { dorkHome: folder },
          { existing: synced, data: { status: 'active' } }
        )
      ).ok
    ).toBe(true);
  });

  it('refuses a timer before the watcher sees the fault, but allows a supervised trial without arming', async () => {
    const original = content('');
    await fs.writeFile(file, original);
    const task = store.fileSync.upsertFromFile(discover(original).def);
    await fs.writeFile(file, content('permissions: plan\n'));
    const timer = store.createRun(task.id, 'scheduled');
    await expect(checkMisplacedMode(task, timer, store)).rejects.toThrow(
      MISPLACED_SCHEDULE_PERMISSIONS
    );
    const parked = store.getTask(task.id)!;
    await fs.unlink(file);
    await expect(checkMisplacedMode(parked, timer, store)).rejects.toThrow(
      MISPLACED_SCHEDULE_PERMISSIONS
    );
    await fs.writeFile(file, content('permissions: plan\n'));
    const manual = store.createRun(task.id, 'manual');
    expect(await checkMisplacedMode(parked, manual, store)).toMatchObject({
      permissionMode: 'acceptEdits',
      status: 'pending_approval',
    });
    expect(store.getTask(task.id)?.status).toBe('pending_approval');
    expect(store.approvals.personApprovedCurrent(task.id)).toBe(false);
  });
});
