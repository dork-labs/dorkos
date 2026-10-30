/**
 * The stale-post check (DOR-3398, room coordination item 1): an agent's
 * `post_to_room` does not land over messages it has not read. It gets them back
 * instead, and posts once it confirms or revises.
 *
 * Driven through the REAL registry over the REAL rooms service, like
 * `room-capabilities.test.ts`, because the check lives in the capability.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import { roomsDomain } from '../room-capabilities.js';
import { resetFreshnessForTests, STALE_POST_SHOWN_MAX } from '../messages/room-freshness.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

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
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  // Mention-only, so a person's unaddressed message starts no turn for Bo and
  // Bo's read cursor stays where it joined: exactly an agent posting from a
  // room it read a while ago.
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

const BO_IDENTITY: AgentIdentity = {
  agentPath: '/agents/bo',
  displayName: 'Bo',
  createdAt: new Date().toISOString(),
};

interface PostResult {
  posted: boolean;
  reason?: string;
  instruction?: string;
  newMessages?: Array<{ text: string; seq: number }>;
}

describe('the stale-post check', () => {
  let service: RoomService;
  let store: RoomStore;
  let registry: CapabilityRegistry;
  let channel: RoomWithRoster;
  let human: string;

  function asBo(id: string, input: unknown): Promise<unknown> {
    return registry.invoke(id, input, { identity: BO_IDENTITY, retryChannel: 'mcp-argument' });
  }

  function post(input: Record<string, unknown>): Promise<PostResult> {
    return asBo('rooms.post', { roomId: channel.id, ...input }) as Promise<PostResult>;
  }

  function postTexts(): string[] {
    return store
      .listEntries(channel.id, { limit: 100 })
      .filter((entry) => entry.kind === 'post')
      .map((entry) => entry.body.text);
  }

  beforeEach(() => {
    resetFreshnessForTests();
    const harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    ({ service, store, human } = harness);
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: service },
    });
    channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
  });

  afterEach(async () => {
    await service.triggersIdle();
  });

  it('delivers a post when nothing new arrived', async () => {
    await expect(post({ text: 'deploy is green' })).resolves.toMatchObject({ posted: true });
    expect(postTexts()).toEqual(['deploy is green']);
  });

  it('does not count the agent’s own earlier posts as new', async () => {
    await post({ text: 'first' });
    await expect(post({ text: 'second' })).resolves.toMatchObject({ posted: true });
    expect(postTexts()).toEqual(['first', 'second']);
  });

  it('holds a post over unread messages and hands them back, delivering nothing', async () => {
    service.post(channel.id, { authorId: human, text: 'actually, hold the deploy' });
    await service.triggersIdle();

    const result = await post({ text: 'shipping the deploy now' });

    expect(result).toMatchObject({ posted: false, reason: 'new_messages' });
    expect(result.instruction).toContain('confirm: true');
    expect(result.newMessages?.map((m) => m.text)).toEqual(['actually, hold the deploy']);
    expect(postTexts()).toEqual(['actually, hold the deploy']);
  });

  it('delivers the same post unchanged when the agent confirms', async () => {
    service.post(channel.id, { authorId: human, text: 'new info' });
    await service.triggersIdle();
    await post({ text: 'my update' });

    await expect(post({ text: 'my update', confirm: true })).resolves.toMatchObject({
      posted: true,
    });
    expect(postTexts()).toEqual(['new info', 'my update']);
  });

  it('delivers on confirm even without a held post first, at any level', async () => {
    service.post(channel.id, { authorId: human, text: 'new info' });
    await service.triggersIdle();

    await expect(post({ text: 'as you were', confirm: true })).resolves.toMatchObject({
      posted: true,
    });
  });

  it('counts the handed-back messages as read, so a revised post goes through', async () => {
    service.post(channel.id, { authorId: human, text: 'hold the deploy' });
    await service.triggersIdle();
    await post({ text: 'shipping now' });

    await expect(post({ text: 'ok, holding' })).resolves.toMatchObject({ posted: true });
    expect(postTexts()).toEqual(['hold the deploy', 'ok, holding']);
  });

  it('counts reading the room’s newest history as reading it', async () => {
    service.post(channel.id, { authorId: human, text: 'hold the deploy' });
    await service.triggersIdle();
    await asBo('rooms.read_history', { roomId: channel.id, limit: 10 });

    await expect(post({ text: 'ok, holding' })).resolves.toMatchObject({ posted: true });
  });

  it('hands back at most the newest messages, oldest first', async () => {
    for (let i = 1; i <= STALE_POST_SHOWN_MAX + 5; i += 1) {
      service.post(channel.id, { authorId: human, text: `line ${i}` });
    }
    await service.triggersIdle();

    const result = await post({ text: 'late' });

    const texts = result.newMessages?.map((m) => m.text) ?? [];
    expect(texts.length).toBeLessThanOrEqual(STALE_POST_SHOWN_MAX);
    expect(texts.at(-1)).toBe(`line ${STALE_POST_SHOWN_MAX + 5}`);
  });
});
