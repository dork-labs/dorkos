/**
 * A scheduled run whose account is out of usage or signed out (DOR-5097): it
 * starts on another signed-in account with room, chosen the way a room seat
 * moves, and its run row says which and why; a task pinned to its account
 * fails plainly instead.
 *
 * The decision is pure over core's ranking. The wiring is the real
 * `checkRunAccount` over a real store, with the account world handed in.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { CREDITS_ACCOUNT_ID, type AccountUsage } from '@dorkos/shared/account-usage';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { RankedAccount } from '../../../core/usage/account-ranking.js';
import { TaskStore } from '../../task-store.js';
import type { RunExecution } from '../../execution/resolve-run-execution.js';
import { checkRunAccount } from '../run-account.js';
import { decideRunAccount, type RunAccountWorld } from '../run-account-fallback.js';

const RESET = '2026-11-28T15:00:00.000Z';

function usage(id: string, opts: { limited?: boolean; weekly?: number } = {}): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: id,
    path: `/accounts/${id}`,
    label: id,
    color: '#000000',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      {
        key: 'seven_day',
        label: 'Week',
        usedPct: opts.limited ? 100 : (opts.weekly ?? 20),
        resetsAt: RESET,
        status: null,
        expired: false,
        observedAt: '2026-11-23T00:00:00.000Z',
        source: 'sdk_usage',
      },
    ],
    state: opts.limited ? 'limited' : 'ok',
    limit: opts.limited ? { window: 'seven_day', resetsAt: RESET } : null,
    updatedAt: null,
  } as AccountUsage;
}

function ranked(
  id: string,
  opts: {
    limited?: boolean;
    weekly?: number;
    signedOut?: true;
    noAutoMove?: true;
    isDefault?: true;
    label?: string;
  } = {}
): RankedAccount {
  return {
    runtime: 'claude-code',
    id,
    label: opts.label ?? id,
    color: '#000000',
    eligible: !opts.limited,
    reason: '',
    usage: usage(id, opts),
    ...(opts.signedOut ? { signedOut: true as const } : {}),
    ...(opts.noAutoMove ? { noAutoMove: true as const } : {}),
    ...(opts.isDefault ? { isDefault: true as const } : {}),
  };
}

describe('decideRunAccount', () => {
  it('stays on an account that has room', () => {
    const world = { accountId: 'claude4', ranking: [ranked('claude2'), ranked('claude4')] };
    expect(decideRunAccount(world, false)).toEqual({ kind: 'stay' });
  });

  it('stays when core does not rank the account at all', () => {
    expect(decideRunAccount({ accountId: 'claude9', ranking: [ranked('claude2')] }, false)).toEqual(
      { kind: 'stay' }
    );
  });

  it('moves a run off a limited account to the best one with room, and says why', () => {
    const world = {
      accountId: 'claude4',
      ranking: [
        ranked('claude2', { weekly: 30, label: 'Claude2' }),
        ranked('claude4', { limited: true, label: 'Claude4' }),
      ],
    };
    expect(decideRunAccount(world, false)).toEqual({
      kind: 'move',
      move: {
        from: { id: 'claude4', label: 'Claude4' },
        to: { id: 'claude2', label: 'Claude2' },
        reason: 'limited',
      },
    });
  });

  it('moves a run off a signed-out account', () => {
    const world = {
      accountId: 'claude5',
      ranking: [ranked('claude5', { signedOut: true }), ranked('claude3')],
    };
    expect(decideRunAccount(world, false)).toMatchObject({
      kind: 'move',
      move: { to: { id: 'claude3' }, reason: 'signed-out' },
    });
  });

  it('picks the way a room seat does: never credits, a kept-out or signed-out account, or one nearly out', () => {
    const world = {
      accountId: 'claude4',
      ranking: [
        ranked(CREDITS_ACCOUNT_ID),
        ranked('claude-ab1', { noAutoMove: true }),
        ranked('claude5', { signedOut: true }),
        ranked('claude6', { weekly: 97 }),
        ranked('claude4', { limited: true }),
        ranked('claude7', { weekly: 50 }),
      ],
    };
    expect(decideRunAccount(world, false)).toMatchObject({
      kind: 'move',
      move: { to: { id: 'claude7' } },
    });
  });

  it('never moves agent work onto the main sign-in', () => {
    const world = {
      accountId: 'claude4',
      ranking: [ranked('main', { isDefault: true }), ranked('claude4', { limited: true })],
    };
    expect(decideRunAccount(world, false)).toEqual({ kind: 'stay' });
    const implicit = {
      accountId: 'claude4',
      ranking: [ranked('default'), ranked('claude4', { limited: true })],
    };
    expect(decideRunAccount(implicit, false)).toEqual({ kind: 'stay' });
  });

  it('starts where it is when no account can take it', () => {
    const world = {
      accountId: 'claude4',
      ranking: [ranked('claude4', { limited: true }), ranked('claude3', { limited: true })],
    };
    expect(decideRunAccount(world, false)).toEqual({ kind: 'stay' });
  });

  it('fails a pinned task plainly instead of moving it', () => {
    const limited = {
      accountId: 'claude4',
      ranking: [ranked('claude4', { limited: true, label: 'Claude4' }), ranked('claude2')],
    };
    const decision = decideRunAccount(limited, true);
    expect(decision.kind).toBe('pinned');
    expect(decision.kind === 'pinned' && decision.message).toMatch(
      /^Claude4 is out of usage until .+\. This task runs only on Claude4\.$/
    );
    const signedOut = {
      accountId: 'claude5',
      ranking: [ranked('claude5', { signedOut: true, label: 'Claude5' }), ranked('claude2')],
    };
    expect(decideRunAccount(signedOut, true)).toEqual({
      kind: 'pinned',
      message: 'Claude5 is signed out. This task runs only on Claude5.',
    });
  });

  it('runs a pinned task that has room', () => {
    const world = { accountId: 'claude4', ranking: [ranked('claude4')] };
    expect(decideRunAccount(world, true)).toEqual({ kind: 'stay' });
  });
});

describe('checkRunAccount moves a run before it starts', () => {
  let store: TaskStore;
  let task: Task;
  let run: TaskRun;

  beforeEach(() => {
    store = new TaskStore(createTestDb());
    task = store.createTask({
      name: 'publish-due-posts',
      description: 'Publish due posts',
      prompt: 'Publish the posts that are due.',
      cron: '0 17 * * *',
      filePath: '/tmp/skills/publish-due-posts/SKILL.md',
      account: 'claude4',
    } as Parameters<TaskStore['createTask']>[0]);
    run = store.createRun(task.id, 'scheduled');
  });

  const execution = (): RunExecution =>
    ({
      runtimeType: 'claude-code',
      capabilities: undefined,
      settings: { accountHint: 'claude4' },
    }) as RunExecution;

  const world = (accounts: RankedAccount[]) => async (): Promise<RunAccountWorld> => ({
    accountId: 'claude4',
    ranking: accounts,
  });

  const check = (t: Task, exec: RunExecution, accounts: RankedAccount[]) =>
    checkRunAccount({
      store,
      task: t,
      run,
      execution: exec,
      placement: { cwd: '' },
      activityService: null,
      readAccounts: world(accounts),
    });

  it('launches on the other account and records which and why on the run', async () => {
    const exec = execution();
    const refusal = await check(task, exec, [
      ranked('claude4', { limited: true, label: 'Claude4' }),
      ranked('claude5', { label: 'Claude5' }),
    ]);

    expect(refusal).toBeNull();
    expect(exec.settings.accountHint).toBe('claude5');
    expect(store.getRun(run.id)!.accountMove).toEqual({
      from: { id: 'claude4', label: 'Claude4' },
      to: { id: 'claude5', label: 'Claude5' },
      reason: 'limited',
    });
  });

  it('leaves a run with room alone and records no move', async () => {
    const exec = execution();
    expect(await check(task, exec, [ranked('claude4'), ranked('claude5')])).toBeNull();
    expect(exec.settings.accountHint).toBe('claude4');
    expect(store.getRun(run.id)!.accountMove).toBeUndefined();
  });

  it('fails a pinned task’s run with the plain sentence, and moves nothing', async () => {
    store.updateTask(task.id, { accountPinned: true });
    const pinned = store.getTask(task.id)!;
    expect(pinned.accountPinned).toBe(true);
    const exec = execution();

    const refusal = await check(pinned, exec, [
      ranked('claude4', { signedOut: true, label: 'Claude4' }),
      ranked('claude5'),
    ]);

    expect(refusal?.message).toBe('Claude4 is signed out. This task runs only on Claude4.');
    expect(exec.settings.accountHint).toBe('claude4');
    expect(store.getRun(run.id)!.accountMove).toBeUndefined();
  });

  it('never moves a run on another runtime', async () => {
    const exec = { ...execution(), runtimeType: 'codex' } as RunExecution;
    expect(
      await check(task, exec, [ranked('claude4', { limited: true }), ranked('c5')])
    ).toBeNull();
    expect(exec.settings.accountHint).toBe('claude4');
  });
});
