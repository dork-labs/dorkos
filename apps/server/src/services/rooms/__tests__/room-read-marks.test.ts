/**
 * A room read that returns words from outside the team marks the turn that read them (DOR-3969,
 * spec §4.7), through the real `rooms` capabilities over the real rooms service: a bridged
 * stranger's post in what `read_room_history`, `search_room_history` or `search_member_rooms`
 * returned marks the calling chat's turn, so a send later in it is held. A read of the team's own
 * posts leaves the turn clean.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import { marksOf, recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { roomsDomain } from '../room-capabilities.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-11-17T12:00:00.000Z',
};

let counter = 0;
const fresh = () => `room-read-marks-${(counter += 1)}`;

/** Run one turn in a chat set to Full autonomy, so its level is recorded. */
async function ranAtFull(sessionId: string) {
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
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

describe('a room read marks the turn when it returns outside words', () => {
  let harness: RoomHarness;
  let registry: CapabilityRegistry;
  let roomId: string;

  beforeEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    roomId = harness.service.createRoom(
      {
        kind: 'channel',
        title: 'Garden club',
        members: [],
        agentPaths: ['/agents/ana', '/agents/bo'],
      },
      harness.human
    ).id;
  });

  afterEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
  });

  /** A post by Bo, a teammate agent: the team's own words. */
  function boPosts(text: string) {
    const bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    harness.service.post(roomId, { authorId: bo, text });
  }

  /** A post by a stranger on a bridged chat. */
  function strangerPosts(text: string) {
    const river = harness.authors.resolveExternal({
      platformType: 'telegram',
      instanceId: 'bot-example',
      platformUserId: 'platform-person-7',
      displayName: 'River',
    });
    harness.service.addMember(roomId, harness.human, { authorId: river.id });
    harness.service.post(roomId, { authorId: river.id, text });
  }

  /** Call a room tool as Ana, from her chat. */
  function read(id: string, input: Record<string, unknown>, sessionId: string) {
    return registry.invoke(id, input, {
      identity: ANA,
      sessionId,
      mcpServer: 'in-session',
      retryChannel: 'mcp-argument',
    });
  }

  const held = (chat: string) => marksHold(marksOf(chat, ANA.agentPath));

  it("marks the turn that read a stranger's post through read_room_history", async () => {
    strangerPosts('Tomatoes go in after the frost.');
    const chat = fresh();
    await ranAtFull(chat);
    await read('rooms.read_history', { roomId, limit: 20 }, chat);
    expect(held(chat)).toBe(true);
  });

  it("marks the turn that found a stranger's post through either search", async () => {
    strangerPosts('Tomatoes go in after the frost.');
    const one = fresh();
    await ranAtFull(one);
    await read('rooms.search_history', { roomId, query: 'tomatoes' }, one);
    expect(held(one)).toBe(true);
    const two = fresh();
    await ranAtFull(two);
    await read('rooms.search_member_rooms', { query: 'tomatoes' }, two);
    expect(held(two)).toBe(true);
  });

  it("leaves a turn that read only the team's own posts clean", async () => {
    boPosts('Tomatoes go in after the frost.');
    const chat = fresh();
    await ranAtFull(chat);
    await read('rooms.read_history', { roomId, limit: 20 }, chat);
    await read('rooms.search_history', { roomId, query: 'tomatoes' }, chat);
    await read('rooms.search_member_rooms', { query: 'tomatoes' }, chat);
    expect(held(chat)).toBe(false);
  });

  it("leaves a search that missed the stranger's post clean", async () => {
    strangerPosts('Tomatoes go in after the frost.');
    boPosts('Seeds arrive on Friday.');
    const chat = fresh();
    await ranAtFull(chat);
    await read('rooms.search_history', { roomId, query: 'seeds' }, chat);
    expect(held(chat)).toBe(false);
  });
});
