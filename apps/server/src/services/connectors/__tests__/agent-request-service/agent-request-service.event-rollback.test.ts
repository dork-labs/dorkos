import { describe, expect, it, vi } from 'vitest';
import { connectorReviewRequests } from '@dorkos/db';
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
} from './agent-request-service.fixtures.js';

/** Taking an answer back when its event updates cannot be set up, and leaving the person's own updates as they were. */
describe('ConnectorAgentRequestService', () => {
  const h = useAgentRequestHarness();

  describe('taking a pick back leaves the person’s own updates as they were (fix round 3)', () => {
    /** The person's own update, set up the way the page does: an owner review. */
    async function personUpdate(fixture: ReturnType<typeof h.realEventGrants>) {
      const result = await fixture.grants.approve(
        OWNER,
        { reviewId: 'person-page-review', scopes: [fixture.scopes[0]!] },
        new AbortController().signal
      );
      expect(result.state).toBe('ready');
      return { id: result.selections[0]!.subscriptionId };
    }

    async function failedPick(
      fixture: ReturnType<typeof h.realEventGrants>,
      eventScopes: typeof fixture.scopes
    ) {
      const requests = h.service({ eventGrants: fixture.grants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0', 'gmail.event_1'],
      });
      h.grantLive(['revision-read']);
      await expect(
        requests.resolve(OWNER, created.requestId, { ...CURRENT_ACCESS, eventScopes })
      ).rejects.toThrow();
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({ status: 'denied' });
    }

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

    it('uses the person’s live update as it is, and it stays live after the pick fails', async () => {
      // The reviewer's probe: event_0 is live at v1; the agent's pick of both
      // updates fails after the review was prepared.
      let failSecond = false;
      const fixture = h.realEventGrants(2, {
        reconcileTrigger: (_call, eventType) => {
          if (failSecond && eventType === 'gmail.event_1') throw new Error('second trigger failed');
        },
      });
      const own = await personUpdate(fixture);
      const before = subscriptionRow(own.id);
      failSecond = true;

      await failedPick(fixture, fixture.scopes);

      expect(subscriptionRow(own.id)).toEqual(before);
      expect(fixture.store.active(own.id, before.scope_version)).toBeDefined();
    });

    it('counts the person’s live update as set up, without taking it over', async () => {
      const fixture = h.realEventGrants(1);
      // Set up on the page, so a review already selected it.
      const own = await personUpdate(fixture);
      const before = subscriptionRow(own.id);
      const requests = h.service({ eventGrants: fixture.grants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      h.grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: fixture.scopes,
        })
      ).resolves.toMatchObject({ status: 'granted', grantedEvents: ['gmail.event_0'] });
      expect(subscriptionRow(own.id)).toEqual(before);
    });

    it('puts back a taken-over update even when it had been stopped', async () => {
      const fixture = h.realEventGrants(1, { authorize: () => true });
      const signal = new AbortController().signal;
      const own = await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      fixture.store.revoke(OWNER, own.id, NOW.toISOString());
      const before = subscriptionRow(own.id);
      expect(before.revoked_at).not.toBeNull();

      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      expect(subscriptionRow(own.id).revoked_at).toBeNull();
      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());

      // Stopped again, exactly as before: this account is not managed, so its
      // own generation comes back.
      expect(subscriptionRow(own.id)).toEqual(before);
    });

    it('gives a pending update back its own generation, so its recovery resumes it', async () => {
      let failFirst = true;
      const fixture = h.realEventGrants(1, {
        reconcileTrigger: () => {
          if (failFirst) throw new Error('the service did not answer');
        },
      });
      const signal = new AbortController().signal;
      // The person's update is still pending: its first switch-on failed.
      await expect(
        fixture.grants.approve(
          OWNER,
          { reviewId: 'person-page-review', scopes: fixture.scopes },
          signal
        )
      ).rejects.toThrow('the service did not answer');
      const own = h.db.$client.prepare('SELECT id FROM connector_event_subscriptions').get() as {
        id: string;
      };
      const before = subscriptionRow(own.id);
      expect(before).toMatchObject({ scope_version: 1, enabled: 0, revoked_at: null });
      failFirst = false;

      // An agent's pick takes it over (it is not live) and is then taken back.
      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      expect(subscriptionRow(own.id).scope_version).toBe(2);
      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());
      expect(subscriptionRow(own.id)).toEqual(before);

      // The person's own review names that generation again, so recovery resumes it.
      await expect(fixture.grants.recoverPending(signal)).resolves.toEqual({
        examined: 1,
        ready: 1,
      });
      expect(subscriptionRow(own.id)).toMatchObject({ scope_version: 1, enabled: 1 });
      expect(fixture.store.active(own.id, 1)).toBeDefined();
    });

    it('never puts back a taken-over update the owner changed after the pick', async () => {
      const fixture = h.realEventGrants(1);
      const signal = new AbortController().signal;
      const own = await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      fixture.store.revoke(OWNER, own.id, NOW.toISOString());
      // The pick takes the stopped update over.
      await expect(
        fixture.grants.approve(OWNER, { reviewId: 'review-1', scopes: fixture.scopes }, signal)
      ).resolves.toMatchObject({ state: 'ready' });
      // The owner then sets it up again on the page: a newer generation.
      await fixture.subscriptions.create(OWNER, fixture.scopes[0]!, signal);
      const edited = subscriptionRow(own.id);

      fixture.grants.withdraw(OWNER, 'review-1', NOW.toISOString());

      expect(subscriptionRow(own.id)).toEqual(edited);
      expect(fixture.store.active(own.id, edited.scope_version)).toBeDefined();
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

    it('ends an answer whose updates never become live, and stops holding the app open', async () => {
      const requests = h.service({
        eventGrants: eventPort(() => 'pending'),
        resume: undefined,
        requestTtlMs: 60_000,
      });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received'],
      });
      h.grantLive(['revision-read']);
      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [eventScope],
        })
      ).resolves.toMatchObject({ status: 'access_pending' });

      h.clock = new Date(NOW.getTime() + 61_000);
      await requests.reconcile();
      await expect(requests.getForRuntime(principal(), created.requestId)).resolves.toMatchObject({
        status: 'granted',
        grantedEvents: [],
        note: expect.stringContaining("You won't get updates"),
      });
      await requests.waitForResolution(principal(), created.requestId);
      // Delivered: the agent's other chats can ask for the app again.
      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), INPUT)
      ).resolves.toMatchObject({ status: 'awaiting_owner' });
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

    it('stops updates switched on before a refused destination, so "without updates" sends none', async () => {
      // One scope: the destination passes the two checks before switching it
      // on, and is refused at the final check after.
      const { grants, scopes } = h.realEventGrants(1, { authorize: (call) => call < 2 });
      const requests = h.service({ eventGrants: grants, resume: undefined });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      h.grantLive(['revision-read']);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: scopes,
        })
      ).rejects.toMatchObject({ code: 'event_selection_unavailable' });
      expect(liveSubscriptions()).toBe(0);

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
        })
      ).resolves.toMatchObject({ status: 'granted', grantedEvents: [] });
      expect(liveSubscriptions()).toBe(0);
      // A subscription the review made and then took back leaves the list too.
      expect(
        h.db.$client
          .prepare(
            'SELECT COUNT(*) AS count FROM connector_event_subscriptions WHERE removed_at IS NULL'
          )
          .get()
      ).toEqual({ count: 0 });
    });

    it('takes the answer back when approving updates throws', async () => {
      const approve = vi.fn<ConnectorEventGrantPort['approve']>(async () => {
        throw new Error('event side crashed');
      });
      const withdraw = vi.fn<ConnectorEventGrantPort['withdraw']>();
      const requests = h.service({
        resume: undefined,
        eventGrants: {
          describe: (_owner, scopes) =>
            scopes.map((scope) => ({
              definitionId: scope.definitionId,
              eventType: 'gmail.event_0',
            })),
          approve,
          ready: () => false,
          withdraw,
        },
      });
      const created = await requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.event_0'],
      });
      h.grantLive(['revision-read']);
      const scope = {
        connectionId: CONNECTION_ID,
        definitionId: 'definition-0',
        filter: {},
        agentId: 'agent-1',
        destination: { kind: 'agent' as const, id: 'agent-1' },
      };

      await expect(
        requests.resolve(OWNER, created.requestId, {
          decision: 'current_access',
          connectionId: CONNECTION_ID,
          eventScopes: [scope],
        })
      ).rejects.toThrow('event side crashed');
      expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
      expect(withdraw).toHaveBeenCalledWith(
        OWNER,
        expect.stringMatching(/^id-/),
        expect.any(String)
      );
      await expect(
        requests.resolve(OWNER, created.requestId, { decision: 'denied' })
      ).resolves.toMatchObject({ status: 'denied' });
    });
  });
});
