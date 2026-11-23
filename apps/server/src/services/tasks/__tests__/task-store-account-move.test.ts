/**
 * An agent changing only the account of an approved schedule keeps it approved
 * (DOR-5097), unless the new account is one a person restricted: who pays is
 * not what the run does. Anything else the edit changes still parks it.
 *
 * Real store over a real database; the account list is handed in.
 *
 * @module services/tasks/__tests__/task-store-account-move
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../task-store.js';
import type { TaskFileSync } from '../sync/task-file-sync.js';
import { scheduleContentKey, taskWorkOf } from '../schedule-permission-clamp.js';
import type { RuntimeAccount } from '../../core/usage/runtime-accounts.js';
import { accountMayTakeMovedWork } from '../approvals/account-move.js';
import { movesOnlyAccount } from '../approvals/account-move-rule.js';

const FILE_PATH = `/home/u/.dork/skills/publish/${SKILL_FILENAME}`;

function definition(account: string) {
  return {
    name: 'publish',
    meta: {
      name: 'publish',
      description: 'Publish due posts',
      schedule: {
        cron: '0 17 * * *',
        timezone: 'UTC',
        enabled: true,
        sticky: false,
        permissions: 'acceptEdits',
        account,
      },
    },
    body: 'Publish the posts that are due.',
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

function account(id: string, extra: Partial<RuntimeAccount> = {}): RuntimeAccount {
  return {
    runtime: 'claude-code',
    id,
    label: id,
    path: `/accounts/${id}`,
    routable: true,
    implicit: false,
    isDefault: false,
    ...extra,
  } as RuntimeAccount;
}

const ACCOUNTS = [
  account('claude3'),
  account('claude4'),
  account('main', { isDefault: true }),
  account('claude-ab1', { noAutoMove: true }),
];
const mayMoveTo = (id: string | null) => accountMayTakeMovedWork(id, ACCOUNTS);

describe('which accounts an agent may move approved work to', () => {
  it('allows an ordinary signed-in account', () => {
    expect(mayMoveTo('claude3')).toBe(true);
  });

  it.each([
    ['DorkOS credits', CREDITS_ACCOUNT_ID],
    ['the main sign-in', 'main'],
    ['the implicit default', 'default'],
    ['an account kept out of automatic moves', 'claude-ab1'],
    ['an account this computer does not know', 'claude9'],
    ['no account (back to the agent’s)', null],
  ])('restricts %s', (_, id) => {
    expect(mayMoveTo(id)).toBe(false);
  });
});

describe('movesOnlyAccount', () => {
  const work = {
    prompt: 'p',
    cron: '0 17 * * *',
    timezone: 'UTC',
    name: 'publish',
    runtime: null,
    model: null,
    effort: null,
    maxRuntime: null,
    sticky: false,
    account: 'claude3',
  };

  it('is true only when the account alone differs', () => {
    expect(movesOnlyAccount(work, { ...work, account: 'claude4' })).toBe(true);
    expect(movesOnlyAccount(work, work)).toBe(false);
    expect(movesOnlyAccount(work, { ...work, account: 'claude4', model: 'opus' })).toBe(false);
  });
});

describe('an agent’s account-only change to an approved schedule', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  const row = (id: string) =>
    db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get()!;

  /** An approved schedule on claude3, a person's approval recorded. */
  function approved(): string {
    const id = store.fileSync.upsertFromFile(definition('claude3')).id;
    store.approvals.recordPersonApproval(id);
    return id;
  }

  /** The agent's edit, settled as both doors settle it. */
  function agentEdit(id: string, patch: { account?: string | null; model?: string }) {
    const before = { ...taskWorkOf(store.getTask(id)!), status: store.getTask(id)!.status };
    store.updateTask(id, patch);
    return store.approvals.settleApprovedWorkChange(id, before, {
      trusted: false,
      accountMayMoveTo: mayMoveTo,
    });
  }

  it('stays active and approved, with its grant and the person’s approval on the new account', () => {
    const id = approved();
    const receipt = { approvedAt: row(id).approvedAt, approvedBy: row(id).approvedBy };

    expect(agentEdit(id, { account: 'claude4' })).toBe('account-moved');

    const task = store.getTask(id)!;
    expect(task).toMatchObject({ status: 'active', account: 'claude4' });
    const key = scheduleContentKey(taskWorkOf(task));
    expect(row(id).approvedContentKey).toBe(key);
    expect(row(id).personApprovedKey).toBe(key);
    // The receipt stays the person's: the agent approved nothing.
    expect({ approvedAt: row(id).approvedAt, approvedBy: row(id).approvedBy }).toEqual(receipt);
    // And the next sync of the file the tools wrote keeps it live.
    expect(
      store.fileSync.upsertFromFile(definition('claude4'), undefined, { source: 'discovery' })
        .status
    ).toBe('active');
  });

  it.each([
    ['DorkOS credits', CREDITS_ACCOUNT_ID],
    ['the main sign-in', 'main'],
    ['a kept-out account', 'claude-ab1'],
    ['no account', null],
  ])('parks a move to %s, as before', (_, to) => {
    const id = approved();
    expect(agentEdit(id, { account: to })).toBe('parked');
    expect(store.getTask(id)!.status).toBe('pending_approval');
  });

  it('parks a change to the account and anything else', () => {
    const id = approved();
    expect(agentEdit(id, { account: 'claude4', model: 'claude-opus-4' })).toBe('parked');
    expect(store.getTask(id)!.status).toBe('pending_approval');
  });

  it('puts back a sync that parked the schedule in the middle of the request', () => {
    const id = approved();
    const before = { ...taskWorkOf(store.getTask(id)!), status: 'active' };
    store.updateTask(id, { account: 'claude4' });
    // The watcher syncs the new file against the row before the request settles.
    store.fileSync.upsertFromFile(definition('claude4'), undefined, { source: 'discovery' });
    expect(store.getTask(id)!.status).toBe('pending_approval');

    expect(
      store.approvals.settleApprovedWorkChange(id, before, {
        trusted: false,
        accountMayMoveTo: mayMoveTo,
      })
    ).toBe('account-moved');
    expect(store.getTask(id)).toMatchObject({ status: 'active', reason: null });
  });

  it('approves nothing a person had not approved', () => {
    const id = approved();
    store.updateTask(id, { status: 'pending_approval' });
    expect(agentEdit(id, { account: 'claude4' })).toBe('unchanged');
    expect(store.getTask(id)!.status).toBe('pending_approval');
    expect(row(id).approvedContentKey).toBeNull();
  });
});
