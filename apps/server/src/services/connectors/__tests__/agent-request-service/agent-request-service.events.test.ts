import { describe, expect, it, vi } from 'vitest';
import { connectionOperationGrants } from '@dorkos/db';
import type { ConnectorEventGrantPort } from '../../events/grant-port.js';
import {
  OWNER,
  INPUT,
  CURRENT_ACCESS,
  EVENT_SCOPE,
  describeAsMessageReceived,
  principal,
  useAgentRequestHarness,
  requestRow,
} from './agent-request-service.fixtures.js';

/** Answers that include event updates: exact definitions, races, and the stored approval. */
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
