import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalServiceActionSchema } from '@dorkos/shared/approval-schemas';
import {
  createCapabilityAuthorityBinding,
  isCapabilityAuthorityBinding,
} from '../../../connectors/principal/capability-authority-binding.js';
import { renderSeatMessage, seatCarryOf } from '../../handoff/seat-message-prompt.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  recordTurnLevels,
  lastTurnLevelOf,
  marksOf,
} from '../../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { ownExtensionsWritable } from '../../../runtimes/claude-code/folder-settings/agent-extensions-deny.js';
import { turnBoundsOf } from '../../limits/teammate-turn.js';
import { holdRequesterFor } from '../../../connectors/execution/destructive-hold-window.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import type { CapabilityPreflightResult } from '../../../core/capabilities/registry.js';
/**
 * DOR-4472 class proof: peer writes must enter a scoped, bounded, marked private
 * aside, never ordinary session dispatch or an automatic public body post.
 */
import { expect, it, vi } from 'vitest';
import {
  ChatMessageStore,
  type NewChatMessage,
} from '../../../session/chat-messages/chat-message-store.js';
import { agentKey } from '../../room-claims.js';
import type { SeatMessageLimits } from '../../handoff/seat-message-types.js';
import { SEAT_MESSAGE_GLOBAL_MAX, SEAT_MESSAGE_PENDING_MAX } from '../../handoff/seat-messages.js';
import type { RoomTurnRequest } from '../../room-turn-port.js';
import { createRoomHarness, outcomeRunner, roomSpec } from '../room-test-harness.js';

import {
  agents,
  bo,
  caller,
  chats,
  deferredFinishes,
  dispatch,
  harness,
  loose,
  receipts,
  roomId,
  seatInbox,
  setSeatInbox,
  turns,
  useSeatMessageRoom,
} from './seat-messages.fixtures.js';

useSeatMessageRoom();

it('M8: a failed constant trace transaction leaves neither receipt nor notice', async () => {
  harness.db.$client.exec(
    `CREATE TRIGGER fail_seat_trace BEFORE INSERT ON room_entries WHEN NEW.kind='notice' AND NEW.body LIKE '%a private message%' BEGIN SELECT RAISE(ABORT, 'trace unavailable'); END`
  );
  await expect(
    chats.send(caller, { to: 'seat-chat', message: 'PRIVATE_ROLLBACK_BODY' })
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(receipts.listSentFrom(caller.sessionId)).toHaveLength(0);
  expect(
    harness.store
      .listEntries(roomId, { limit: 100 })
      .filter((e) => e.body.text.includes('a private message'))
  ).toHaveLength(0);
  expect(turns).toHaveLength(0);
});

it('M9: the global pending bound cannot be bypassed by creating more seats', async () => {
  vi.useFakeTimers();
  const triggers = (harness.service as unknown as { triggers: { claimed: Map<string, unknown> } })
    .triggers;
  triggers.claimed.set(agentKey(roomId, bo), {
    roomId,
    authorId: bo,
    sessionId: 'seat-chat',
    agentPath: '/agents/bo',
    claimedAt: new Date().toISOString(),
  });
  if (!seatInbox) throw new Error('Missing production seat inbox');
  // The cap owns durable private admissions. Public notice/indexing behavior is
  // covered by M8. A small global bound proves the same rule without 1,000 rows,
  // which timed out on loaded CI (DOR-4722); the real defaults are pinned below.
  seatInbox.stop();
  setSeatInbox(
    harness.service.createSeatMessages(receipts, () => undefined, {
      pendingMax: SEAT_MESSAGE_PENDING_MAX,
      globalMax: 10,
    })
  );
  for (let n = 0; n < 5; n++) {
    const room = harness.service.createRoom(
      roomSpec('channel', `Queue ${n}`, ['/agents/bo', '/agents/ana']),
      harness.human
    );
    const session = `global-seat-${n}`;
    harness.store.bindRoomSession(room.id, bo, session, new Date().toISOString());
    const target = seatInbox.resolveSeatTarget(session);
    if (!target) throw new Error('Missing real ledger seat');
    // Each seat stays under its own bound; only their total reaches the global one.
    for (let j = 0; j < 2; j++) {
      const row: NewChatMessage = {
        id: `pending-${n}-${j}`,
        toSessionId: session,
        fromSessionId: caller.sessionId,
        fromAgentPath: caller.agentPath,
        fromAgentId: 'agent-ana',
        fromAgentName: 'Ana',
        fromChatTitle: null,
        kind: 'message',
        text: `queued-${n}-${j}`,
        summary: null,
        nonce: null,
        delivery: 'queue',
        status: 'queued',
        queueMessageId: `queue-${n}-${j}`,
        ceilingJson: JSON.stringify(loose),
        replyToId: null,
      };
      expect(
        seatInbox.admit({
          target,
          row,
          rendered: renderSeatMessage(row),
          carried: seatCarryOf(row),
        }).status
      ).toBe('queued');
    }
  }
  await expect(
    chats.send(caller, { to: 'seat-chat', message: 'global overflow' })
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(receipts.pendingSeatMessages()).toHaveLength(10);
  expect(receipts.listSentFrom(caller.sessionId)).toHaveLength(10);
  expect(turns).toHaveLength(0);
});

it('M9: the inbox boot wires through setRoomSeatRoutes runs at the real bounds', async () => {
  expect(SEAT_MESSAGE_PENDING_MAX).toBe(25);
  expect(SEAT_MESSAGE_GLOBAL_MAX).toBe(1_000);
  // Production factories pass no limits; the shrunken tests must not leak into them.
  const { setRoomSeatRoutes, setRoomSeatReports, wireRoomSeatMessageLifetime } =
    await import('../../../session/chat-messages/chat-message-current.js');
  setRoomSeatRoutes(harness.service);
  const lifetime = wireRoomSeatMessageLifetime(receipts, () => undefined);
  try {
    expect((lifetime.get() as unknown as { limits: SeatMessageLimits }).limits).toEqual({
      pendingMax: SEAT_MESSAGE_PENDING_MAX,
      globalMax: SEAT_MESSAGE_GLOBAL_MAX,
    });
  } finally {
    lifetime.stop();
    setRoomSeatReports(undefined);
  }
});

it('M9: no production source can hand an inbox smaller bounds', () => {
  // Limits are a constructor option for tests only: no config key, route, env var or tool.
  const src = fileURLToPath(new URL('../../../../', import.meta.url));
  const sources = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.split(/[\\/]/u).includes('__tests__'))
    .map((file) => ({
      file: file.replace(/\\/gu, '/'),
      text: readFileSync(join(src, file), 'utf8'),
    }));
  const callers = sources
    .flatMap(({ file, text }) =>
      (
        text.match(
          /(?:createSeatMessages|new RoomSeatMessages|seatMessageFactory\?\.)\([^)]*\)/gu
        ) ?? []
      ).map((call) => `${file}: ${call.replace(/\s+/gu, ' ')}`)
    )
    .sort();
  // The one forwarding factory, and the two production calls that pass it no limits. The boot
  // wrapper in chat-message-current also drops any third argument, so nothing can thread one.
  expect(callers).toEqual([
    'services/rooms/room-service.ts: new RoomSeatMessages(this.parts.core, this.parts.publisher, store, emit, limits)',
    'services/session/chat-messages/chat-message-current.ts: createSeatMessages(store, emit)',
    'services/session/chat-messages/chat-message-current.ts: seatMessageFactory?.(store, emit)',
  ]);
  // Only the inbox and its types name the bounds: no config schema, route, env or tool does.
  expect(
    sources
      .filter(({ text }) => /\b(?:SeatMessageLimits|pendingMax|globalMax)\b/u.test(text))
      .map(({ file }) => file)
      .sort()
  ).toEqual([
    'services/rooms/handoff/seat-message-types.ts',
    'services/rooms/handoff/seat-messages.ts',
  ]);
  expect(
    sources.find(({ file }) => file === 'services/rooms/handoff/seat-messages.ts')?.text
  ).toMatch(/limits: SeatMessageLimits = DEFAULT_LIMITS/u);
});

it('M4: the actual Full turn record retains level while raise and destructive gates retain the card', async () => {
  await chats.send(
    { ...caller, marksAtTurnEnd: { outsider: true } },
    { to: 'seat-chat', message: 'A marked request.' }
  );
  await seatInbox?.idle();
  const turn = turns[0]!;
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for (const [id, marked] of [
    ['sensitive-marked', true],
    ['sensitive-control', false],
  ] as const) {
    const opts = turnBoundsOf({
      additionalDirectories: [],
      ...(marked
        ? { permissionCeiling: turn.permissionCeiling, carriedOutsider: turn.carriedOutsider }
        : {}),
    });
    for await (const _event of runtime.sendMessage(id, 'private words', opts)) {
      /* record */
    }
    expect(lastTurnLevelOf(id)).toMatchObject(loose);
    expect(ownExtensionsWritable({}, id, '/agents/bo')).toBe(marked ? undefined : '/agents/bo');
    const principal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'test-install' },
      bindingId: 'test-binding',
      runtime: 'claude-code',
      canonicalSessionId: id,
      agentId: 'bo',
      agentPath: '/agents/bo',
    });
    const scope = {
      ownerKind: 'local_install' as const,
      ownerId: 'test-install',
      agentId: 'bo',
      sessionId: id,
      connectionId: 'local-test-connection',
      operationRevisionId: 'delete-test-item',
    };
    const preflight: CapabilityPreflightResult = {
      authorityBinding: createCapabilityAuthorityBinding({
        ...scope,
        digest: createHash('sha256').update(JSON.stringify(scope)).digest('hex'),
      }),
      approvalServiceAction: ApprovalServiceActionSchema.parse({
        serviceId: 'test',
        serviceName: 'Test',
        accountLabel: 'Local test account',
        actionName: 'Delete test item',
        details: [],
      }),
    };
    expect(isCapabilityAuthorityBinding(preflight.authorityBinding)).toBe(true);
    const requester = await holdRequesterFor(
      { sessionId: id, serverPrincipal: principal },
      preflight,
      {
        trusted: () => true,
        describeAgent: async () => ({
          agentPath: '/agents/bo',
          displayName: 'Bo',
          createdAt: '2026-11-15',
        }),
        turnLevel: lastTurnLevelOf,
        strangerTurn: (session, agentPath) => marksOf(session, agentPath).outsider === true,
        plainWifiOpen: () => false,
        chosenFull: () => true,
      }
    );
    if (marked) expect(requester).toBeUndefined();
    else expect(requester?.sessionId).toBe(id);
  }
});

it('M9: an exhausted automatic-turn budget refuses without a row or trace', async () => {
  const h = createRoomHarness({
    agents,
    runner: outcomeRunner(() => ({ text: null })),
    turnLimitsEnabled: true,
    maxAutomaticTurnsPerRoomPerHour: 1,
    maxAutomaticTurnsTotalPerHour: 1,
  });
  const room = h.service.createRoom(
    roomSpec('channel', 'Budget', ['/agents/bo', '/agents/ana']),
    h.human
  );
  const author = h.authors.resolveAgent('/agents/bo', 'Bo').id;
  h.store.bindRoomSession(room.id, author, 'budget-seat', new Date().toISOString());
  const store = new ChatMessageStore(h.db);
  const inbox = h.service.createSeatMessages(store, () => undefined);
  const row = {
    id: 'budget-one',
    toSessionId: 'budget-seat',
    fromSessionId: 'sender',
    fromAgentPath: '/agents/ana',
    fromAgentId: 'ana',
    fromAgentName: 'Ana',
    fromChatTitle: null,
    kind: 'message' as const,
    text: 'Private budget test',
    summary: null,
    nonce: '00112233',
    delivery: 'queue' as const,
    status: 'queued' as const,
    queueMessageId: 'budget-queue',
    ceilingJson: '"none"',
    replyToId: null,
  };
  const { renderSeatMessage, seatCarryOf } = await import('../../handoff/seat-message-prompt.js');
  const input = {
    target: inbox.resolveSeatTarget('budget-seat')!,
    row,
    rendered: renderSeatMessage(row),
    carried: seatCarryOf(row),
  };
  inbox.admit(input);
  await inbox.idle();
  expect(store.get(row.id)?.status).toBe('delivered');
  expect(() => inbox.admit({ ...input, row: { ...row, id: 'budget-two' } })).toThrow('budget');
  expect(store.get('budget-two')).toBeUndefined();
  expect(
    h.store
      .listEntries(room.id, { limit: 100 })
      .filter((e) => e.body.text.includes('a private message'))
  ).toHaveLength(1);
  inbox.stop();
});

it('M9: pending expiry runs while an earlier aside is still executing', async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const runner = (
    harness.service as unknown as {
      triggers: { deps: { runner: { run: (request: RoomTurnRequest) => Promise<unknown> } } };
    }
  ).triggers.deps.runner;
  runner.run = async (request) => {
    turns.push(request);
    await new Promise<void>((resolve) => {
      finish = resolve;
      deferredFinishes.add(resolve);
    });
    return { text: null, sessionId: request.sessionId };
  };
  const first = await chats.send(caller, {
    to: 'seat-chat',
    message: 'Long running private turn.',
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const second = await chats.send(caller, {
    to: 'seat-chat',
    message: 'Never launched behind the long turn.',
  });
  await vi.advanceTimersByTimeAsync(60 * 60_000 + 1);
  expect(receipts.get(first.messageId)?.status).toBe('working');
  expect(receipts.get(second.messageId)?.status).toBe('failed');
  expect(turns).toHaveLength(1);
  finish!();
  await seatInbox?.idle();
  expect(receipts.get(first.messageId)?.status).toBe('delivered');
  expect(receipts.get(second.messageId)?.status).toBe('failed');
  expect(turns).toHaveLength(1);
});

it.each(['rooms-first', 'receipts-first'] as const)(
  'M9: %s startup settles interrupted private rows before any new send',
  async (order) => {
    const { wireRoomSeatMessageLifetime, setRoomSeatMessageFactory } =
      await import('../../../session/chat-messages/chat-message-current.js');
    setRoomSeatMessageFactory(undefined);
    receipts.insert({
      id: 'boot-pending',
      toSessionId: 'seat-chat',
      fromSessionId: caller.sessionId,
      fromAgentPath: caller.agentPath,
      fromAgentId: 'ana',
      fromAgentName: 'Ana',
      fromChatTitle: null,
      kind: 'message',
      text: 'Interrupted private words',
      summary: null,
      nonce: '11112222',
      delivery: 'queue',
      status: 'working',
      queueMessageId: 'boot-private',
      ceilingJson: '"none"',
      replyToId: null,
      deliveryRoute: 'seat',
      seatRoomId: roomId,
      seatAuthorId: bo,
      seatJoinedAt: harness.store.getMember(roomId, bo)!.joinedAt,
      seatSessionId: 'seat-chat',
    });
    const factory = (store: ChatMessageStore, emit: (id: string) => void) =>
      harness.service.createSeatMessages(store, emit);
    try {
      if (order === 'rooms-first') {
        setRoomSeatMessageFactory(factory);
        wireRoomSeatMessageLifetime(receipts, () => undefined);
      } else {
        expect(wireRoomSeatMessageLifetime(receipts, () => undefined).get()).toBeUndefined();
        setRoomSeatMessageFactory(factory);
      }
      expect(receipts.get('boot-pending')?.status).toBe('failed');
      expect(turns).toHaveLength(0);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      setRoomSeatMessageFactory(undefined);
    }
  }
);

it('M9: production messaging cleanup settles live receipts while the database is still open', async () => {
  vi.useFakeTimers();
  const { stopAgentMessageServices } = await import('../../../../startup/stop-agent-messages.js');
  const { setChatMessageService } =
    await import('../../../session/chat-messages/chat-message-current.js');
  const triggers = (harness.service as unknown as { triggers: { claimed: Map<string, unknown> } })
    .triggers;
  triggers.claimed.set(agentKey(roomId, bo), {
    roomId,
    authorId: bo,
    sessionId: 'seat-chat',
    agentPath: '/agents/bo',
    claimedAt: new Date().toISOString(),
  });
  const receipt = await chats.send(caller, {
    to: 'seat-chat',
    message: 'Pending during shutdown.',
  });
  setChatMessageService(chats);
  try {
    stopAgentMessageServices();
    await seatInbox?.idle();
    expect(receipts.get(receipt.messageId)?.status).toBe('failed');
    await expect(
      chats.send(caller, { to: 'seat-chat', message: 'Too late.' })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    setChatMessageService(undefined);
  }
});

it('M9: recovery interruption wins over a still-active old aside completion', async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const runner = (
    harness.service as unknown as {
      triggers: { deps: { runner: { run: (request: RoomTurnRequest) => Promise<unknown> } } };
    }
  ).triggers.deps.runner;
  runner.run = async (request) => {
    turns.push(request);
    await new Promise<void>((resolve) => {
      finish = resolve;
      deferredFinishes.add(resolve);
    });
    return { text: null, sessionId: request.sessionId };
  };
  const receipt = await chats.send(caller, {
    to: 'seat-chat',
    message: 'Active when recovery takes ownership.',
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(receipts.get(receipt.messageId)?.status).toBe('working');
  // A new composition recovers the durable row while the old runtime callback is still live.
  // Unlike stop(), this intentionally leaves old active ownership in place: CAS must discriminate.
  const recovered = harness.service.createSeatMessages(receipts, () => undefined);
  expect(receipts.get(receipt.messageId)?.status).toBe('failed');
  finish!();
  await seatInbox?.idle();
  expect(receipts.get(receipt.messageId)?.status).toBe('failed');
  expect(turns).toHaveLength(1);
  recovered.stop();
});
