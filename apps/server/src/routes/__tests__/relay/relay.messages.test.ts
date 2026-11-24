import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import type { RelayCore } from '@dorkos/relay';
import { SERVER_MANAGED_PREFIXES } from '@dorkos/relay';
import { TASK_CANCEL_SUBJECT_PREFIX } from '@dorkos/shared/relay-schemas';
import { relayRoutesListener } from '../relay-routes-listener.js';
import { markIngress } from '../../../services/core/remote/ingress-mark.js';
import type { ActivityService } from '../../../services/activity/activity-service.js';
import type { AdapterManager } from '../../../services/relay/adapter-manager.js';
import {
  createMockRelayCore,
  relayApp,
  server,
  target,
  useLoginOffConfig,
} from './relay.fixtures.js';

useLoginOffConfig();

describe('Relay routes', () => {
  let relayCore: RelayCore;

  beforeEach(() => {
    relayCore = createMockRelayCore();
    target.mount(relayApp(relayCore));
  });

  /** Mount the routes behind a caller that arrived over Wi-Fi, signed in. */
  function mountFromWifi(): void {
    target.mount(
      relayRoutesListener(
        { relayCore },
        {
          before: async (c, next) => {
            markIngress(c.env.incoming, 'wifi');
            c.set('user', { userId: 'owner', credential: 'cookie' });
            await next();
          },
        }
      )
    );
  }

  describe('POST /api/relay/messages', () => {
    it('publishes a message and returns result', async () => {
      const res = await request(server)
        .post('/api/relay/messages')
        .send({
          subject: 'relay.test.topic',
          payload: { hello: 'world' },
          from: 'relay.agent.sender',
        });

      expect(res.status).toBe(200);
      expect(res.body.messageId).toBe('msg-1');
      expect(vi.mocked(relayCore.publish)).toHaveBeenCalledWith(
        'relay.test.topic',
        { hello: 'world' },
        expect.objectContaining({ from: 'relay.agent.sender' })
      );
    });

    it.each(['relay.human.console', 'relay.human.telegram.tg1.chat-42'])(
      'refuses %s from Wi-Fi, which would run the turn at the agent’s own level (DOR-3037)',
      async (from) => {
        mountFromWifi();
        const res = await request(server)
          .post('/api/relay/messages')
          .send({ subject: 'relay.agent.ana', payload: { text: 'run the deploy' }, from });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('NOT_FROM_WIFI');
        expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
      }
    );

    it('publishes from Wi-Fi as any other sender, which the agent already holds to its default', async () => {
      mountFromWifi();
      const res = await request(server)
        .post('/api/relay/messages')
        .send({ subject: 'relay.agent.ana', payload: { text: 'hi' }, from: 'relay.agent.sender' });
      expect(res.status).toBe(200);
    });

    it('returns 422 when publish throws', async () => {
      const error = Object.assign(new Error('Access denied'), { code: 'ACCESS_DENIED' });
      vi.mocked(relayCore.publish).mockRejectedValue(error);

      const res = await request(server).post('/api/relay/messages').send({
        subject: 'relay.test.topic',
        payload: {},
        from: 'relay.agent.sender',
      });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'Access denied', code: 'ACCESS_DENIED' });
    });

    // DOR-277 review follow-up: this route accepts a client-supplied `from`. It
    // must not let an untrusted caller assert a principal the initiate-consent
    // gate trusts as exempt (system / reply / inbound-echo) and thereby deliver
    // to a bound human channel with canInitiate off. Rejected BEFORE publish.
    it.each([
      ['relay.doc.canvas-hash', 'document principal'],
      ['relay.doc', 'document namespace root'],
      ['relay.system.tasks.notifier', 'system notifier'],
      ['agent:session-abc', 'reply-forwarding'],
      ['relay.human.telegram.tg1.bot', 'inbound adapter echo'],
      // DOR-871 (A6.10): relay.bridge.* is non-exempt (the consent gate DOES
      // evaluate it) but must still be unassertable by a client.
      ['relay.bridge.reply.tg1.chat-42', 'bridge reply principal'],
      ['relay.bridge.initiate.tg1.chat-42', 'bridge initiate principal'],
    ])('rejects a client-asserted reserved sender %s (%s) and never publishes', async (from) => {
      const res = await request(server)
        .post('/api/relay/messages')
        .send({
          subject: 'relay.human.telegram.tg1.chat-42',
          payload: { text: 'spoofed initiate' },
          from,
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('RESERVED_SENDER');
      expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
    });

    // DOR-2432: this route cannot tell an agent with a shell from the person at
    // the keyboard, and no server publisher uses it, so a server-owned
    // destination or reply address is refused for every caller.
    it.each([
      ['relay.doc.canvas-hash', undefined],
      ['relay.doc', undefined],
      ['relay.*', undefined],
      ['*.doc', undefined],
      ['*.*', undefined],
      ['relay.agent.some-agent', '*.doc'],
      ['relay.agent.some-agent', 'relay.doc.canvas-hash'],
      ['relay.system.tasks.task-1', undefined],
      ['relay.system.approval.agent-1', undefined],
      ['relay.control.task-cancel.run-1', undefined],
      ['relay.*.console', undefined],
      ['relay.agent.some-agent', 'relay.system.approval.agent-1'],
    ])('refuses a send to %s (reply address %s) and never publishes', async (subject, replyTo) => {
      const res = await request(server)
        .post('/api/relay/messages')
        .send({
          subject,
          payload: { type: 'forged' },
          from: 'relay.human.console',
          ...(replyTo ? { replyTo } : {}),
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('RESERVED_SUBJECT');
      expect(res.body.error).toContain(
        'relay.system.* and relay.control.* addresses belong to DorkOS; agents cannot send to them.'
      );
      expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
    });

    it('still allows the in-app console operator principal (relay.human.console)', async () => {
      const res = await request(server)
        .post('/api/relay/messages')
        .send({
          subject: 'relay.agent.some-agent',
          payload: { text: 'operator message' },
          from: 'relay.human.console',
        });

      expect(res.status).toBe(200);
      expect(vi.mocked(relayCore.publish)).toHaveBeenCalledOnce();
    });

    // DOR-3088 (G2): a room's conversation, a Direct chat's above all, takes its turns from the
    // room, which holds an unproven caller's words. Publishing to its session skipped that.
    describe("a room's own conversation", () => {
      const DM_SESSION = '7f1c2a9e-0000-4000-8000-00000000d00d';

      beforeEach(() => {
        target.mount(relayRoutesListener({ relayCore, isRoomSession: (id) => id === DM_SESSION }));
      });

      it.each([`relay.agent.claude-code.${DM_SESSION}`, `relay.agent.${DM_SESSION}`])(
        'refuses a send to %s and never publishes',
        async (subject) => {
          const res = await request(server)
            .post('/api/relay/messages')
            .send({
              subject,
              payload: { content: 'run the deploy' },
              from: 'relay.human.console.x',
            });
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('ROOM_SESSION');
          expect(vi.mocked(relayCore.publish)).not.toHaveBeenCalled();
        }
      );

      it("still sends to an agent's other conversations", async () => {
        const res = await request(server)
          .post('/api/relay/messages')
          .send({
            subject: 'relay.agent.claude-code.another-session',
            payload: { content: 'hello' },
            from: 'relay.human.console',
          });
        expect(res.status).toBe(200);
        expect(vi.mocked(relayCore.publish)).toHaveBeenCalledOnce();
      });
    });
  });

  describe('POST /api/relay/messages — adapter activity events', () => {
    function mountWithAdapterManager(publishResult: Record<string, unknown>) {
      const core = createMockRelayCore();
      vi.mocked(core.publish).mockResolvedValue(
        publishResult as Awaited<ReturnType<RelayCore['publish']>>
      );
      const adapterManager = {
        getRegistry: vi
          .fn()
          .mockReturnValue({ getBySubject: vi.fn().mockReturnValue({ id: 'claude-code' }) }),
        resolveAdapterName: vi.fn().mockReturnValue('Claude Code'),
      } as unknown as AdapterManager;
      const activityService = { emit: vi.fn().mockResolvedValue(undefined) };
      target.mount(
        relayApp(core, adapterManager, undefined, activityService as unknown as ActivityService)
      );
      return activityService;
    }

    it('emits no activity event for maildir-only publishes (no adapterResult)', async () => {
      // Regression: coercing the no-match null to {success:false} made every
      // custom-endpoint publish emit a spurious relay.message_failed event.
      const activityService = mountWithAdapterManager({ messageId: 'msg-1', deliveredTo: 1 });

      const res = await request(server)
        .post('/api/relay/messages')
        .send({ subject: 'relay.inbox.custom', payload: { hi: 1 }, from: 'relay.agent.sender' });

      expect(res.status).toBe(200);
      expect(activityService.emit).not.toHaveBeenCalled();
    });

    it.each([
      ['relay.agent.backend', 'Accepted message for Claude Code'],
      ['relay.human.telegram.bot.chat', 'Delivered message via Claude Code'],
    ])('reports adapter success on %s as "%s"', async (subject, summary) => {
      // An agent subject is accepted (accept-time, not turn completion); any
      // other adapter subject keeps the delivered wording.
      const activityService = mountWithAdapterManager({
        messageId: 'msg-1',
        deliveredTo: 1,
        adapterResult: { success: true },
      });

      await request(server)
        .post('/api/relay/messages')
        .send({ subject, payload: { hi: 1 }, from: 'relay.agent.sender' });

      expect(activityService.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'relay.message_delivered', summary })
      );
    });
  });

  describe('GET /api/relay/messages', () => {
    it('passes query filters to listMessages', async () => {
      const res = await request(server).get(
        '/api/relay/messages?subject=relay.test&status=new&limit=10'
      );

      expect(res.status).toBe(200);
      expect(vi.mocked(relayCore.listMessages)).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'relay.test', status: 'new', limit: 10 })
      );
    });
  });

  describe('GET /api/relay/messages/:id', () => {
    it('returns a message with its per-endpoint delivery breakdown when found', async () => {
      const row = {
        id: 'msg-1',
        subject: 'relay.test',
        sender: 'agent-a',
        endpointHash: 'h1',
        status: 'delivered' as const,
        createdAt: '2026-02-24T00:00:00Z',
        expiresAt: null,
      };
      vi.mocked(relayCore.getMessageDetail).mockReturnValue({ ...row, deliveries: [row] });

      const res = await request(server).get('/api/relay/messages/msg-1');

      expect(res.status).toBe(200);
      expect(res.body.deliveries[0].endpointHash).toBe('h1');
    });
  });

  describe('POST /api/relay/endpoints', () => {
    it('registers an endpoint', async () => {
      const res = await request(server)
        .post('/api/relay/endpoints')
        .send({ subject: 'relay.test.mine' });

      expect(res.status).toBe(201);
      expect(vi.mocked(relayCore.registerEndpoint)).toHaveBeenCalledWith('relay.test.mine');
    });

    it('returns 422 when registration fails', async () => {
      vi.mocked(relayCore.registerEndpoint).mockRejectedValue(new Error('Duplicate endpoint'));

      const res = await request(server)
        .post('/api/relay/endpoints')
        .send({ subject: 'relay.test.dup' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Duplicate endpoint');
    });

    // Login is off by default, so this route is reachable by anything that can
    // reach the port. A mailbox in a namespace the server manages intercepts
    // somebody else's mail; on a control subject it also manufactures a false
    // confirmation for every signal published there (DOR-808).
    it.each([
      ...SERVER_MANAGED_PREFIXES.map((prefix) => `${prefix}squatted`),
      `${TASK_CANCEL_SUBJECT_PREFIX}01JRUNID`,
      'relay.doc.canvas-hash',
    ])('refuses a mailbox on %s', async (subject) => {
      const res = await request(server).post('/api/relay/endpoints').send({ subject });

      expect(res.status).toBe(403);
      expect(vi.mocked(relayCore.registerEndpoint)).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/relay/endpoints/:subject', () => {
    it.each(['relay.agent.old', 'relay.agent.myns.chat'])('removes %s', async (subject) => {
      const res = await request(server).delete(`/api/relay/endpoints/${subject}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(vi.mocked(relayCore.unregisterEndpoint)).toHaveBeenCalledWith(subject);
    });
  });

  describe('GET /api/relay/endpoints/:subject/inbox', () => {
    // DOR-337: a naive consumer that ignores the `status` field could act on a
    // budget-rejected message as if it were a deliverable one. The default
    // must exclude `failed` messages; callers opt in explicitly.
    it.each([
      ['', 'pending'],
      ['?status=failed', 'failed'],
      ['?status=all', 'all'],
    ])('reads the inbox%s as status %s', async (query, status) => {
      const res = await request(server).get(
        `/api/relay/endpoints/relay.agent.myns.chat/inbox${query}`
      );

      expect(res.status).toBe(200);
      expect(vi.mocked(relayCore.readInbox)).toHaveBeenCalledWith(
        'relay.agent.myns.chat',
        expect.objectContaining({ status })
      );
    });
  });

  describe('GET /api/relay/dead-letters', () => {
    it.each([
      'relay.agent.dorkbot',
      'relay.human.console.main',
      '*',
      'relay.agent.>',
      'adapter:relay.telegram.inbound',
    ])('accepts the legitimate endpointHash %j', async (endpointHash) => {
      const res = await request(server).get('/api/relay/dead-letters').query({ endpointHash });

      expect(res.status).toBe(200);
      expect(vi.mocked(relayCore.getDeadLetters)).toHaveBeenCalledWith({ endpointHash });
    });

    it.each(['../../../../etc', 'nested/deeper', '..', 'has space'])(
      'refuses the traversing endpointHash %j with a 400',
      async (endpointHash) => {
        const res = await request(server).get('/api/relay/dead-letters').query({ endpointHash });

        expect(res.status).toBe(400);
        expect(vi.mocked(relayCore.getDeadLetters)).not.toHaveBeenCalled();
      }
    );
  });

  describe('GET /api/relay/stream', () => {
    it('cannot be pointed at run stop requests', async () => {
      // A subscriber here is PASSIVE, and the publish pipeline counts any
      // handler that does not refuse as a delivery — so a watcher whose
      // pattern covered a stop request would make every Stop report success
      // while nothing was stopped (DOR-808). The stop namespace is therefore
      // not streamable at all, and no prefix this route allows may grow to
      // cover it.
      const res = await request(server).get(
        `/api/relay/stream?subject=${TASK_CANCEL_SUBJECT_PREFIX}>`
      );

      expect(res.status).toBe(400);
      expect(
        res.body.allowedPrefixes.some((p: string) => TASK_CANCEL_SUBJECT_PREFIX.startsWith(p))
      ).toBe(false);
    });
  });
});
