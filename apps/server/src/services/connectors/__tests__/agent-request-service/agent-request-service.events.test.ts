import { describe, expect, it, vi } from 'vitest';
import { connectionOperationGrants, connectorReviewRequests } from '@dorkos/db';
import type { ConnectorEventGrantPort } from '../../events/grant-port.js';
import {
  OWNER,
  NOW,
  CONNECTION_ID,
  INPUT,
  CURRENT_ACCESS,
  EVENT_SCOPE,
  describeAsMessageReceived,
  principal,
  useAgentRequestHarness,
  requestRow,
} from './agent-request-service.fixtures.js';

/** Answers that include event updates: exact definitions, races, and taking an answer back. */
describe('ConnectorAgentRequestService', () => {
  const h = useAgentRequestHarness();

  it('derives proposed event types from exact definitions and waits for the same review receipt', async () => {
    const eventInput = {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    };
    let ready = false;
    const describe: ConnectorEventGrantPort['describe'] = (_owner, scopes) =>
      scopes.map((scope) => ({
        definitionId: scope.definitionId,
        eventType: 'gmail.message_received',
      }));
    const approve: ConnectorEventGrantPort['approve'] = async (_owner, review) => {
      const selections = review.scopes.map((scope) => ({
        subscriptionId: 'subscription-1',
        scopeVersion: 1,
        definitionId: scope.definitionId,
        eventScopeHash: 'a'.repeat(64),
      }));
      return ready
        ? { state: 'ready', selections, appliedEventScopeHash: 'b'.repeat(64) }
        : { state: 'pending', selections };
    };
    const eventGrants: ConnectorEventGrantPort = {
      describe: vi.fn(describe),
      approve: vi.fn(approve),
      ready: vi.fn(() => ready),
      withdraw: vi.fn(),
    };
    const requests = h.service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), eventInput);
    h.grantLive(['revision-read']);
    const eventScope = EVENT_SCOPE;

    await expect(
      requests.resolve(OWNER, created.requestId, {
        ...CURRENT_ACCESS,
        eventScopes: [{ ...eventScope, agentId: 'agent-other' }],
      })
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(eventGrants.approve).not.toHaveBeenCalled();
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

    const pending = await requests.resolve(OWNER, created.requestId, {
      ...CURRENT_ACCESS,
      eventScopes: [eventScope],
    });
    expect(pending).toMatchObject({
      status: 'access_pending',
      note: expect.stringContaining('still setting up your access to Gmail'),
    });
    expect(pending.note).toContain("don't ask again or promise the person a time");
    expect(eventGrants.approve).toHaveBeenLastCalledWith(
      OWNER,
      expect.objectContaining({
        reviewId: expect.stringMatching(/^id-/),
        scopes: [eventScope],
      }),
      expect.any(AbortSignal)
    );

    ready = true;
    await expect(requests.reconcile()).resolves.toEqual({
      expired: 0,
      accepted: 0,
      cancelled: 0,
    });
    await expect(requests.getForRuntime(principal(), created.requestId)).resolves.toMatchObject({
      status: 'granted',
      grantedEvents: ['gmail.message_received'],
    });
    const stored = requestRow(h.db, created.requestId);
    expect(JSON.parse(stored!.resolvedEventsJson!)).toEqual({
      appliedEventScopeHash: 'b'.repeat(64),
      selections: [
        {
          definitionId: 'definition-1',
          eventScopeHash: 'a'.repeat(64),
          scopeVersion: 1,
          subscriptionId: 'subscription-1',
        },
      ],
      version: 1,
    });
  });

  it('keeps a losing concurrent event decision free of authority side effects', async () => {
    let releaseFirstOrigin!: () => void;
    const firstOriginGate = new Promise<void>((resolve) => {
      releaseFirstOrigin = resolve;
    });
    let firstOriginEntered!: () => void;
    const firstOriginStarted = new Promise<void>((resolve) => {
      firstOriginEntered = resolve;
    });
    let originChecks = 0;
    vi.mocked(h.authority.revalidateOrigin).mockImplementation(async () => {
      originChecks += 1;
      if (originChecks === 1) {
        firstOriginEntered();
        await firstOriginGate;
      }
      return true;
    });
    let eventAuthorityWrites = 0;
    const eventScope = EVENT_SCOPE;
    const eventGrants: ConnectorEventGrantPort = {
      describe: describeAsMessageReceived(),
      approve: vi.fn(async () => {
        eventAuthorityWrites += 1;
        return {
          state: 'pending' as const,
          selections: [
            {
              subscriptionId: 'subscription-1',
              scopeVersion: 1,
              definitionId: eventScope.definitionId,
              eventScopeHash: 'a'.repeat(64),
            },
          ],
        };
      }),
      ready: vi.fn(() => false),
      withdraw: vi.fn(),
    };
    const requests = h.service({ eventGrants, resume: undefined });
    const created = await requests.create(principal(), {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    });
    h.grantLive(['revision-read']);
    const eventDecision = requests.resolve(OWNER, created.requestId, {
      ...CURRENT_ACCESS,
      eventScopes: [eventScope],
    });
    await firstOriginStarted;

    await expect(requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)).resolves.toMatchObject(
      { status: 'granted', grantedEvents: [] }
    );
    releaseFirstOrigin();
    await expect(eventDecision).rejects.toMatchObject({ code: 'request_already_resolved' });

    expect(eventAuthorityWrites).toBe(0);
    expect(h.db.select().from(connectionOperationGrants).all()).toHaveLength(1);
    expect(requests.getForOwner(OWNER, created.requestId)).toMatchObject({
      status: 'granted',
      grantedEvents: [],
    });
  });

  describe('taking a pick back leaves the person’s own updates as they were (fix round 3)', () => {
    function subscriptionRow(id: string) {
      return h.db.$client
        .prepare(
          'SELECT scope_version, enabled, revoked_at, removed_at FROM connector_event_subscriptions WHERE id = ?'
        )
        .get(id) as {
        scope_version: number;
        enabled: number;
        revoked_at: string | null;
        removed_at: string | null;
      };
    }

    it('never touches a generation the owner changed after the pick', async () => {
      const fixture = h.realEventGrants(1);
      const signal = new AbortController().signal;
      // An agent's pick switches a new update on.
      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      const picked = h.db.$client
        .prepare('SELECT id, scope_version FROM connector_event_subscriptions')
        .get() as { id: string; scope_version: number };
      // The owner then sets the same update up again on the page: a new generation.
      await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      const edited = subscriptionRow(picked.id);
      expect(edited.scope_version).toBe(picked.scope_version + 1);

      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());

      expect(subscriptionRow(picked.id)).toEqual(edited);
      expect(fixture.store.active(picked.id, edited.scope_version)).toBeDefined();
    });
  });

  describe('updates that cannot be set up (fix round 1)', () => {
    const eventScope = EVENT_SCOPE;

    function eventPort(state: () => 'ready' | 'pending' | 'unavailable'): ConnectorEventGrantPort {
      return {
        describe: describeAsMessageReceived(),
        approve: vi.fn<ConnectorEventGrantPort['approve']>(async (_owner, review) => {
          const selections = review.scopes.map((scope) => ({
            subscriptionId: 'subscription-1',
            scopeVersion: 1,
            definitionId: scope.definitionId,
            eventScopeHash: 'a'.repeat(64),
          }));
          const now = state();
          if (now === 'ready') {
            return { state: 'ready', selections, appliedEventScopeHash: 'b'.repeat(64) };
          }
          return now === 'pending'
            ? { state: 'pending', selections }
            : { state: 'unavailable', selections: [] };
        }),
        ready: vi.fn(() => state() === 'ready'),
        withdraw: vi.fn(),
      };
    }

    it('takes the answer back when the updates are unavailable, so the person can still choose', async () => {
      const eventGrants = eventPort(() => 'unavailable');
      const requests = h.service({ eventGrants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received'],
      });
      h.grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, { ...CURRENT_ACCESS, eventScopes: [eventScope] })
      ).rejects.toMatchObject({ code: 'event_selection_unavailable' });
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

      // The same answer again is tried again, not refused as already answered.
      await expect(
        requests.resolve(OWNER, created.requestId, { ...CURRENT_ACCESS, eventScopes: [eventScope] })
      ).rejects.toMatchObject({ code: 'event_selection_unavailable' });
      // Answering without updates works, and says so to the agent.
      await expect(
        requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)
      ).resolves.toMatchObject({
        status: 'granted',
        grantedEvents: [],
        note: expect.stringContaining("You won't get updates when something new happens in Gmail."),
      });
    });
  });

  describe('taking back an answer stops its updates (fix round 2)', () => {
    const EVENTS = ['gmail.event_0', 'gmail.event_1'];

    function liveSubscriptions(): number {
      return (
        h.db.$client
          .prepare(
            'SELECT COUNT(*) AS count FROM connector_event_subscriptions WHERE enabled = 1 AND revoked_at IS NULL'
          )
          .get() as { count: number }
      ).count;
    }

    function consentCommands(): number {
      return (
        h.db.$client
          .prepare('SELECT COUNT(*) AS count FROM connector_event_consent_commands')
          .get() as { count: number }
      ).count;
    }

    it('stops the first update switched on when the second fails, so Not now means none arrive', async () => {
      // The trigger at the service fails for the second scope, after the first
      // was already switched on.
      const { grants, scopes } = h.realEventGrants(2, {
        reconcileTrigger: (call) => {
          if (call === 1) throw new Error('service dropped the second trigger');
        },
      });
      const requests = h.service({ eventGrants: grants, resume: undefined });
      const created = await requests.create(principal(), { ...INPUT, requestedEvents: EVENTS });
      h.grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, { ...CURRENT_ACCESS, eventScopes: scopes })
      ).rejects.toThrow('service dropped the second trigger');
      expect(liveSubscriptions()).toBe(0);
      expect(consentCommands()).toBe(0);
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({ status: 'denied' });
      expect(liveSubscriptions()).toBe(0);
    });

    it('never leaves a request answered on one side and unanswered on the other when answers race', async () => {
      // Two identical answers: the first's updates come back unavailable while
      // the second's come back ready after the first took the answer back.
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      let calls = 0;
      const withdraw = vi.fn<ConnectorEventGrantPort['withdraw']>();
      const eventGrants: ConnectorEventGrantPort = {
        describe: (_owner, scopes) =>
          scopes.map((scope) => ({ definitionId: scope.definitionId, eventType: 'gmail.event_0' })),
        approve: vi.fn<ConnectorEventGrantPort['approve']>(async (_owner, review) => {
          const call = calls++;
          const selections = review.scopes.map((scope) => ({
            subscriptionId: 'subscription-1',
            scopeVersion: 1,
            definitionId: scope.definitionId,
            eventScopeHash: 'a'.repeat(64),
          }));
          if (call === 0) return { state: 'unavailable', selections: [] };
          await secondGate;
          return { state: 'ready', selections, appliedEventScopeHash: 'b'.repeat(64) };
        }),
        ready: () => true,
        withdraw,
      };
      const requests = h.service({ eventGrants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      h.grantLive(['revision-read']);
      const decision = {
        decision: 'current_access' as const,
        connectionId: CONNECTION_ID,
        eventScopes: [
          {
            connectionId: CONNECTION_ID,
            definitionId: 'definition-0',
            filter: {},
            agentId: 'agent-1',
            destination: { kind: 'agent' as const, id: 'agent-1' },
          },
        ],
      };

      // Settled from the start, so the early refusal is never an unhandled rejection.
      const answers = Promise.allSettled([
        requests.resolve(OWNER, created.requestId, decision),
        requests.resolve(OWNER, created.requestId, decision),
      ]);
      // Let the unavailable one take the answer back before the other finishes.
      await expect.poll(() => withdraw.mock.calls.length).toBeGreaterThanOrEqual(1);
      releaseSecond();
      const settled = await answers;
      // Neither is passed off as a success over a request that reads as unanswered.
      for (const outcome of settled) {
        expect(outcome).toMatchObject({
          status: 'rejected',
          reason: expect.objectContaining({ code: 'event_selection_unavailable' }),
        });
      }

      const item = requests.getForOwner(OWNER, created.requestId);
      expect(item.status).toBe('awaiting_owner');
      const review = h.db.select().from(connectorReviewRequests).get()!;
      expect(review).toMatchObject({ state: 'pending', resolutionJson: null });
      // What the late approval switched on is stopped too.
      expect(withdraw.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('the stored approval a set of updates is read from', () => {
    async function pageThenAgent() {
      const fixture = h.realEventGrants(2);
      const signal = new AbortController().signal;
      // Review ids chosen so the page's single-update review is read first.
      const page = await fixture.grants.approve(
        OWNER,
        { reviewId: 'a-page-review', scopes: [fixture.scopes[0]!] },
        signal
      );
      const agent = await fixture.grants.approve(
        OWNER,
        { reviewId: 'z-agent-review', scopes: fixture.scopes },
        signal
      );
      if (page.state !== 'ready' || agent.state !== 'ready') throw new Error('not ready');
      return { fixture, page, agent };
    }

    it('answers a set only from a review of exactly that set', async () => {
      const { fixture, page, agent } = await pageThenAgent();
      // The agent's pick used the page's live update as it is.
      expect(agent.selections).toContainEqual(page.selections[0]);

      const forAgent = fixture.store.approvedSelections(OWNER, agent.selections);
      expect(forAgent?.map((item) => item.selection)).toHaveLength(2);
      expect(fixture.grants.ready(OWNER, agent.selections, agent.appliedEventScopeHash)).toBe(true);
      // The page's review of one update never answers for the agent's two, and
      // the agent's review of two never answers for the page's one.
      expect(
        fixture.store.approvedSelections(OWNER, page.selections)?.map((item) => item.selection)
      ).toEqual(page.selections);
      expect(fixture.grants.ready(OWNER, page.selections, page.appliedEventScopeHash)).toBe(true);
    });

    it('never reads another owner’s stored approval', async () => {
      const { fixture, agent } = await pageThenAgent();
      // The agent's review, moved under another owner: nothing of this owner's
      // names that set any more.
      h.db.$client
        .prepare(
          "UPDATE connector_event_consent_commands SET owner_id = 'someone-else' WHERE review_id = 'z-agent-review'"
        )
        .run();
      expect(fixture.store.approvedSelections(OWNER, agent.selections)).toBeUndefined();
      expect(fixture.grants.ready(OWNER, agent.selections, agent.appliedEventScopeHash)).toBe(
        false
      );
    });
  });
});
