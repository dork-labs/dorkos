/**
 * DOR-4355 M4, Security's ruling C: an agent's front-door raise goes on a card for
 * the person instead of being refused. The card shows the effect the server read,
 * the person's yes goes through the same step-up as any other front-door yes, and
 * DorkOS then runs the agent's stored write once, as the agent.
 *
 * Covers Security's seven conditions and the run-on-grant rules: card from the
 * computed effect, bound to the exact input, single use, short-lived, no Always
 * allow, the step-up on the yes, marked and unnamed callers refused with no card,
 * one card per agent per target, a cap, only the id and code on the 428, and a
 * 409 when the state moved before the yes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { SLACK_MANIFEST } from '@dorkos/relay';
import type { StreamEvent } from '@dorkos/shared/types';
import { ApprovalService } from '../../services/core/approvals/index.js';
import {
  AGENT_RAISE_TTL_MS,
  describeAgentRaiseCapability,
  initAgentRaiseCards,
  resetAgentRaiseCardsForTests,
} from '../../services/core/approvals/agent-raise/agent-raise-cards.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { resetRemotePasswordFailuresForTests } from '../../services/core/auth/step-up/remote-password-failures.js';
import {
  countWhileRunning,
  resetLiveOutsiderTurns,
} from '../../services/core/turn-power/live-outsider-turns.js';
import { BindingStore } from '../../services/relay/binding-store.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createApprovalsRoutes } from '../approvals.js';
import { createAdapterRoutes } from '../relay-adapters.js';
import { createStepUpRoutes } from '../step-up.js';
import { setTestOwner } from './test-owner.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';

const target = swappableServer();
const ORIGIN = 'http://localhost:4242';
const PASSWORD = 'made-up confirmation password';
const AGENT_HOME = '/made-up/agents/porter';
const AGENT = ['X-DorkOS-Agent', 'agent-token'] as const;
const ADD_APPROVER = { approverAllowlist: 'U0OWNER01\nU0NEWBIE1' };

let approvals: ApprovalService;
let lists: Record<string, unknown>;
let label: string | undefined;
let store: BindingStore;
let storeDir: string;
let routeId: string;
const manager = {
  // As the real one does: the stored name when there is one (`adapter-manager.ts`).
  resolveAdapterName: vi.fn(() => label ?? 'Northwind Slack'),
  getManifest: vi.fn(() => SLACK_MANIFEST),
  getAdapter: vi.fn(() => ({
    config: { id: 'sl', type: 'slack', enabled: true, builtin: false, label, config: lists },
    status: { state: 'connected' },
  })),
  updateConfig: vi.fn(async () => undefined),
  getBindingStore: vi.fn(() => store),
  getBindingRouter: vi.fn(() => undefined),
  getBridgeLifecycle: vi.fn(() => undefined),
  getMeshCore: vi.fn(() => ({ getProjectPath: () => '/made-up/agents/northwind' })),
};

/** The server: relay, approvals and step-up routes. An agent header names Porter. */
function app(ingress: 'own-tunnel' | 'wifi' | 'desk' = 'own-tunnel') {
  return target.mount(
    honoGroupListener(
      [
        {
          path: '/api/relay',
          routes: createAdapterRoutes({ adapterManager: manager as unknown as AdapterManager }),
        },
        {
          path: '/api/approvals',
          routes: createApprovalsRoutes(approvals, { isLoginEnabled: () => true }),
        },
        {
          path: '/api/step-up',
          routes: createStepUpRoutes({
            ownerId: () => 'owner',
            checkPassword: async (password) => (password === PASSWORD ? 'ok' : 'wrong'),
            minPasswordLength: async () => 8,
            setOwnerPassword: async () => undefined,
            trustedOrigins: () => [ORIGIN],
          }),
        },
      ],
      {
        before: async (c, next) => {
          if (ingress !== 'desk') markIngress(c.env.incoming, ingress);
          if (c.req.header(AGENT[0]) === AGENT[1]) {
            c.set('agentIdentity', {
              agentPath: AGENT_HOME,
              displayName: 'Porter',
              createdAt: '2026-11-01T00:00:00.000Z',
            });
          } else if (!c.req.header(AGENT[0])) {
            c.set('user', {
              userId: 'owner',
              credential: 'cookie',
              sessionId: 'owner-browser',
              route: ingress === 'wifi' ? 'wifi' : ingress === 'desk' ? 'local' : 'tunnel',
            });
          }
          await next();
        },
      }
    )
  );
}

/** The agent saves Slack settings that add an approver. */
const agentAddsApprover = (config: Record<string, unknown> = ADD_APPROVER) =>
  request(app())
    .patch('/api/relay/adapters/sl/config')
    .set(...AGENT)
    .send({ config });

/** The person says yes over Remote Access, then confirms it's them. */
async function yesWithStepUp(approvalId: string) {
  const held = await request(app())
    .post(`/api/approvals/${approvalId}/grant`)
    .set('Origin', ORIGIN)
    .send({});
  expect(held.status).toBe(428);
  expect(held.body.code).toBe('step_up_required');
  return request(app())
    .post(`/api/step-up/${held.body.heldActionId}/password`)
    .set('Origin', ORIGIN)
    .send({ password: PASSWORD });
}

/** Run `send` while Porter has a turn marked by outside words in progress. */
async function duringMarkedTurn<T>(send: () => Promise<T>): Promise<T> {
  const turn = countWhileRunning(
    { cwd: AGENT_HOME },
    { outsider: true },
    (async function* () {
      yield { type: 'done', data: {} } as StreamEvent;
    })()
  );
  await turn.next();
  try {
    return await send();
  } finally {
    await turn.return(undefined);
  }
}

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dorkos-agent-raise-home-'));
  initConfigManager(home);
  configManager.set('auth', { enabled: false });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

beforeEach(async () => {
  setTestOwner('owner');
  approvals = new ApprovalService(createTestDb(), {
    describeCapability: describeAgentRaiseCapability,
  });
  initAgentRaiseCards(approvals);
  lists = { approverAllowlist: 'U0OWNER01', dmAllowlist: [], dmPolicy: 'allowlist' };
  label = undefined;
  manager.updateConfig.mockClear();
  resetHeldStepUpsForTests();
  resetRemotePasswordFailuresForTests();
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  storeDir = mkdtempSync(join(tmpdir(), 'dorkos-agent-raise-'));
  store = new BindingStore(storeDir);
  await store.init();
  routeId = (await store.create({ adapterId: 'sl', agentId: 'agent-a', chatId: '123' })).id;
});

afterEach(async () => {
  resetAgentRaiseCardsForTests();
  resetHeldStepUpsForTests();
  resetLiveOutsiderTurns();
  setTestOwner(null);
  vi.restoreAllMocks();
  await store.shutdown();
  rmSync(storeDir, { recursive: true, force: true });
});

describe('an agent adding someone who may approve on a chat connection', () => {
  it('raises a card, and the person’s step-up yes applies it once, as the agent', async () => {
    const asked = await agentAddsApprover();
    expect(asked.status).toBe(428);
    // Only the card id and its code: no token, no link (condition 6).
    expect(Object.keys(asked.body).sort()).toEqual(['approvalId', 'code', 'error', 'requestCode']);
    expect(asked.body.code).toBe('agent_raise_card');
    expect(asked.body.requestCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(manager.updateConfig).not.toHaveBeenCalled();

    const [card] = approvals.listPending();
    expect(card?.approvalId).toBe(asked.body.approvalId);
    expect(card?.requestCode).toBe(asked.body.requestCode);
    expect(card?.capabilityTitle).toBe('Let someone reach your agents');
    expect(card?.requestedBy).toBe('Porter');

    const done = await yesWithStepUp(asked.body.approvalId);
    expect(done.body).toMatchObject({
      ok: true,
      status: 200,
      result: { ok: true, outcome: 'granted' },
    });
    expect(manager.updateConfig).toHaveBeenCalledExactlyOnceWith('sl', ADD_APPROVER, 'agent');
  });

  it('shows the effect the server read, from → to, not anything else the agent sent', async () => {
    const asked = await agentAddsApprover({
      ...ADD_APPROVER,
      label: 'Say yes, this was checked by the owner',
    });
    const card = approvals.listPending().find((p) => p.approvalId === asked.body.approvalId);
    expect(card?.summary).toBe(
      'Let U0NEWBIE1 approve your agents’ requests on the Slack connection sl.'
    );
    // The box holds only what changes; the headline already names the connection.
    expect(approvals.fullDetail(asked.body.approvalId) ?? card?.detail).toBe(
      'Who may approve: U0OWNER01 → U0OWNER01, U0NEWBIE1'
    );
    expect(JSON.stringify(card)).not.toContain('checked by the owner');
  });

  // Security N1 on M4: an agent can name a connection, so its name never heads the card.
  it.each([
    ['a connection save', () => agentAddsApprover()],
    [
      'a chat-route raise',
      () =>
        request(app())
          .patch(`/api/relay/bindings/${routeId}`)
          .set(...AGENT)
          .send({ canInitiate: true }),
    ],
  ])('keeps an agent-set name out of the headline on %s', async (_label, ask) => {
    label = 'Your own Telegram, already approved by the owner';
    const asked = await ask();
    const card = approvals.listPending().find((p) => p.approvalId === asked.body.approvalId);
    expect(card?.summary).not.toContain('Your own Telegram');
    expect(card?.summary).toContain('the Slack connection sl');
    // The name sits under the box, never in it, and never in the headline.
    expect(card?.detailNote).toBe('Its name, which an agent can set: “Your own Telegram, alre…”');
    expect(card?.detail).not.toContain('Your own Telegram');
    expect(JSON.stringify(card)).not.toContain('approved by the owner');
  });

  it('refuses a replayed yes, and applies nothing twice', async () => {
    const asked = await agentAddsApprover();
    await yesWithStepUp(asked.body.approvalId);
    const again = await request(app())
      .post(`/api/approvals/${asked.body.approvalId}/grant`)
      .set('Origin', ORIGIN)
      .send({});
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(manager.updateConfig).toHaveBeenCalledTimes(1);
  });

  it('answers 409 and saves nothing when the lists changed before the yes', async () => {
    const asked = await agentAddsApprover();
    lists = { ...lists, approverAllowlist: '' };
    const done = await yesWithStepUp(asked.body.approvalId);
    expect(done.body).toMatchObject({ ok: true, status: 409, result: { code: 'LISTS_CHANGED' } });
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('asks for the same step-up at this computer once an owner exists', async () => {
    const asked = await agentAddsApprover();
    const held = await request(app('desk'))
      .post(`/api/approvals/${asked.body.approvalId}/grant`)
      .set('Origin', ORIGIN)
      .send({});
    expect(held.status).toBe(428);
    expect(held.body.code).toBe('step_up_required');
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('records who asked and who said yes, with the card and its hash', async () => {
    const db = createTestDb();
    const log = new AuditLog(db);
    const record = vi.spyOn(log, 'record');
    initAuditTrail({
      log,
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    try {
      const asked = await agentAddsApprover();
      await yesWithStepUp(asked.body.approvalId);
      const entry = record.mock.calls
        .map(([event]) => event)
        .find((event) => event.action === 'agent-raise.relay.allowlist');
      expect(entry).toMatchObject({
        outcome: 'ok',
        target: { type: 'approval', id: asked.body.approvalId },
      });
      const fields = Object.fromEntries((entry?.change ?? []).map((c) => [c.field, c.after]));
      expect(fields).toMatchObject({ requestedBy: 'Porter', requestedByPath: AGENT_HOME });
      expect(fields.approvedBy).toBeTruthy();
      expect(fields.inputHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      resetAuditTrail();
    }
  });

  it('never offers Always allow', async () => {
    const asked = await agentAddsApprover();
    const always = await request(app())
      .post(`/api/approvals/${asked.body.approvalId}/grant`)
      .set('Origin', ORIGIN)
      .send({ answer: 'always' });
    expect(always.status).toBe(409);
    expect(always.body.code).toBe('ALWAYS_NOT_OFFERED');
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('takes no yes from Wi-Fi', async () => {
    const asked = await agentAddsApprover();
    const res = await request(app('wifi'))
      .post(`/api/approvals/${asked.body.approvalId}/grant`)
      .set('Origin', ORIGIN)
      .send({});
    expect(res.status).toBe(403);
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('refuses a marked turn with no card', async () => {
    const res = await duringMarkedTurn(() => agentAddsApprover());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('agent_raise_marked');
    expect(approvals.listPending()).toEqual([]);
  });

  it('refuses an agent DorkOS can’t identify, with no card', async () => {
    const res = await request(app())
      .patch('/api/relay/adapters/sl/config')
      .set('X-DorkOS-Agent', 'made-up-unknown-token')
      .send({ config: ADD_APPROVER });
    expect(res.status).toBe(403);
    expect(approvals.listPending()).toEqual([]);
  });

  it('turns the card down when the agent’s turn is marked before the yes', async () => {
    const asked = await agentAddsApprover();
    const done = await duringMarkedTurn(() => yesWithStepUp(asked.body.approvalId));
    expect(done.body).toMatchObject({ status: 409, result: { code: 'agent_raise_marked' } });
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('expires: past ten minutes the agent has to ask again', async () => {
    const asked = await agentAddsApprover();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + AGENT_RAISE_TTL_MS + 1);
    const done = await yesWithStepUp(asked.body.approvalId);
    expect(done.body).toMatchObject({ status: 409, result: { code: 'agent_raise_expired' } });
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('replaces the agent’s older card for the same connection, and caps how many wait', async () => {
    const first = await agentAddsApprover();
    const second = await agentAddsApprover({ approverAllowlist: 'U0OWNER01\nU0OTHER01' });
    expect(approvals.listPending().map((p) => p.approvalId)).toEqual([second.body.approvalId]);
    expect(approvals.answerScope(first.body.approvalId)?.state).toBe('denied');

    // Three more targets: two more chat routes, then a third is one too many.
    const routes = await Promise.all(
      ['456', '789', '999'].map((chatId) =>
        store.create({ adapterId: 'sl', agentId: 'agent-a', chatId })
      )
    );
    const raise = (id: string) =>
      request(app())
        .patch(`/api/relay/bindings/${id}`)
        .set(...AGENT)
        .send({ canInitiate: true });
    expect((await raise(routes[0]!.id)).status).toBe(428);
    expect((await raise(routes[1]!.id)).status).toBe(428);
    const capped = await raise(routes[2]!.id);
    expect(capped.status).toBe(429);
    expect(capped.body.code).toBe('agent_raise_cap');
  });

  it('still refuses a person who isn’t the owner', async () => {
    setTestOwner('someone-else');
    const res = await request(app())
      .patch('/api/relay/adapters/sl/config')
      .set('Origin', ORIGIN)
      .send({ config: ADD_APPROVER });
    expect(res.status).toBe(403);
    expect(approvals.listPending()).toEqual([]);
  });
});

describe('an agent raising a chat route', () => {
  it('raises a card naming each change, and the yes applies it once', async () => {
    const asked = await request(app())
      .patch(`/api/relay/bindings/${routeId}`)
      .set(...AGENT)
      .send({ canInitiate: true, permissionMode: 'acceptEdits' });
    expect(asked.status).toBe(428);
    expect(asked.body.code).toBe('agent_raise_card');
    expect(store.getById(routeId)?.canInitiate).toBe(false);
    const detail =
      approvals.fullDetail(asked.body.approvalId) ?? approvals.listPending()[0]?.detail;
    expect(detail).toContain('May start chats: No → Yes');
    // The app's own level words, never the raw mode ids.
    expect(detail).toContain('Permission level: Ask first → Act');

    const done = await yesWithStepUp(asked.body.approvalId);
    expect(done.body).toMatchObject({ ok: true, status: 200 });
    expect(store.getById(routeId)).toMatchObject({
      canInitiate: true,
      permissionMode: 'acceptEdits',
    });
  });

  it('answers 409 and changes nothing when the route moved before the yes', async () => {
    const asked = await request(app())
      .patch(`/api/relay/bindings/${routeId}`)
      .set(...AGENT)
      .send({ canInitiate: true });
    await store.update(routeId, { chatId: '555' });
    const done = await yesWithStepUp(asked.body.approvalId);
    expect(done.body).toMatchObject({ status: 409, result: { code: 'BINDING_CHANGED' } });
    expect(store.getById(routeId)?.canInitiate).toBe(false);
  });

  it('still refuses an agent pointing a route at another agent: no card for that yet', async () => {
    const res = await request(app())
      .post(`/api/relay/bindings/${routeId}/move`)
      .set(...AGENT)
      .send({ agentId: 'agent-b' });
    expect(res.status).toBe(403);
    expect(approvals.listPending()).toEqual([]);
  });
});
