/**
 * What may run, and what arms (DOR-3703): the run rule for a mode an agent set
 * above Don't ask (M-A, with the pending-ruling switch on), and an approval's
 * arm-time check that the SKILL file is still the one the decision read (N-b).
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-record
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';

// The experiment on, as it ships, for the dispatch check (S4).
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'tasks' ? { agentModeControl: true } : undefined),
  },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));

import { TaskStore } from '../../task-store.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS } from '../agent-mode-actions.js';
import { agentModeSnapshotOf } from '../agent-mode-door.js';
import { grantOf } from './agent-mode-fixtures.js';
import {
  armAgentApproval,
  grantedModeMayRun,
  parkIfAgentApprovalStale,
} from '../agent-mode-record.js';
import { agentModeRecordText } from '../agent-mode-record-field.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';

describe('what a mode an agent set may run at (M-A)', () => {
  it('ships with the pending-ruling switch on', () => {
    expect(MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS).toBe(true);
  });

  it('runs a mode up to Don’t ask without more', () => {
    expect(grantedModeMayRun(grantOf({ aboveDontAsk: false }), false)).toBe(true);
  });

  it('runs a looser mode a person answered a card for only while they approved the content as it is (M1)', () => {
    expect(grantedModeMayRun(grantOf({ via: 'card' }), true)).toBe(true);
    expect(grantedModeMayRun(grantOf({ via: 'card' }), false)).toBe(false);
  });

  it('runs a looser mode only on content a person approved, or when its own agent vouches', () => {
    expect(grantedModeMayRun(grantOf({}), false)).toBe(false);
    expect(grantedModeMayRun(grantOf({}), true)).toBe(true);
    expect(grantedModeMayRun(grantOf({ vouched: true }), false)).toBe(true);
  });

  it('holds a scheduled run’s raise for a person, whatever the mode (Nov 3, condition 3)', () => {
    expect(grantedModeMayRun(grantOf({ vouched: true, scheduledRaise: true }), true)).toBe(false);
    expect(grantedModeMayRun(grantOf({ aboveDontAsk: false, scheduledRaise: true }), true)).toBe(
      false
    );
  });
});

describe('an approval arms only the file the decision read (N-b)', () => {
  let store: TaskStore;
  let root: string;

  beforeEach(() => {
    store = new TaskStore(createTestDb());
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor3703-arm-')));
    const auditDb = createTestDb();
    initAuditTrail({
      log: new AuditLog(auditDb),
      accounts: new AccountIds({ db: auditDb, installId: 'inst', readOwnerAccount: () => null }),
    });
  });

  afterEach(() => {
    resetAuditTrail();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('arms nothing when the SKILL file was rewritten after the decision read it', () => {
    const file = path.join(root, 'SKILL.md');
    fs.writeFileSync(file, '---\nname: sweep\n---\nsweep the backlog\n');
    const task = store.createTask({
      name: 'sweep',
      description: 'sweep',
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      permissionMode: 'dontAsk',
      filePath: file,
    });
    store.updateTask(task.id, { status: 'pending_approval' });
    const waiting = store.getTask(task.id)!;
    const snapshot = agentModeSnapshotOf(waiting, store.approvals.agentEditsOf(task.id), {
      setsMode: false,
    });
    const grant = grantOf({ approves: true, aboveDontAsk: false, snapshot });

    // The file gains a line the row has not synced yet.
    fs.appendFileSync(file, 'and also delete the old branches\n');
    expect(armAgentApproval({ grant, before: waiting, store, meshCore: undefined })).toBeNull();
    expect(store.getTask(task.id)?.status).toBe('pending_approval');

    // As read, it arms.
    const fresh = agentModeSnapshotOf(waiting, store.approvals.agentEditsOf(task.id), {
      setsMode: false,
    });
    const armed = armAgentApproval({
      grant: grantOf({ approves: true, aboveDontAsk: false, snapshot: fresh }),
      before: waiting,
      store,
      meshCore: undefined,
    });
    expect(armed?.status).toBe('active');
  });
});

describe('at dispatch, a mode an agent set above Don’t ask (round 3 S4, Nov 3)', () => {
  /** The level a person set for the task's agent, by mode id. */
  let agentLevel: string;
  const sources = {
    declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    agentLevelMode: async () => agentLevel,
    agentPathOf: () => '/agents/a',
  };
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(createTestDb());
    agentLevel = 'bypassPermissions';
  });

  afterEach(() => store.close());

  /** A running task at Bypass, filed under agent A, which agent A proposed. */
  function bypassTask(): string {
    const task = store.createTask({
      name: 'sweep',
      description: 'sweep',
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      agentId: 'agent-a',
      permissionMode: 'bypassPermissions',
      filePath: '',
    });
    store.recordProposal(task.id, {
      proposedByAgentPath: '/agents/a',
      proposedBySessionId: 'ses-a',
    });
    return task.id;
  }

  /** Agent A set the mode, and vouched for it unless told otherwise. */
  function agentSet(id: string, vouched: boolean): void {
    store.approvals.recordAgentModeChange(
      id,
      agentModeRecordText({
        kind: 'set_mode',
        agentPath: '/agents/a',
        at: new Date().toISOString(),
        mode: 'bypassPermissions',
        previousMode: 'acceptEdits',
      })
    );
    if (vouched) {
      store.approvals.recordAgentAttestation(id, {
        agentPath: '/agents/a',
        sessionId: 'ses-a',
        startedBy: 'you',
        turnLevel: null,
        marked: false,
        contentHash: null,
        mode: 'bypassPermissions',
        at: new Date().toISOString(),
      });
    }
  }

  it('parks it when neither a person approved the content nor its agent vouched for it', async () => {
    const id = bypassTask();
    agentSet(id, false);
    expect(await parkIfAgentApprovalStale(id, store, undefined, sources)).toBe(true);
    expect(store.getTask(id)?.status).toBe('pending_approval');
  });

  it('runs it when a person approved the content, or its own agent vouched', async () => {
    const approved = bypassTask();
    agentSet(approved, false);
    store.approvals.recordPersonApproval(approved);
    expect(await parkIfAgentApprovalStale(approved, store, undefined, sources)).toBe(false);
    const vouched = bypassTask();
    agentSet(vouched, true);
    expect(await parkIfAgentApprovalStale(vouched, store, undefined, sources)).toBe(false);
    expect(store.getTask(vouched)?.status).toBe('active');
  });

  it('parks it once a person lowered its agent below the task’s mode (condition 2)', async () => {
    const id = bypassTask();
    agentSet(id, true);
    store.approvals.recordPersonApproval(id);
    agentLevel = 'acceptEdits';
    expect(await parkIfAgentApprovalStale(id, store, undefined, sources)).toBe(true);
  });

  it('keeps an upgraded agent-proposed Bypass row nothing has written since running (M5)', async () => {
    const id = bypassTask();
    agentLevel = 'default';
    expect(store.approvals.personApprovedCurrent(id)).toBe(false);
    expect(await parkIfAgentApprovalStale(id, store, undefined, sources)).toBe(false);
    expect(store.getTask(id)?.status).toBe('active');
  });
});
