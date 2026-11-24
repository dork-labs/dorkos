import { describe, expect, it, vi } from 'vitest';
import { connectorAgentRequests, connectorReviewRequests, eq } from '@dorkos/db';
import { openAgentRequest } from '../../agent-request-service.js';
import type { ConnectorEventGrantPort } from '../../events/grant-port.js';
import {
  OWNER,
  NOW,
  INPUT,
  READ_WRITE,
  CURRENT_ACCESS,
  EVENT_SCOPE,
  describeAsMessageReceived,
  principal,
  requestRow,
  useAgentRequestHarness,
} from './agent-request-service.fixtures.js';

/** An event side that takes every approval and never makes it live. */
function pendingUpdates(): ConnectorEventGrantPort {
  return {
    describe: describeAsMessageReceived(),
    approve: vi.fn<ConnectorEventGrantPort['approve']>(async (_owner, review) => ({
      state: 'pending',
      selections: review.scopes.map((scope) => ({
        subscriptionId: 'subscription-1',
        scopeVersion: 1,
        definitionId: scope.definitionId,
        eventScopeHash: 'a'.repeat(64),
      })),
    })),
    ready: vi.fn(() => false),
    withdraw: vi.fn(),
  };
}

/** One answer per request, and that answer reaching the agent however late it is read. */
describe('ConnectorAgentRequestService', () => {
  const h = useAgentRequestHarness();

  it('keeps concurrent allow and decline consistent with the one winning answer', async () => {
    const requests = h.service();
    const created = await requests.create(principal(), INPUT);
    h.grantLive(['revision-read']);

    const outcomes = await Promise.allSettled([
      requests.resolve(OWNER, created.requestId, CURRENT_ACCESS),
      requests.resolve(OWNER, created.requestId, { decision: 'denied' }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const final = requests.getForOwner(OWNER, created.requestId);
    expect(['denied', 'granted']).toContain(final.status);
    if (final.status === 'granted') {
      expect(final.grantedOperationRevisionIds).toEqual(['revision-read']);
    }
  });

  it('attaches to a terminal result resolved between create and live wait', async () => {
    const requests = h.service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(requests.waitForResolution(principal(), created.requestId)).resolves.toMatchObject(
      { status: 'denied' }
    );
    expect(requestRow(h.db, created.requestId)).toMatchObject({
      resumeState: 'resumed',
      liveHoldBootEpoch: null,
      liveHoldUntil: null,
    });
  });

  it('does not let awaiting-owner rows hide a cold terminal result', async () => {
    const accept = vi.fn();
    const requests = h.service({ resume: { accept, nudge: vi.fn() } });
    // One agent keeps one open request per app, so the page is filled by many agents.
    const created = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        requests.create(principal({ agentId: `agent-${index}` }), INPUT)
      )
    );
    const terminalRequestId = created
      .map((item) => item.requestId)
      .sort()
      .at(-1)!;
    await requests.resolve(OWNER, terminalRequestId, { decision: 'denied' });

    await requests.reconcile();

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'connector_agent_request', requestId: terminalRequestId })
    );
  });

  it('does not count an unanswered request past its time, even before anything expires it', async () => {
    // `create()` expires overdue requests first; this reads the check alone.
    const requests = h.service({ requestTtlMs: 1_000 });
    const created = await requests.create(principal(), INPUT);
    const later = new Date(NOW.getTime() + 2_000).toISOString();
    expect(openAgentRequest(h.db, 'agent-1', 'gmail', NOW.toISOString())?.request.id).toBe(
      created.requestId
    );
    expect(openAgentRequest(h.db, 'agent-1', 'gmail', later)).toBeUndefined();
  });

  it('never raises a request once it has been answered: more access is a new card', async () => {
    const onChanged = vi.fn();
    const requests = h.service({ eventGrants: pendingUpdates(), resume: undefined, onChanged });
    const created = await requests.create(principal(), {
      ...INPUT,
      requestedEvents: ['gmail.message_received'],
    });
    h.grantLive(['revision-read']);
    await requests.resolve(OWNER, created.requestId, {
      ...CURRENT_ACCESS,
      eventScopes: [EVENT_SCOPE],
    });
    const answered = () => ({
      request: h.db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, created.requestId))
        .get(),
      review: h.db
        .select()
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, 'id-2'))
        .get(),
    });
    const before = answered();
    expect(before.review).toBeDefined();
    const calls = onChanged.mock.calls.length;

    // More updates alone, at a level the answer covers: the answer stands.
    await expect(
      requests.create(principal(), {
        ...INPUT,
        requestedEvents: ['gmail.message_received', 'gmail.label_added'],
      })
    ).resolves.toMatchObject({ requestId: created.requestId, access: 'read' });
    expect(answered()).toEqual(before);
    expect(onChanged.mock.calls.length).toBe(calls);

    // A level the answer left out: a new card, and the answer is left as it was.
    h.clock = new Date(NOW.getTime() + 1_000);
    const more = await requests.create(principal(), {
      ...READ_WRITE,
      requestedEvents: ['gmail.message_received', 'gmail.label_added'],
    });
    expect(more).toMatchObject({
      status: 'awaiting_owner',
      access: 'read-write',
      requestedEvents: ['gmail.message_received', 'gmail.label_added'],
    });
    expect(more.requestId).not.toBe(created.requestId);
    expect(answered()).toEqual(before);
    expect(onChanged.mock.calls.length).toBe(calls + 1);
  });
});
