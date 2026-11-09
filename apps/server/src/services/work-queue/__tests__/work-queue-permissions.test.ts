/** Security conditions on work-queue permission actions. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditEvents } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../core/capabilities/index.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
  CapabilityGateRefusal,
} from '../../core/capabilities/tier-enforcement.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { workQueueDomain } from '../work-queue-capabilities.js';
import { WorkQueueStore } from '../work-queue-store.js';
import { WorkQueueService } from '../work-queue-service.js';

const turn = vi.hoisted(() => ({ refusal: null as string | null, noted: [] as unknown[][] }));
vi.mock('../../connectors/access/turn-gate.js', () => ({
  anotherAgentTurnRefusal: () => turn.refusal,
  noteMarkedTurnRefusal: (...args: unknown[]) => turn.noted.push(args),
}));
vi.mock('../../core/turn-power/turn-levels.js', async (original) => ({
  ...(await original<typeof import('../../core/turn-power/turn-levels.js')>()),
  lastTurnLevelOf: () => ({
    asks: 'always',
    reach: 'everything',
    teammate: [{ roomId: 'team', authorId: 'member' }],
  }),
  marksOf: () => ({ teammate: [{ roomId: 'team', authorId: 'member' }] }),
}));

const identity = { agentPath: '/agents/scout', displayName: 'Scout', createdAt: '2026-11-08' };
const context = { identity, sessionId: 'scout-chat' };
let approvals: ApprovalService;
let service: WorkQueueService;
let store: WorkQueueStore;
let registry: ReturnType<typeof composeRegistry>;
let db: ReturnType<typeof createTestDb>;
let preset: 'full' | 'careful' = 'full';

beforeEach(() => {
  turn.refusal = null;
  turn.noted = [];
  preset = 'full';
  db = createTestDb();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'queue-test', readOwnerAccount: () => null }),
  });
  store = new WorkQueueStore(db);
  service = new WorkQueueService({ store, holdOf: () => null, wake() {} });
  approvals = new ApprovalService(db);
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals });
  initPermissionGate({
    readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  });
  registry = composeRegistry([workQueueDomain], {
    logger: noopLogger,
    workQueueDeps: {
      service,
      agentIdForPath: () => 'scout',
      agentName: (id) =>
        ['scout', 'atlas'].includes(id) ? (id === 'scout' ? 'Scout' : 'Atlas') : undefined,
    },
  });
});
afterEach(() => {
  resetAuditTrail();
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
});

async function ask(id: string, input: unknown) {
  try {
    await registry.invoke(id, input, context);
    throw new Error('Action ran without asking');
  } catch (error) {
    if (!(error instanceof CapabilityGateRefusal) || error.decision.outcome !== 'approval_required')
      throw error;
    return error.decision.payload;
  }
}

async function allow(id: string, input: unknown) {
  const card = await ask(id, input);
  approvals.grant(card.approvalId);
  return registry.invoke(id, input, { ...context, approvalToken: card.approvalToken });
}

it('Careful queues for Full only after Ask, retaining the requester’s level, author and marks', async () => {
  preset = 'careful';
  const body = { agentId: 'atlas', title: 'Read the brief', prompt: 'Read the brief.' };
  const result = (await allow('work-queue.add', body)) as { item: { id: string } };
  expect(service.read('atlas').items).toHaveLength(1);
  expect(store.authority(result.item.id)).toMatchObject({
    authorAgentId: 'scout',
    authorSessionId: 'scout-chat',
  });
  expect(JSON.parse(store.authority(result.item.id)!.requestedLevel!)).toEqual({
    asks: 'always',
    reach: 'everything',
    teammate: [{ roomId: 'team', authorId: 'member' }],
  });
});

it('asks for queue-on, target increase and cap increase even at Full, binding each field', async () => {
  for (const changes of [{ enabled: true }, { target: 2 }, { dailyStartCap: 21 }]) {
    const body = { before: { enabled: false, target: 1, dailyStartCap: 20 }, changes };
    const card = await ask('work-queue.configure', body);
    expect(
      approvals.listPending().find((c) => c.approvalId === card.approvalId)?.alwaysOffered
    ).toBe(false);
  }
  expect(service.read('scout')).toMatchObject({ enabled: false, target: 1, dailyStartCap: 20 });
});

it('narrows and reorders without Ask at Careful, with no new start', async () => {
  preset = 'careful';
  service.update('scout', { enabled: true, target: 3, dailyStartCap: 30 });
  const a = service.add({ kind: 'person' }, 'scout', { title: 'A', prompt: 'A' });
  const b = service.add({ kind: 'person' }, 'scout', { title: 'B', prompt: 'B' });
  await registry.invoke('work-queue.reorder', { itemIds: [b.id, a.id] }, context);
  expect(service.read('scout').items.map((i) => i.id)).toEqual([b.id, a.id]);
  await registry.invoke('work-queue.remove', { id: a.id }, context);
  await registry.invoke(
    'work-queue.configure',
    {
      before: { enabled: true, target: 3, dailyStartCap: 30 },
      changes: { enabled: false, target: 1, dailyStartCap: 10 },
    },
    context
  );
  expect(service.read('scout')).toMatchObject({
    enabled: false,
    target: 1,
    dailyStartCap: 10,
    startsToday: 0,
  });
  expect(approvals.listPending()).toHaveLength(0);
});

it('a yes cannot cross targets, fields or a changed before-value', async () => {
  const body = {
    before: { enabled: false, target: 1, dailyStartCap: 20 },
    changes: { enabled: true },
  };
  const card = await ask('work-queue.configure', body);
  approvals.grant(card.approvalId);
  await expect(
    registry.invoke(
      'work-queue.configure',
      { ...body, agentId: 'atlas' },
      { ...context, approvalToken: card.approvalToken }
    )
  ).rejects.toBeInstanceOf(CapabilityGateRefusal);
  service.update('scout', { target: 2 });
  await expect(
    registry.invoke('work-queue.configure', body, { ...context, approvalToken: card.approvalToken })
  ).rejects.toMatchObject({ payload: { code: 'STALE_QUEUE' } });
  expect(service.read('scout').enabled).toBe(false);
});

it('never raises past the ceiling last set by a person, even with a yes', async () => {
  const result = await allow('work-queue.configure', {
    before: { enabled: false, target: 1, dailyStartCap: 20 },
    changes: { dailyStartCap: 21 },
  });
  expect(result).toMatchObject({ ok: false, code: 'CAP_CEILING' });
  expect(service.read('scout').dailyStartCap).toBe(20);
});

it.each(['GRANT_MARKED_TURN', 'GRANT_MARKS_UNREADABLE', 'GRANT_AGENT_STARTED'])(
  'refuses unsafe cross-agent setup before asking: %s',
  async (code) => {
    turn.refusal = code;
    await expect(
      registry.invoke('work-queue.add', { agentId: 'atlas', title: 'A', prompt: 'A' }, context)
    ).rejects.toMatchObject({ payload: { code } });
    expect(approvals.listPending()).toHaveLength(0);
    expect(service.read('atlas').items).toHaveLength(0);
    // DOR-4023: only a marked turn leaves the Full-autonomy Activity line.
    expect(turn.noted).toEqual(
      code === 'GRANT_MARKED_TURN'
        ? [
            [
              { sessionId: 'scout-chat', agentPath: '/agents/scout' },
              { id: 'work-queue.other_agent', title: "Change another agent's work queue" },
            ],
          ]
        : []
    );
  }
);

it('refuses an item from a different target queue', async () => {
  const item = service.add({ kind: 'person' }, 'atlas', { title: 'A', prompt: 'A' });
  await expect(
    registry.invoke('work-queue.remove', { id: item.id }, context)
  ).rejects.toMatchObject({ payload: { code: 'NOT_YOURS' } });
  expect(service.read('atlas').items).toHaveLength(1);
});

it('records requester, exact target and before/after for every mutation', async () => {
  await allow('work-queue.add', { agentId: 'atlas', title: 'A', prompt: 'A' });
  const [row] = db
    .select()
    .from(auditEvents)
    .all()
    .filter((r) => r.action === 'work-queue.add');
  expect(row).toMatchObject({
    actorKind: 'agent',
    actorName: 'Scout',
    targetId: 'atlas',
    outcome: 'ok',
  });
  expect(JSON.parse(row!.change!)).toMatchObject([
    { field: 'workQueue', before: null, after: { agentId: 'atlas', title: 'A' } },
  ]);
});

it('lowering a cap preserves the person-set ceiling for a later approved increase', async () => {
  service.update('scout', { dailyStartCap: 80 });
  service.update('scout', { dailyStartCap: 10 }, { agent: true });
  await allow('work-queue.configure', {
    before: { enabled: false, target: 1, dailyStartCap: 10 },
    changes: { dailyStartCap: 50 },
  });
  expect(service.read('scout').dailyStartCap).toBe(50);
  expect(store.settings('scout').dailyCapCeiling).toBe(80);
});

it('explicit requeue asks even at Full before starting a new run', async () => {
  const item = service.add({ kind: 'person' }, 'scout', { title: 'Read', prompt: 'Read.' });
  store.markEnded(item.id, { outcome: 'finished', note: null, endedAt: '2026-11-08' });
  const card = await ask('work-queue.requeue', { id: item.id });
  expect(service.read('scout').recent[0]?.id).toBe(item.id);
  approvals.grant(card.approvalId);
  await registry.invoke(
    'work-queue.requeue',
    { id: item.id },
    { ...context, approvalToken: card.approvalToken }
  );
  expect(service.read('scout').items[0]).toMatchObject({
    id: item.id,
    state: 'queued',
    addedBy: 'person',
  });
});
