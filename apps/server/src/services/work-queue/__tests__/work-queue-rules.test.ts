/**
 * Who may do what to a work queue (DOR-3462), and which account it picks. The
 * point of these: an agent works on its own queue only, and has no tool that turns
 * a queue on, raises its target or cap, or lifts the stop on every queue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { RankedAccount } from '../../core/usage/account-ranking.js';
import { accountFull, pickQueueAccount } from '../work-queue-limits.js';
import { workQueueDomain } from '../work-queue-capabilities.js';
import { chatStateFromStatus, startResultFrom } from '../work-queue-wiring.js';
import { WorkQueueError, WorkQueueService } from '../work-queue-service.js';
import { WorkQueueStore } from '../work-queue-store.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: () => ({}),
  createTaggedLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../runtimes/claude-code/accounts/account-login-metadata.js', () => ({
  mayAutoPickClaudeRoot: () => true,
}));

/** An account's usage at one share of its weekly window. */
function usage(usedPct: number | null, state: AccountUsage['state'] = 'ok'): AccountUsage {
  return {
    state,
    path: '/accounts/one',
    windows: [{ key: 'seven_day', usedPct, expired: false, resetsAt: null }],
  } as unknown as AccountUsage;
}

/** A ranked account row. */
function row(id: string, over: Partial<RankedAccount> = {}): RankedAccount {
  return {
    runtime: 'claude-code',
    id,
    label: id,
    color: null,
    usage: usage(10),
    eligible: true,
    reason: '',
    ...over,
  } as RankedAccount;
}

describe('which account a queue picks', () => {
  it('takes the first with room, skipping one at 80%', () => {
    const picked = pickQueueAccount(
      [row('full', { usage: usage(80) }), row('roomy', { usage: usage(79) })],
      'claude-code'
    );
    expect(picked?.id).toBe('roomy');
  });

  it('never picks credits, a kept-out account, or an ineligible one', () => {
    expect(
      pickQueueAccount(
        [
          row(CREDITS_ACCOUNT_ID),
          row('kept', { noAutoMove: true }),
          row('barred', { eligible: false }),
        ],
        'claude-code'
      )
    ).toBeNull();
  });

  it('still tries an account nobody has measured', () => {
    expect(accountFull(usage(null))).toBe(false);
  });

  it('treats a limited account as full, whatever its windows say', () => {
    expect(accountFull(usage(5, 'limited'))).toBe(true);
  });
});

describe('reading a chat and a start', () => {
  it('a chat waiting on a person is still running', () => {
    expect(chatStateFromStatus({ lifecycle: 'blocked' } as never)).toEqual({ kind: 'live' });
  });

  it('maps how a chat ended', () => {
    expect(chatStateFromStatus(null)).toEqual({ kind: 'ended', outcome: 'finished' });
    expect(chatStateFromStatus({ lifecycle: 'error' } as never)).toEqual({
      kind: 'ended',
      outcome: 'failed',
    });
    expect(chatStateFromStatus({ lifecycle: 'interrupted' } as never)).toEqual({
      kind: 'ended',
      outcome: 'stopped',
    });
  });

  /** A session_start answer. */
  const answer = (body: unknown, isError = false) => ({
    content: [{ text: JSON.stringify(body) }],
    isError,
  });

  it('reads a started chat with the account it was given', () => {
    expect(startResultFrom(answer({ sessionId: 's1' }), 'acct')).toEqual({
      kind: 'started',
      sessionId: 's1',
      accountId: 'acct',
    });
  });

  it.each([
    ['LAUNCH_CAP_FULL', 'chat-cap'],
    ['AGENT_PAUSED', 'agent-paused'],
    ['ACCOUNT_REFUSED', 'accounts'],
  ])('keeps the item in line on %s', (code, hold) => {
    expect(startResultFrom(answer({ code, error: 'no' }, true), null)).toEqual({
      kind: 'held',
      hold,
    });
  });

  it('ends the item on any other refusal', () => {
    expect(
      startResultFrom(answer({ code: 'OUTSIDE_BOUNDARY', error: 'Not there.' }, true), null)
    ).toEqual({ kind: 'refused', message: 'Not there.' });
  });
});

describe('who may change a queue', () => {
  let service: WorkQueueService;
  let deps: CapabilityDeps;

  /** A call as an agent at a home folder. */
  const as = (name: string): CapabilityHandlerContext =>
    ({
      identity: { agentPath: `/agents/${name}`, displayName: name, createdAt: 'x' },
      sessionId: `chat-${name}`,
    }) as CapabilityHandlerContext;

  /** One capability, parsed and invoked the way the registry does. */
  async function call(id: string, input: unknown, context: CapabilityHandlerContext) {
    const capability = workQueueDomain.capabilities.find((c) => c.id === id);
    if (!capability) throw new Error(`no capability ${id}`);
    return (await capability.invoke(deps, capability.input.parse(input), context)) as {
      ok: boolean;
      code?: string;
      item?: { id: string; agentId: string; addedBy: string };
      queue?: { target: number; items: unknown[] };
    };
  }

  beforeEach(() => {
    service = new WorkQueueService({
      store: new WorkQueueStore(createTestDb()),
      holdOf: () => null,
      wake: () => undefined,
    });
    deps = {
      workQueueDeps: {
        service,
        agentIdForPath: (p: string) => (p === '/agents/stranger' ? undefined : `id-${p.slice(8)}`),
      },
    } as unknown as CapabilityDeps;
  });

  it('adds to the calling agent’s own queue, with no way to name another', async () => {
    const result = await call('work-queue.add', { title: 'T', prompt: 'P' }, as('ana'));
    expect(result.item).toMatchObject({ agentId: 'id-ana', addedBy: 'agent' });
    expect(service.read('id-bo').items).toEqual([]);
  });

  it('refuses a call with no agent, and an unregistered one', async () => {
    const noAgent = await call(
      'work-queue.add',
      { title: 'T', prompt: 'P' },
      {} as CapabilityHandlerContext
    );
    expect(noAgent.code).toBe('NO_AGENT');
    const unknown = await call('work-queue.list', {}, as('stranger'));
    expect(unknown.code).toBe('UNKNOWN_AGENT');
  });

  it('takes the queue from the identity, never an argument', async () => {
    const add = workQueueDomain.capabilities.find((c) => c.id === 'work-queue.add');
    expect(add?.input.parse({ title: 'T', prompt: 'P', agentId: 'id-bo' })).toEqual({
      title: 'T',
      prompt: 'P',
    });
    const list = workQueueDomain.capabilities.find((c) => c.id === 'work-queue.list');
    expect(list?.input.parse({ agentId: 'id-bo' })).toEqual({});
  });

  it('refuses to remove another agent’s item', async () => {
    const added = await call('work-queue.add', { title: 'T', prompt: 'P' }, as('ana'));
    const result = await call('work-queue.remove', { id: added.item?.id }, as('bo'));
    expect(result.code).toBe('NOT_YOURS');
    expect(service.read('id-ana').items).toHaveLength(1);
  });

  it('adding work does not turn a queue on', async () => {
    await call('work-queue.add', { title: 'T', prompt: 'P' }, as('ana'));
    expect(service.read('id-ana').enabled).toBe(false);
  });

  it('gives agents no tool that turns a queue on, sets its limits, reorders or stops', () => {
    const ids = workQueueDomain.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(['work-queue.add', 'work-queue.list', 'work-queue.remove']);
  });

  it('decides every change in the area that governs starting a chat', () => {
    const changes = workQueueDomain.capabilities.filter((c) => c.tier !== 'observe');
    expect(changes.map((c) => c.area)).toEqual(['agents', 'agents']);
  });

  it('refuses a relative folder', () => {
    expect(() =>
      service.add({ kind: 'person' }, 'id-ana', { title: 'T', prompt: 'P', cwd: 'relative' })
    ).toThrow(WorkQueueError);
  });

  it('refuses to remove an item that started', () => {
    const store = new WorkQueueStore(createTestDb());
    const local = new WorkQueueService({ store, holdOf: () => null, wake: () => undefined });
    const item = local.add({ kind: 'person' }, 'id-ana', { title: 'T', prompt: 'P' });
    store.claim(item, '2026-10-30');
    expect(() => local.remove({ kind: 'person' }, item.id)).toThrow('already started');
  });
});
