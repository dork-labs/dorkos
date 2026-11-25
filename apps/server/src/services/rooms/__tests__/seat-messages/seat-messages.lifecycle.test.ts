import { setAgentHomeRegistry } from '../../../core/agent-identity/agent-home.js';
import { renderSeatMessage, seatCarryOf } from '../../handoff/seat-message-prompt.js';
import {
  AgentPauseService,
  initAgentPause,
  resetAgentPause,
} from '../../../mesh/pause/agent-pause.js';
/**
 * DOR-4472 class proof: peer writes must enter a scoped, bounded, marked private
 * aside, never ordinary session dispatch or an automatic public body post.
 */
import { expect, it, vi } from 'vitest';
import { ChatMessageStore } from '../../../session/chat-messages/chat-message-store.js';
import { agentKey } from '../../room-claims.js';
import type { RoomTriggerDispatcher } from '../../room-trigger.js';
import type { RoomTurnRequest } from '../../room-turn-port.js';
import { createRoomHarness, outcomeRunner, roomSpec } from '../room-test-harness.js';

import {
  agents,
  bo,
  caller,
  chats,
  harness,
  loose,
  receipts,
  roomId,
  seatInbox,
  useSeatMessageRoom,
} from './seat-messages.fixtures.js';

useSeatMessageRoom();

it('M9: launch budget charges only actual batches after slow placement and current-target guards', async () => {
  for (const action of ['leave/rejoin', 'dispose', 'paused', 'concurrent'] as const) {
    const launched: RoomTurnRequest[] = [];
    const h = createRoomHarness({
      agents,
      runner: outcomeRunner((request) => {
        launched.push(request);
        return { text: null };
      }),
      turnLimitsEnabled: true,
      maxAutomaticTurnsPerRoomPerHour: 1,
      maxAutomaticTurnsTotalPerHour: 1,
    });
    const { triggers } = h.service as unknown as { triggers: RoomTriggerDispatcher };
    const store = new ChatMessageStore(h.db);
    const inbox = h.service.createSeatMessages(store, () => undefined);
    const authorId = h.authors.resolveAgent('/agents/bo', 'Bo').id;
    const seat = (suffix: string, agentPath = '/agents/bo') => {
      const seatAuthor = h.authors.resolveAgent(
        agentPath,
        agentPath === '/agents/bo' ? 'Bo' : 'Ana'
      ).id;
      const room = h.service.createRoom(
        // Ana sends every message here, so she is a member of each room (DOR-4547).
        {
          kind: 'channel',
          title: `Budget ${suffix}`,
          members: [],
          agentPaths: [...new Set([agentPath, '/agents/ana'])],
        },
        h.human
      );
      const session = `budget-slow-${action}-${suffix}`;
      h.store.bindRoomSession(room.id, seatAuthor, session, new Date().toISOString());
      return { room, session, authorId: seatAuthor, agentPath };
    };
    const first = seat('one');
    const second = action === 'concurrent' ? seat('two', '/agents/ana') : undefined;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const placing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let placements = 0;
    const originalPlace = triggers.placeTurn.bind(triggers);
    vi.spyOn(triggers, 'placeTurn').mockImplementation(async (...args) => {
      placements++;
      entered();
      await barrier;
      return originalPlace(...args);
    });
    const admit = (target: typeof first, id: string) => {
      const row = {
        id,
        toSessionId: target.session,
        fromSessionId: 'budget-peer',
        fromAgentPath: '/agents/ana',
        fromAgentId: 'ana',
        fromAgentName: 'Ana',
        fromChatTitle: null,
        kind: 'message' as const,
        text: 'A private budget request.',
        summary: null,
        nonce: '12344321',
        delivery: 'queue' as const,
        status: 'queued' as const,
        queueMessageId: `queue-${id}`,
        ceilingJson: '"none"',
        replyToId: null,
      };
      inbox.admit({
        target: inbox.resolveSeatTarget(target.session)!,
        row,
        rendered: renderSeatMessage(row),
        carried: seatCarryOf(row),
      });
    };
    try {
      if (second) {
        expect(second.authorId).not.toBe(first.authorId);
        expect(second.agentPath).not.toBe(first.agentPath);
        expect(triggers.busyWith(first.room.id, first.authorId, first.agentPath)).toBeNull();
        expect(triggers.busyWith(second.room.id, second.authorId, second.agentPath)).toBeNull();
      }
      admit(first, `slow-${action}-one`);
      if (second) admit(second, `slow-${action}-two`);
      await placing;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(launched).toHaveLength(0);
      expect(triggers.deps.budget.remaining(first.room.id)).toEqual({ room: 1, global: 1 });
      if (action === 'leave/rejoin') {
        const member = h.store.getMember(first.room.id, authorId)!;
        h.store.removeMember(first.room.id, authorId);
        h.store.addMember({
          roomId: first.room.id,
          authorId,
          responseMode: member.responseMode,
          joinedAt: member.joinedAt,
        });
        h.store.bindRoomSession(first.room.id, authorId, 'budget-replacement', member.joinedAt);
      } else if (action === 'dispose') inbox.stop();
      else if (action === 'paused') {
        h.db.$client.exec(`INSERT INTO agents(id,name,runtime,project_path,registered_at,updated_at)
          VALUES('budget-paused-agent','Bo','claude-code','/agents/bo','2026-11-15','2026-11-15');
          INSERT INTO agent_pauses(agent_id,paused_by,paused_by_kind,paused_by_name,paused_at)
          VALUES('budget-paused-agent','owner','person','Owner','2026-11-15');`);
        setAgentHomeRegistry({
          isRegisteredHome: (dir) => dir === '/agents/bo',
          listRegisteredHomes: () => ['/agents/bo'],
          managedWorkspaceOwner: () => null,
          roomsDir: null,
        });
        const pauses = new AgentPauseService({ db: h.db });
        initAgentPause(pauses);
        expect(pauses.pausedAgentOfTurn({ cwd: '/agents/bo', forAgent: '/agents/bo' })?.id).toBe(
          'budget-paused-agent'
        );
      } else expect(placements).toBe(2);
      release();
      await inbox.idle();
      if (action === 'concurrent') {
        expect(launched).toHaveLength(1);
        expect(triggers.deps.budget.remaining(first.room.id).global).toBe(0);
        expect(
          [
            store.get('slow-concurrent-one')?.status,
            store.get('slow-concurrent-two')?.status,
          ].sort()
        ).toEqual(['delivered', 'failed']);
      } else {
        expect(launched).toHaveLength(0);
        expect(triggers.deps.budget.remaining(first.room.id)).toEqual({ room: 1, global: 1 });
        expect(store.get(`slow-${action}-one`)?.status).toBe('failed');
      }
    } finally {
      inbox.stop();
      release();
      await inbox.idle();
      resetAgentPause();
      setAgentHomeRegistry(undefined);
    }
  }
});

it('M9: ordinary queue actions never adopt private seat receipt IDs after DOR-3060', async () => {
  const { MessageQueueStore, setMessageQueueStore } =
    await import('../../../session/message-queue-store.js');
  const { cancelQueuedMessage } = await import('../../../session/queued-message-edits.js');
  const { setQueuedChatActionsDeps, steerQueuedChatMessage, queuedChatRecordsOf } =
    await import('../../../session/chat-messages/queued/queued-chat-actions.js');
  const { joinWaitingChatRows } =
    await import('../../../session/message-dispatcher/join-chat-rows.js');
  const { chatClientId } = await import('../../../session/chat-messages/chat-client-id.js');
  const queue = new MessageQueueStore(harness.db);
  setMessageQueueStore(queue);
  const steer = vi.fn(async () => true);
  setQueuedChatActionsDeps({
    store: receipts,
    isBusy: async () => true,
    turnLevelOf: () => loose,
    steerInto: steer,
    emitActivity: () => undefined,
    operatorName: () => 'Owner',
  });
  const { triggers } = harness.service as unknown as { triggers: RoomTriggerDispatcher };
  triggers.claimed.set(agentKey(roomId, bo), {
    roomId,
    authorId: bo,
    sessionId: 'seat-chat',
    agentPath: '/agents/bo',
    claimedAt: new Date().toISOString(),
  } as never);
  try {
    const receipt = await chats.send(caller, {
      to: 'seat-chat',
      message: 'PRIVATE_QUEUE_ONLY',
      delivery: 'interrupt',
    });
    const held = receipts.get(receipt.messageId)!;
    expect(held.deliveryRoute).toBe('seat');
    expect(queue.list('seat-chat')).toHaveLength(0);
    for (const id of [held.id, held.queueMessageId!]) {
      expect(await steerQueuedChatMessage('seat-chat', id)).toEqual({ outcome: 'not-found' });
      expect(queuedChatRecordsOf('seat-chat', id)).toHaveLength(0);
      expect(cancelQueuedMessage('seat-chat', id)).toBeUndefined();
      joinWaitingChatRows('seat-chat', id);
    }
    expect(steer).not.toHaveBeenCalled();
    expect(receipts.get(held.id)?.status).toBe('queued');
    expect(receipts.get(held.id)?.text).toBe('PRIVATE_QUEUE_ONLY');
    // Same live queue/action seam works for an actual ordinary chat row.
    queue.enqueue({
      id: 'ordinary-live-queue',
      sessionId: 'ordinary-target',
      content: 'Ordinary fenced request.',
      clientId: chatClientId(caller.sessionId),
    });
    receipts.insert({
      ...held,
      id: 'ordinary-live-message',
      deliveryRoute: 'chat',
      seatRoomId: null,
      seatAuthorId: null,
      seatJoinedAt: null,
      seatSessionId: null,
      toSessionId: 'ordinary-target',
      queueMessageId: 'ordinary-live-queue',
      ceilingJson: '"none"',
    });
    expect(await steerQueuedChatMessage('ordinary-target', 'ordinary-live-queue')).toEqual({
      outcome: 'steered',
    });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(receipts.get('ordinary-live-message')?.status).toBe('steered');
  } finally {
    seatInbox?.stop();
    await seatInbox?.idle();
    setQueuedChatActionsDeps(undefined);
    setMessageQueueStore(undefined);
  }
});

it.each(['native-rekey', 'leave/rejoin'] as const)(
  'M3/M9: %s during placement preserves only authoritative native aliases',
  async (change) => {
    const ran: RoomTurnRequest[] = [];
    const h = createRoomHarness({
      agents,
      runner: outcomeRunner((request) => {
        ran.push(request);
        const { triggers } = h.service as unknown as { triggers: RoomTriggerDispatcher };
        expect(triggers.claimed.get(agentKey(request.room.id, request.authorId))?.sessionId).toBe(
          request.sessionId
        );
        return { text: null };
      }),
      turnLimitsEnabled: true,
      maxAutomaticTurnsPerRoomPerHour: 1,
      maxAutomaticTurnsTotalPerHour: 1,
    });
    const room = h.service.createRoom(
      roomSpec('channel', 'Rekey', ['/agents/bo', '/agents/ana']),
      h.human
    );
    const authorId = h.authors.resolveAgent('/agents/bo', 'Bo').id;
    h.store.bindRoomSession(room.id, authorId, 'placement-old', new Date().toISOString());
    const store = new ChatMessageStore(h.db);
    const inbox = h.service.createSeatMessages(store, () => undefined);
    const { triggers } = h.service as unknown as { triggers: RoomTriggerDispatcher };
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const placing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalPlace = triggers.placeTurn.bind(triggers);
    vi.spyOn(triggers, 'placeTurn').mockImplementation(async (...args) => {
      entered();
      await barrier;
      return originalPlace(...args);
    });
    const row = {
      id: `rekey-${change}`,
      toSessionId: 'placement-old',
      fromSessionId: 'peer-chat',
      fromAgentPath: '/agents/ana',
      fromAgentId: 'ana',
      fromAgentName: 'Ana',
      fromChatTitle: null,
      kind: 'message' as const,
      text: 'Private rekey test.',
      summary: null,
      nonce: '12345678',
      delivery: 'queue' as const,
      status: 'queued' as const,
      queueMessageId: `queue-${change}`,
      ceilingJson: '"none"',
      replyToId: null,
    };
    try {
      inbox.admit({
        target: inbox.resolveSeatTarget('placement-old')!,
        row,
        rendered: renderSeatMessage(row),
        carried: seatCarryOf(row),
      });
      await placing;
      expect(ran).toHaveLength(0);
      if (change === 'native-rekey')
        h.store.sessionLedger.rebindBySessionId('placement-old', 'placement-current');
      else {
        const member = h.store.getMember(room.id, authorId)!;
        h.store.removeMember(room.id, authorId);
        h.store.addMember({
          roomId: room.id,
          authorId,
          joinedAt: member.joinedAt,
          responseMode: member.responseMode,
        });
        h.store.bindRoomSession(room.id, authorId, 'placement-current', member.joinedAt);
      }
      release();
      await inbox.idle();
      if (change === 'native-rekey') {
        expect(ran).toHaveLength(1);
        expect(ran[0]?.sessionId).toBe('placement-current');
        expect(h.store.getRoomSession(room.id, authorId)).toBe('placement-current');
        expect(store.get(row.id)?.status).toBe('delivered');
        expect(triggers.deps.budget.remaining(room.id)).toEqual({ room: 0, global: 0 });
      } else {
        expect(ran).toHaveLength(0);
        expect(store.get(row.id)?.status).toBe('failed');
        expect(triggers.deps.budget.remaining(room.id)).toEqual({ room: 1, global: 1 });
      }
    } finally {
      inbox.stop();
      release();
      await inbox.idle();
    }
  }
);
