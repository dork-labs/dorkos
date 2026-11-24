import { describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorAgentRequests,
  connectorReviewRequests,
  eq,
  sessionMessageAcceptanceReceipts,
} from '@dorkos/db';
import {
  CONNECTOR_REQUEST_RATE_LIMIT,
  ConnectorAgentRequestService,
} from '../../agent-request-service.js';
import {
  OWNER,
  NOW,
  CONNECTION_ID,
  INPUT,
  READ_WRITE,
  CURRENT_ACCESS,
  directory,
  principal,
  useAgentRequestHarness,
  requestRow,
} from './agent-request-service.fixtures.js';

/** Creating requests, live holds, follow-ups, expiry and signing in from a request. */
describe('ConnectorAgentRequestService', () => {
  const h = useAgentRequestHarness();

  it('refuses a turn that lost its access in plain words, never "runtime" or "authority"', async () => {
    const requests = h.service({
      runtimePrincipals: { revalidatePrincipal: vi.fn(async () => false) },
    });

    await expect(requests.create(principal(), INPUT)).rejects.toMatchObject({
      code: 'authority_expired',
      message: 'This turn can’t ask for access anymore. Start a new turn and try again.',
    });
  });

  it('creates one typed request without returning private account inventory and reuses its intent', async () => {
    const requests = h.service();

    const first = await requests.create(principal(), INPUT);
    const repeated = await requests.create(principal(), INPUT);

    expect(repeated.requestId).toBe(first.requestId);
    expect(first).toEqual(
      expect.objectContaining({
        status: 'awaiting_owner',
        serviceSlug: 'gmail',
        access: 'read',
        note: expect.stringContaining("The person hasn't answered yet"),
      })
    );
    expect(JSON.stringify(first)).not.toContain('private-account-ref');
    expect(JSON.stringify(first)).not.toContain('Work mail');
    expect(h.db.select().from(connectorReviewRequests).all()).toHaveLength(1);
    expect(h.db.select().from(connectorAgentRequests).all()).toHaveLength(1);
  });

  describe('one open request per agent and app (DOR-2497)', () => {
    it('reuses the open request whatever the reason says', async () => {
      const onChanged = vi.fn();
      const requests = h.service({ onChanged });
      const first = await requests.create(principal(), INPUT);
      const reworded = await requests.create(principal(), {
        ...INPUT,
        reason: 'Actually, check for anything from the bank',
      });

      expect(reworded.requestId).toBe(first.requestId);
      expect(reworded.reason).toBe(INPUT.reason);
      expect(h.db.select().from(connectorAgentRequests).all()).toHaveLength(1);
      expect(onChanged).toHaveBeenCalledTimes(1);
    });

    describe('asking for more than an answer gave (DOR-3930)', () => {
      /** Ask for Read, and have the person allow exactly Read. */
      async function allowedRead(requests: ConnectorAgentRequestService) {
        const created = await requests.create(principal(), INPUT);
        h.grantLive(['revision-read']);
        await requests.resolve(OWNER, created.requestId, CURRENT_ACCESS);
        h.clock = new Date(NOW.getTime() + 1_000);
        return created;
      }

      it('opens a new read-write card instead of reporting the Read answer as granted', async () => {
        const onChanged = vi.fn();
        const requests = h.service({ onChanged });
        const first = await allowedRead(requests);
        const calls = onChanged.mock.calls.length;

        const more = await requests.create(principal(), READ_WRITE);

        expect(more).toMatchObject({ status: 'awaiting_owner', access: 'read-write' });
        expect(more.requestId).not.toBe(first.requestId);
        expect(more).not.toHaveProperty('grantedOperationRevisionIds');
        expect(onChanged.mock.calls.length).toBe(calls + 1);
        const review = h.db
          .select()
          .from(connectorReviewRequests)
          .where(eq(connectorReviewRequests.state, 'pending'))
          .get()!;
        expect(JSON.parse(review.actionPayloadJson)).toMatchObject({ access: 'read-write' });
        // The Read answer still reaches the chat as it was, and gives nothing more.
        expect(requests.getForOwner(OWNER, first.requestId)).toMatchObject({
          status: 'granted',
          access: 'read',
          grantedOperationRevisionIds: ['revision-read'],
        });
        // Asking again reaches the new card, never a third one.
        await expect(requests.create(principal(), READ_WRITE)).resolves.toMatchObject({
          requestId: more.requestId,
          status: 'awaiting_owner',
        });
        expect(h.db.select().from(connectorAgentRequests).all()).toHaveLength(2);
      });
    });

    it('caps new requests per agent with a refusal the agent can pass on', async () => {
      const apps = [
        'gmail',
        'slack',
        'notion',
        'linear',
        'github',
        'jira',
        'asana',
        'trello',
        'dropbox',
        'zoom',
        'figma',
      ] as const;
      expect(apps).toHaveLength(CONNECTOR_REQUEST_RATE_LIMIT + 1);
      const requests = h.service({
        services: {
          serviceDirectory: vi.fn(async () => directory(apps.map((app) => [app, app] as const))),
        },
      });
      for (const app of apps.slice(0, CONNECTOR_REQUEST_RATE_LIMIT)) {
        await requests.create(principal(), { ...INPUT, serviceSlug: app });
      }
      // Asking again for an app already asked for reuses it and never counts.
      await expect(requests.create(principal(), INPUT)).resolves.toMatchObject({
        serviceSlug: 'gmail',
      });

      h.clock = new Date(NOW.getTime() + 3 * 60_000);
      await expect(
        requests.create(principal(), { ...INPUT, serviceSlug: 'figma' })
      ).rejects.toMatchObject({
        code: 'request_rate_limited',
        message: expect.stringContaining('You can ask for figma in about 7 minutes.'),
      });
      // Another agent is not held back by this one.
      await expect(
        requests.create(principal({ agentId: 'agent-2' }), { ...INPUT, serviceSlug: 'figma' })
      ).resolves.toMatchObject({ status: 'awaiting_owner' });

      h.clock = new Date(NOW.getTime() + 11 * 60_000);
      await expect(
        requests.create(principal(), { ...INPUT, serviceSlug: 'figma' })
      ).resolves.toMatchObject({ status: 'awaiting_owner' });
    });
  });

  describe('a plain note on every status', () => {
    it('carries no ids, links or internal words in any note', async () => {
      const requests = h.service();
      const created = await requests.create(principal(), READ_WRITE);
      h.grantLive(['revision-read']);
      const granted = await requests.resolve(OWNER, created.requestId, CURRENT_ACCESS);
      for (const note of [created.note, granted.note]) {
        expect(note).not.toMatch(/connection-1|revision-|id-\d|https?:|operation|revision|scope/i);
      }
    });
  });

  it('rejects a 33rd event before claiming operation or event authority', async () => {
    const { grants, scopes } = h.realEventGrants(33);
    const requests = h.service({ eventGrants: grants, resume: undefined });
    const eventNames = Array.from({ length: 32 }, (_, index) => `gmail.event_${index}`);

    await expect(
      requests.create(principal(), { ...INPUT, requestedEvents: [...eventNames, 'gmail.event_32'] })
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(h.db.select().from(connectorReviewRequests).all()).toEqual([]);

    const created = await requests.create(principal(), { ...INPUT, requestedEvents: eventNames });
    h.grantLive(['revision-read']);
    await expect(
      requests.resolve(OWNER, created.requestId, { ...CURRENT_ACCESS, eventScopes: scopes })
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(
      h.db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_subscriptions').get()
    ).toEqual({ count: 0 });
    expect(
      h.db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_consent_commands').get()
    ).toEqual({ count: 0 });

    await expect(
      requests.resolve(OWNER, created.requestId, {
        ...CURRENT_ACCESS,
        eventScopes: scopes.slice(0, 32),
      })
    ).resolves.toMatchObject({ status: 'granted' });
    expect(h.db.select().from(connectionOperationGrants).all()).toHaveLength(1);
    expect(
      h.db.$client.prepare('SELECT COUNT(*) AS count FROM connector_event_subscriptions').get()
    ).toEqual({ count: 32 });
  });

  it('binds runtime status reads to the exact agent and session', async () => {
    const requests = h.service();
    const created = await requests.create(principal(), INPUT);

    await expect(
      requests.getForRuntime(principal({ canonicalSessionId: 'session-other' }), created.requestId)
    ).rejects.toMatchObject({ code: 'request_not_found' });
    await expect(
      requests.getForRuntime(principal({ agentId: 'agent-other' }), created.requestId)
    ).rejects.toMatchObject({ code: 'request_not_found' });
  });

  it('lets only the owner answer a request', async () => {
    const requests = h.service();
    const created = await requests.create(principal(), INPUT);
    h.grantLive(['revision-read']);

    await expect(
      requests.resolve(
        { kind: 'local_install', installationId: 'foreign' },
        created.requestId,
        CURRENT_ACCESS
      )
    ).rejects.toMatchObject({ code: 'request_not_found' });
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');

    await expect(requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)).resolves.toMatchObject(
      { status: 'granted', connectionId: CONNECTION_ID }
    );
  });

  it("names the room a request's turn belongs to, for the owner only", async () => {
    const requests = h.service({
      roomForSession: (sessionId) => (sessionId === 'session-1' ? 'room-1' : undefined),
    });
    const created = await requests.create(principal(), INPUT);

    expect(requests.getForOwner(OWNER, created.requestId)).toMatchObject({ roomId: 'room-1' });
    // The room is an owner-side fact; the agent's own status never carries it.
    expect(created).not.toHaveProperty('roomId');
  });

  it('resumes a live held request with the real result and leaves no fallback claim', async () => {
    const requests = h.service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const held = requests.waitForResolution(principal(), created.requestId);
    await Promise.resolve();

    h.grantLive(['revision-read']);
    await requests.resolve(OWNER, created.requestId, CURRENT_ACCESS);

    await expect(held).resolves.toMatchObject({
      status: 'granted',
      connectionId: 'connection-1',
    });
    expect(requestRow(h.db, created.requestId)).toMatchObject({
      resumeState: 'resumed',
      liveHoldBootEpoch: null,
      liveHoldUntil: null,
    });
    expect(h.nudges).toContain('session-1');
  });

  it('returns one durable terminal result to both attached live waits', async () => {
    const requests = h.service({ liveHoldMs: 5_000 });
    const created = await requests.create(principal(), INPUT);
    const first = requests.waitForResolution(principal(), created.requestId);
    const second = requests.waitForResolution(principal(), created.requestId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await requests.resolve(OWNER, created.requestId, { decision: 'denied' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'denied' }),
      expect.objectContaining({ status: 'denied' }),
    ]);
    expect(h.nudges).toEqual(['session-1']);
    expect(requestRow(h.db, created.requestId)).toMatchObject({
      resumeState: 'resumed',
      liveHoldBootEpoch: null,
      liveHoldUntil: null,
    });
  });

  it('expires through maintenance, writes no grant, and can produce one terminal follow-up', async () => {
    const { acceptance, requests } = h.serviceWithFollowUps({
      bootEpoch: 'boot-b',
      requestTtlMs: 1_000,
    });
    await requests.create(principal(), INPUT);
    h.clock = new Date(NOW.getTime() + 2_000);

    expect(await requests.reconcile()).toEqual({ expired: 1, accepted: 1, cancelled: 0 });
    expect(await requests.reconcile()).toEqual({ expired: 0, accepted: 0, cancelled: 0 });
    expect(h.db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(h.db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
    expect(
      await acceptance.prepare(h.db.select().from(sessionMessageAcceptanceReceipts).get()!.id)
    ).toMatchObject({ content: expect.stringContaining('Nobody answered in time') });
  });

  it('marks a removed origin terminal before any owner grant is written', async () => {
    const requests = h.service();
    const created = await requests.create(principal(), INPUT);
    h.authorityLive = false;

    await expect(requests.resolve(OWNER, created.requestId, CURRENT_ACCESS)).rejects.toMatchObject({
      code: 'request_not_found',
    });
    expect(h.db.select().from(connectionOperationGrants).all()).toEqual([]);
    expect(requestRow(h.db, created.requestId)).toMatchObject({
      outcome: 'target_deleted',
      resumeState: 'ready',
    });
  });

  it('binds authentication to the exact owner request and derives its service and retry key', async () => {
    let savedFlow:
      | {
          flowId: string;
          providerInstanceId: string;
          toolkit: string;
          state: 'starting';
          createdAt: string;
          expiresAt: string;
        }
      | undefined;
    const authentication = {
      findByIdempotencyKey: vi.fn(() => savedFlow),
      start: vi.fn(async (_owner, input) => {
        savedFlow = {
          flowId: 'flow-1',
          providerInstanceId: input.providerInstanceId,
          toolkit: input.toolkit,
          state: 'starting',
          createdAt: NOW.toISOString(),
          expiresAt: '2026-09-07T12:15:00.000Z',
        };
        return savedFlow;
      }),
      poll: vi.fn(),
    };
    const requests = h.service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);

    const flow = await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
      label: 'Work mail',
    });

    expect(flow.flowId).toBe('flow-1');
    expect(authentication.start).toHaveBeenCalledWith(OWNER, {
      providerInstanceId: 'provider-1',
      toolkit: 'gmail',
      label: 'Work mail',
      idempotencyKey: `agent-request:${created.requestId}`,
    });
    expect(
      h.db
        .select({ providerInstanceId: connectorReviewRequests.providerInstanceId })
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, `id-2`))
        .get()
    ).toEqual({ providerInstanceId: 'provider-1' });

    await expect(
      requests.startAuthentication(OWNER, created.requestId, {
        providerInstanceId: 'provider-other' as never,
      })
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(authentication.start).toHaveBeenCalledTimes(1);
  });

  it('does not materialize authentication state for a foreign owner read', async () => {
    const failed = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => failed),
      start: vi.fn(),
      poll: vi.fn(),
    };
    const requests = h.service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);

    expect(() =>
      requests.getForOwner({ kind: 'local_install', installationId: 'foreign' }, created.requestId)
    ).toThrow(expect.objectContaining({ code: 'request_not_found' }));
    expect(authentication.findByIdempotencyKey).not.toHaveBeenCalled();
    expect(requestRow(h.db, created.requestId)).toMatchObject({
      outcome: null,
      resumeState: 'pending',
    });
  });

  it('CN-03: keeps a connected authentication flow awaiting explicit owner grants', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const connected = {
      ...starting,
      state: 'connected' as const,
      connectionId: CONNECTION_ID,
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => connected),
    };
    const requests = h.service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(requests.pollAuthentication(OWNER, created.requestId, 'flow-1')).resolves.toEqual(
      connected
    );
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(h.db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('refuses a provider poll result that no longer matches the durable request flow', async () => {
    const starting = {
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'starting' as const,
      createdAt: NOW.toISOString(),
      expiresAt: '2026-09-07T12:15:00.000Z',
    };
    const mismatched = {
      ...starting,
      providerInstanceId: 'provider-other' as never,
      state: 'failed' as const,
      reason: 'Sign-in was not completed.',
    };
    const authentication = {
      findByIdempotencyKey: vi.fn(() => starting),
      start: vi.fn(async () => starting),
      poll: vi.fn(async () => mismatched),
    };
    const requests = h.service({ authentication: authentication as never });
    const created = await requests.create(principal(), INPUT);
    await requests.startAuthentication(OWNER, created.requestId, {
      providerInstanceId: 'provider-1' as never,
    });

    await expect(
      requests.pollAuthentication(OWNER, created.requestId, 'flow-1')
    ).rejects.toMatchObject({ code: 'selection_invalid' });
    expect(requests.getForOwner(OWNER, created.requestId).status).toBe('awaiting_owner');
    expect(h.db.select().from(connectionOperationGrants).all()).toEqual([]);
  });
});
