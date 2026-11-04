/**
 * A hand-off can always be read by its id (DOR-3778). On 2026-11-03 a room chat holding a background
 * shell refused every hand-off turn as busy for up to an hour, and the sender could see nothing:
 * `handedOff: true`, then silence. Driven through the real registry, service and dispatcher, like
 * `room-handoff.test.ts`; only the turn runner stands in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import { HANDOFF_WAIT_MAX_MS } from '../handoff/room-handoff.js';
import { roomsDomain } from '../room-capabilities.js';
import { resetFreshnessForTests } from '../messages/room-freshness.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  roomVoice,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

vi.mock('../../core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/auth/index.js')>()),
  readOwnerAccount: () => null,
}));

vi.mock('../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) => (section === 'auth' ? { enabled: false } : undefined),
    set: () => {},
  },
}));

const agents = agentLookupFor({
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'mention-only' },
});

const identityOf = (name: string): AgentIdentity => ({
  agentPath: `/agents/${name}`,
  displayName: name,
  createdAt: new Date().toISOString(),
});

interface PostResult {
  posted: boolean;
  handoffId?: string;
  reason?: string;
}

interface HandoffStatus {
  status: 'pending' | 'posted' | 'declined' | 'unknown';
  waiting?: string;
  reason?: string;
  entryId?: string;
}

describe('reading a hand-off by its id', () => {
  let service: RoomService;
  let store: RoomStore;
  let registry: CapabilityRegistry;
  let room: RoomWithRoster;
  let human: string;
  let bo: string;
  /** What Bo's seat does on a turn; set by each test. */
  let seatTurn: (request: RoomTurnRequest, sessionId: string) => Promise<string | null>;
  /** Whether the runtime refuses a hand-off's turn, as it does a process it may not restart. */
  let runtimeHolds: boolean;

  function runner(): ScriptedTurnRunner {
    return {
      turns: [],
      interrupted: [],
      ...roomVoice(),
      interrupt: () => Promise.resolve(mockInterruptReceipt('not-running')),
      async run(request) {
        const sessionId = request.sessionId ?? 'bo-seat';
        request.onSessionBound(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (runtimeHolds && request.prompt.includes('BEGIN HANDED-OFF DRAFT')) {
          return { sessionId, text: null, unanswered: 'busy' as const };
        }
        return { sessionId, text: await seatTurn(request, sessionId) };
      },
    };
  }

  function invoke(id: string, input: Record<string, unknown>, sessionId: string, as = 'bo') {
    return registry.invoke(id, input, {
      identity: identityOf(as),
      sessionId,
      retryChannel: 'mcp-argument',
    });
  }

  async function handOff(text: string): Promise<string> {
    const result = (await invoke(
      'rooms.post',
      { roomId: room.id, text },
      'bo-other-chat'
    )) as PostResult;
    expect(result.handoffId).toEqual(expect.any(String));
    return result.handoffId!;
  }

  function statusOf(handoffId: string, as = 'bo', from = 'bo-other-chat'): Promise<HandoffStatus> {
    return invoke('rooms.handoff_status', { handoffId }, from, as) as Promise<HandoffStatus>;
  }

  /** The seat posts the draft it was handed, confirming past a re-read. */
  async function seatPosts(request: RoomTurnRequest, sessionId: string): Promise<null> {
    if (!request.prompt.includes('BEGIN HANDED-OFF DRAFT')) return null;
    const input = { roomId: room.id, text: 'the draft', confirm: true };
    await invoke('rooms.post', input, sessionId);
    return null;
  }

  beforeEach(() => {
    resetFreshnessForTests();
    runtimeHolds = false;
    seatTurn = seatPosts;
    const harness = createRoomHarness({
      agents,
      runner: runner(),
      operatorName: () => 'Dorian',
    });
    ({ service, store, human } = harness);
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: service },
    });
    room = service.createRoom(
      { kind: 'channel', title: 'dorkos', members: [], agentPaths: ['/agents/bo', '/agents/cy'] },
      human
    );
    bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    store.bindRoomSession(room.id, bo, 'bo-seat', new Date().toISOString());
    service.post(room.id, { authorId: human, text: 'morning' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    runtimeHolds = false;
    await service.triggersIdle();
    await service.handoffs.idle();
  });

  it('idle seat: the hand-off starts its turn and ends posted, with the entry', async () => {
    const id = await handOff('ship it');

    expect((await statusOf(id)).status).toBe('pending');
    await service.handoffs.idle();

    const ended = await statusOf(id);
    const posted = store.listEntries(room.id, { limit: 10 }).find((e) => e.authorId === bo);
    expect(ended).toMatchObject({ status: 'posted', entryId: posted?.id });
  });

  it('mid-turn seat: pending and says why, then runs next and ends posted', async () => {
    let finishTurn: () => void = () => {};
    let started: () => void = () => {};
    const midTurn = new Promise<void>((resolve) => (started = resolve));
    seatTurn = async (request, sessionId) => {
      if (request.prompt.includes('BEGIN HANDED-OFF DRAFT')) return seatPosts(request, sessionId);
      started();
      await new Promise<void>((resolve) => (finishTurn = resolve));
      return null;
    };
    service.post(room.id, { authorId: human, text: '@bo long job' });
    await midTurn;

    const id = await handOff('ship it');
    await vi.waitFor(async () => {
      expect(await statusOf(id)).toMatchObject({ status: 'pending', waiting: 'seat_busy' });
    });

    finishTurn();
    await service.triggersIdle();
    await service.handoffs.idle();
    expect((await statusOf(id)).status).toBe('posted');
  });

  it('a seat the runtime holds for background work: pending and says why, never silent', async () => {
    runtimeHolds = true;
    const id = await handOff('ship it');

    await vi.waitFor(async () => {
      const seen = await statusOf(id);
      expect(seen).toMatchObject({ status: 'pending', waiting: 'seat_busy' });
      expect(seen.reason).toMatch(/background work/);
    });

    runtimeHolds = false;
    await service.handoffs.idle();
    expect((await statusOf(id)).status).toBe('posted');
  }, 10_000);

  it('still held when the wait ends: declined with the reason', async () => {
    runtimeHolds = true;
    const id = await handOff('ship it');
    await vi.waitFor(async () => {
      expect((await statusOf(id)).waiting).toBe('seat_busy');
    });

    const later = Date.now() + HANDOFF_WAIT_MAX_MS + 1;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    await service.handoffs.idle();

    expect(await statusOf(id)).toMatchObject({
      status: 'declined',
      reason: 'it stayed busy for an hour.',
    });
  }, 10_000);

  it('a seat that decides against it: declined with its reason', async () => {
    seatTurn = () => Promise.resolve('Already in the room.');
    const id = await handOff('ship it');
    await service.handoffs.idle();

    expect(await statusOf(id)).toMatchObject({
      status: 'declined',
      reason: 'Already in the room.',
    });
  });

  it('only the agent that handed it off can read it', async () => {
    const id = await handOff('ship it');
    await service.handoffs.idle();

    expect((await statusOf(id, 'cy', 'cy-chat')).status).toBe('unknown');
  });

  it('an id it never issued reads the same as somebody else’s', async () => {
    const seen = await statusOf('no-such-hand-off');

    expect(seen.status).toBe('unknown');
    expect(seen.reason).toMatch(/restart/);
  });
});
