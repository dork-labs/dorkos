import type { RoomHarness } from './room-test-harness.js';
/**
 * A post handed to a busy room chat lands within minutes, or the sender hears why at once
 * (DOR-4252). Before, a hand-off waited up to an hour for a room chat in a long turn and could end
 * with only "it stayed busy for an hour". Driven through the real registry, service, dispatcher
 * and durable outbox, like `handoff-admission-clock.test.ts`; only the turn runner stands in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { initAgentPause, resetAgentPause } from '../../mesh/pause/agent-pause.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { roomsDomain } from '../room-capabilities.js';
import { resetFreshnessForTests } from '../messages/room-freshness.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  roomVoice,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

/** How long a room chat gets to take a hand-off before DorkOS posts it for that chat. */
const SEAT_WAIT_MS = 2 * 60_000;

const agents = agentLookupFor({
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

const BO: AgentIdentity = {
  agentPath: '/agents/bo',
  displayName: 'Bo',
  createdAt: new Date().toISOString(),
};

interface HandoffStatus {
  status: 'pending' | 'posted' | 'declined' | 'unknown';
  waiting?: string;
  reason?: string;
  entryId?: string;
}

/** The live claim fields this test reads, which no public method returns. */
interface ClaimView {
  dispatchId: string;
  spokeViaTool: boolean;
}

/** Record a real turn level for a drafting chat; only the model stream is replaced. */
async function recordDraftTurn(sessionId: string, opts?: MessageOpts): Promise<void> {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'default'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'draft', opts)) {
    /* drain */
  }
}

describe('a hand-off to a busy room chat (DOR-4252)', () => {
  let temporaryHome: string;
  let closeDatabase: () => void;
  let harness: RoomHarness;
  let service: RoomService;
  let store: RoomStore;
  let registry: CapabilityRegistry;
  let room: RoomWithRoster;
  let bo: string;
  let notified: number;
  /** Hand-off turns the room chat took. */
  let entered: string[];
  /** Whether the runtime refuses a hand-off turn as busy (background work in the chat). */
  let runtimeBusy: boolean;
  /** Whether the room chat answers its first hand-off without posting it. */
  let declineFirst: boolean;
  /** Holds Bo's ordinary room turn open: the long turn the room chat is busy with. */
  let releaseLong: () => void;
  let longTurn: Promise<void>;
  /** Holds the first hand-off turn the room chat takes. */
  let releaseFirstHandoff: () => void;
  let firstHandoff: Promise<void>;

  async function postAsBo(sessionId: string, input: Record<string, unknown>) {
    const { recordFixturePublicSource } = await import('./durable-handoff-fixture.js');
    await recordFixturePublicSource(harness, sessionId, '/agents/bo', input.roomId as string);
    return registry.invoke('rooms.post', input, {
      identity: BO,
      sessionId,
      retryChannel: 'mcp-argument',
    }) as Promise<{ handoffId?: string; posted: boolean }>;
  }
  async function handOffFor(text: string, sessionId = 'bo-direct-chat') {
    const result = (await postAsBo(sessionId, { roomId: room.id, text })) as {
      handoffId?: string;
      instruction?: string;
    };
    expect(result).toMatchObject({ posted: false, handedOff: true });
    return { id: result.handoffId!, instruction: result.instruction ?? '' };
  }
  async function handOff(text: string, sessionId = 'bo-direct-chat'): Promise<string> {
    return (await handOffFor(text, sessionId)).id;
  }
  /** The drafting chat reads the room, as `post_to_room`'s description asks it to. */
  async function readRoomAs(sessionId: string): Promise<void> {
    await registry.invoke(
      'rooms.read_history',
      { roomId: room.id, limit: 20 },
      { identity: BO, sessionId, retryChannel: 'mcp-argument' }
    );
  }
  function firstLines(): string[] {
    return bosPosts().map((post) => post.body.text.split('\n')[0]!);
  }
  function statusOf(id: string): Promise<HandoffStatus> {
    return registry.invoke(
      'rooms.handoff_status',
      { handoffId: id },
      { identity: BO, sessionId: 'bo-direct-chat', retryChannel: 'mcp-argument' }
    ) as Promise<HandoffStatus>;
  }
  function bosPosts(): RoomEntry[] {
    return store
      .listEntries(room.id, { limit: 50 })
      .filter((entry) => entry.kind === 'post' && entry.authorId === bo);
  }
  function liveClaim(): ClaimView | undefined {
    const triggers = (service as unknown as { triggers: { claimed: Map<string, ClaimView> } })
      .triggers;
    return [...triggers.claimed.values()][0];
  }
  async function reached(predicate: () => boolean, description: string): Promise<void> {
    for (let i = 0; i < 2000; i++) {
      if (predicate()) return;
      await vi.advanceTimersByTimeAsync(0);
    }
    throw new Error(`Did not reach: ${description}`);
  }
  /** Bo's ordinary turn in the room, asked by a person, still running. */
  async function startLongTurn(): Promise<ClaimView> {
    service.post(room.id, { authorId: harness.human, text: '@bo please run the long job' });
    await reached(() => liveClaim() !== undefined, 'the long room turn holds its claim');
    return { ...liveClaim()! };
  }

  beforeEach(() => {
    temporaryHome = mkdtempSync(join(tmpdir(), 'handoff-busy-seat-'));
    vi.stubEnv('DORK_HOME', temporaryHome);
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-25T09:00:00.000Z'));
    resetFreshnessForTests();
    entered = [];
    notified = 0;
    runtimeBusy = false;
    declineFirst = false;
    longTurn = new Promise<void>((resolve) => {
      releaseLong = resolve;
    });
    firstHandoff = new Promise<void>((resolve) => {
      releaseFirstHandoff = resolve;
    });
    const runner: ScriptedTurnRunner = {
      turns: [],
      interrupted: [],
      ...roomVoice(),
      interrupt: () => Promise.resolve(mockInterruptReceipt('not-running')),
      async run(request) {
        const sessionId = request.sessionId ?? 'bo-seat';
        request.onSessionBound(sessionId);
        if (!request.prompt.includes('BEGIN HANDED-OFF DRAFT')) {
          await longTurn;
          return { sessionId, text: null };
        }
        entered.push(request.prompt);
        if (runtimeBusy) return { sessionId, text: null, unanswered: 'busy' as const };
        if (entered.length === 1) await firstHandoff;
        if (entered.length === 1 && declineFirst) return { sessionId, text: 'Not now.' };
        await postAsBo(sessionId, {
          roomId: room.id,
          text: `seat answer ${entered.length}`,
          confirm: true,
        });
        return { sessionId, text: null };
      },
    };
    harness = createRoomHarness({ agents, runner, operatorName: () => 'Casey' });
    ({ service, store } = harness);
    service.handoffs.initializeDurable(() => {
      notified += 1;
    });
    closeDatabase = () => harness.db.$client.close();
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: service },
    });
    room = service.createRoom(
      { kind: 'channel', title: 'launch', members: [], agentPaths: ['/agents/bo'] },
      harness.human
    );
    bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    store.bindRoomSession(room.id, bo, 'bo-seat', new Date().toISOString());
  });

  afterEach(async () => {
    releaseLong();
    releaseFirstHandoff();
    resetAgentPause();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await service.triggersIdle();
      await service.handoffs.idle();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      resetPermissionGate();
      vi.unstubAllEnvs();
      closeDatabase?.();
      if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true });
    }
  });

  it('posts a current draft handed to a chat mid-turn within two minutes, without touching that turn', async () => {
    const live = await startLongTurn();
    await readRoomAs('bo-direct-chat');
    const sentAt = Date.now();
    const { id, instruction } = await handOffFor('The release notes are ready.');
    expect(instruction).toContain('nothing new has been said in #launch since this chat read it');

    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS - 1);
    expect((await statusOf(id)).status).toBe('pending');
    expect(bosPosts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await reached(() => bosPosts().length === 1, 'the draft is posted');

    const status = await statusOf(id);
    expect(status.status).toBe('posted');
    expect(Date.now() - sentAt).toBeLessThanOrEqual(SEAT_WAIT_MS);
    const [post] = bosPosts();
    expect(post!.id).toBe(status.entryId);
    // Who asked, and from where, as a seat's own post of it says.
    expect(post!.body.text).toBe('The release notes are ready.\n\n_Shared from another chat._');
    // Its own turn at the ceiling: it wakes nobody and is never read as a reply.
    expect(post!.cascadeRoot).toBe(post!.id);
    expect(post!.threadRootEntryId).toBeNull();
    // The long turn still owns the room chat, with its own dispatch and its own voice.
    expect(liveClaim()).toMatchObject({ dispatchId: live.dispatchId, spokeViaTool: false });
    expect(store.handoffOutbox.readOwned(id, bo)?.dispatchId).not.toBe(live.dispatchId);
    expect(entered).toHaveLength(0);
    expect(notified).toBeGreaterThan(0);
  });

  it('counts each wait from when its draft was sent, time in the queue included', async () => {
    await startLongTurn();
    await readRoomAs('bo-direct-chat');
    await handOff('first update');
    await vi.advanceTimersByTimeAsync(60_000);
    const secondAt = Date.now();
    const second = await handOff('second update');

    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS - 60_000);
    await reached(() => bosPosts().length === 1, 'the first draft is posted');
    // The first draft's own post is not news to the chat that wrote both.
    await vi.advanceTimersByTimeAsync(secondAt + SEAT_WAIT_MS - Date.now() - 1);
    expect((await statusOf(second)).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await reached(() => bosPosts().length === 2, 'the queued draft is posted');
    expect(Date.now() - secondAt).toBeLessThanOrEqual(SEAT_WAIT_MS);
    expect(firstLines()).toEqual(['first update', 'second update']);
  });

  it('keeps hand-offs to one room chat in order: a due draft waits for the one it is working on (F)', async () => {
    await readRoomAs('bo-direct-chat');
    await handOff('first, which the room chat takes and works on');
    await reached(() => entered.length === 1, 'the room chat took the first draft');
    await vi.advanceTimersByTimeAsync(10_000);
    const second = await handOff('second, queued behind it');

    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS * 2);
    expect(bosPosts()).toHaveLength(0);
    expect((await statusOf(second)).status).toBe('pending');
    releaseFirstHandoff();
    await service.handoffs.idle();
    // The room moved on (the first answer), so the room chat re-read and posted the second.
    expect(firstLines()).toEqual(['seat answer 1', 'seat answer 2']);
    expect(await statusOf(second)).toMatchObject({ status: 'posted' });
  });

  it('posts a current draft the room chat keeps refusing as busy within two minutes', async () => {
    runtimeBusy = true;
    await readRoomAs('bo-direct-chat');
    const id = await handOff('Background work is holding the room chat.');
    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS);
    await reached(() => bosPosts().length === 1, 'the draft is posted');
    expect(await statusOf(id)).toMatchObject({ status: 'posted' });
    expect(entered.length).toBeGreaterThan(0);
  });

  it('keeps a draft the room moved on from for the room chat, says so, and never drops it', async () => {
    await startLongTurn();
    await readRoomAs('bo-direct-chat');
    const id = await handOff('Release shipped: v1.2 is live.');
    await vi.advanceTimersByTimeAsync(30_000);
    service.post(room.id, { authorId: harness.human, text: 'lunch at 1?' });

    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS);
    const waiting = await statusOf(id);
    expect(waiting).toMatchObject({ status: 'pending', waiting: 'room_moved' });
    expect(waiting.reason).toMatch(/room moved on .*re-reads the room when it is free/);
    expect(bosPosts()).toHaveLength(0);
    // The room chat comes free, re-reads with the draft in hand, and answers.
    releaseLong();
    releaseFirstHandoff();
    await vi.advanceTimersByTimeAsync(0);
    await service.handoffs.idle();
    expect(entered).toHaveLength(1);
    expect(firstLines()).toEqual(['seat answer 1']);
    expect(await statusOf(id)).toMatchObject({ status: 'posted' });
  });

  it('never posts for a chat that has not read the room, and says so at once', async () => {
    service.post(room.id, { authorId: harness.human, text: 'Stop the release plan.' });
    await startLongTurn();
    const { id, instruction } = await handOffFor('Continuing the release plan.');
    expect(instruction).toContain('This chat has not read #launch, so only that chat may post it.');

    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS * 2);
    expect((await statusOf(id)).status).toBe('pending');
    expect(bosPosts()).toHaveLength(0);
    releaseLong();
    releaseFirstHandoff();
    await vi.advanceTimersByTimeAsync(0);
    await service.handoffs.idle();
    expect(entered).toHaveLength(1);
  });

  /** Pause Bo for exactly one lookup, so a stand-in asking the wrong one finds no pause. */
  function pauseBoBy(lookup: 'agent' | 'room chat'): void {
    const ref = { id: bo, name: 'bo', pausedAt: new Date().toISOString() };
    initAgentPause({
      pausedAgentOfTurn: (opts?: { forAgent?: string }) =>
        lookup === 'agent' && opts?.forAgent === '/agents/bo' ? ref : undefined,
      pausedAgentOfSession: (sessionId: string) =>
        lookup === 'room chat' && sessionId === 'bo-seat' ? ref : undefined,
      pausedAgent: () => undefined,
      recordHeld: () => {},
      list: () => [ref],
    } as never);
  }

  for (const lookup of ['agent', 'room chat'] as const) {
    it(`declines at once when the agent is paused (found by its ${lookup}), and posts nothing`, async () => {
      await startLongTurn();
      await readRoomAs('bo-direct-chat');
      pauseBoBy(lookup);
      const id = await handOff('Posted while paused.');

      await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS);
      const status = await statusOf(id);
      expect(status).toMatchObject({ status: 'declined', reason: 'it is paused.' });
      expect(store.handoffOutbox.readOwned(id, bo)).toMatchObject({ noticeState: 'ready' });
      expect(bosPosts()).toHaveLength(0);
    });
  }

  it('never posts for a chat that has not read the room, even in a quiet room', async () => {
    service.post(room.id, { authorId: harness.human, text: 'Stop the release plan.' });
    await startLongTurn();
    const id = await handOff('Continuing the release plan.');
    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS * 3);
    expect(bosPosts()).toHaveLength(0);
    expect((await statusOf(id)).status).toBe('pending');
  });

  it('gives a due draft to the room chat first when it came free without posting the last one', async () => {
    declineFirst = true;
    await readRoomAs('bo-direct-chat');
    await handOff('first, which the room chat decides against');
    await reached(() => entered.length === 1, 'the room chat took the first draft');
    const second = await handOff('second, due by the time the first is done');
    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS * 2);
    releaseFirstHandoff();
    await service.handoffs.idle();
    expect(entered).toHaveLength(2);
    expect(firstLines()).toEqual(['seat answer 2']);
    expect(await statusOf(second)).toMatchObject({ status: 'posted' });
  });

  it('keeps a draft written after reading outside words with the room chat, and says so at once', async () => {
    await recordDraftTurn('bo-marked-chat', { carriedMarks: { outsider: true } });
    await startLongTurn();
    await readRoomAs('bo-marked-chat');
    const { id, instruction } = await handOffFor('Words a stranger asked for.', 'bo-marked-chat');
    expect(instruction).toContain('This chat read words from outside your team');

    await vi.advanceTimersByTimeAsync(SEAT_WAIT_MS * 2);
    expect((await statusOf(id)).status).toBe('pending');
    expect(bosPosts()).toHaveLength(0);
  });
});
