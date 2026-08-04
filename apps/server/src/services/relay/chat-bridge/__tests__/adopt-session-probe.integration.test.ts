/**
 * Session adoption against the REAL durable signals (chats-as-channels §7.3).
 *
 * The two things the adopter reads at bridge time are real here, because they
 * are the correctness surface:
 *
 * - the **`sessions.json` fixture** on real disk, read by a real `BindingRouter`
 *   through `takeChatSession` — so the "find the single `{bindingId}:chat:{chatId}`
 *   entry, remove it, persist" contract runs against the actual store, not a stub;
 * - the **claude-code `TranscriptReader.hasTranscript`** — the JSONL-on-disk
 *   probe the spec insists on ("USE THE EXISTING READER — DO NOT WRITE A SECOND
 *   ONE"), pointed at a temp Claude account.
 *
 * The room-session ledger is the real `RoomService`/`RoomStore` (the harness).
 * Only the SDK's title lookup and the Claude config-dir resolver are mocked, to
 * point the reader at the temp account without touching a developer's `~/.claude`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';

const hoisted = vi.hoisted(() => ({ claudeDir: '' }));

// vi.mock is hoisted above the imports below; point the reader at a temp
// account and stub the SDK title lookup and the boundary check.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../runtimes/claude-code/claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => hoisted.claudeDir,
  resolveClaudeRootSet: () => [hoisted.claudeDir],
}));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue(undefined),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));

import { TranscriptReader } from '../../../runtimes/claude-code/sessions/transcript-reader.js';
import { BindingRouter } from '../../binding-router.js';
import {
  BridgeLifecycle,
  BridgeSessionAdopter,
  type LifecycleBinding,
  type TranscriptProbe,
  type BridgeCreateInput,
} from '../index.js';

const ADAPTER = 'tg-main';
const BINDING_ID = 'binding-ana';
const AGENT_ID = 'agent-1';
const AGENT_PATH = '/agents/ana';
const CHAT_ID = '555';
const VAULT_ROOT = '/work/ana';

const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

describe('session adoption against real sessions.json + TranscriptReader (§7.3)', () => {
  let harness: RoomHarness;
  let claudeDir: string;
  let relayDir: string;
  let reader: InstanceType<typeof TranscriptReader>;
  let router: InstanceType<typeof BindingRouter>;

  /** The production-shaped probe: only claude-code answers, backed by the reader. */
  function realProbe(): TranscriptProbe {
    return {
      canProbe: (runtimeType) => runtimeType === 'claude-code',
      hasTranscript: (vaultRoot, sessionId) => reader.hasTranscript(vaultRoot, sessionId),
    };
  }

  /** Write a `sessions.json` fixture the router will load on init(). */
  async function seedSessions(entries: [string, string][]): Promise<void> {
    await writeFile(join(relayDir, 'sessions.json'), JSON.stringify(entries));
  }

  /** Put a real JSONL transcript on disk under the temp account, so hasTranscript finds it. */
  async function writeTranscript(sessionId: string): Promise<void> {
    const slug = reader.getProjectSlug(VAULT_ROOT);
    const dir = join(claudeDir, 'projects', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'earlier' },
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd: VAULT_ROOT,
      }) + '\n'
    );
  }

  async function startRouter(): Promise<void> {
    router = new BindingRouter({
      bindingStore: { resolve: vi.fn() } as never,
      relayCore: { publish: vi.fn(), subscribe: vi.fn(() => vi.fn()) } as never,
      agentManager: { createSession: vi.fn().mockResolvedValue({ id: 'new' }) } as never,
      meshCore: { getProjectPath: vi.fn().mockReturnValue(VAULT_ROOT) } as never,
      relayDir,
    });
    await router.init();
  }

  function makeLifecycle(): BridgeLifecycleHandle {
    const adopter = new BridgeSessionAdopter({
      takeChatSession: (bindingId, chatId) => router.takeChatSession(bindingId, chatId),
      getSessionRuntimeType: () => Promise.resolve('claude-code'),
      probe: realProbe(),
      resolveAgentRoot: () => VAULT_ROOT,
      rooms: harness.service,
    });
    const bindings = new Map<string, LifecycleBinding>([
      [
        BINDING_ID,
        { id: BINDING_ID, adapterId: ADAPTER, chatId: CHAT_ID, bridge: 'off', roomId: null },
      ],
    ]);
    const update = vi.fn(
      async (id: string, updates: { bridge?: 'off' | 'room'; roomId?: string | null }) => {
        const next = { ...bindings.get(id)!, ...updates };
        bindings.set(id, next);
        return next;
      }
    );
    const lifecycle = new BridgeLifecycle({
      rooms: harness.service,
      bridges: harness.bridges,
      bindings: { getById: (id) => bindings.get(id), update },
      chatNotice: async () => true,
      operatorAuthorId: () => harness.human,
      adopter,
    });
    return { lifecycle };
  }

  interface BridgeLifecycleHandle {
    lifecycle: InstanceType<typeof BridgeLifecycle>;
  }

  function createInput(): BridgeCreateInput {
    return {
      adapterId: ADAPTER,
      chatId: CHAT_ID,
      bindingId: BINDING_ID,
      agentId: AGENT_ID,
      chatType: 'private',
      channelType: null,
      title: 'Miguel',
      agentPath: AGENT_PATH,
    };
  }

  function agentAuthorId(roomId: string): string {
    return harness.service
      .getRoom(roomId, harness.human)!
      .members.find((m) => m.author.kind === 'agent')!.authorId;
  }

  beforeEach(async () => {
    harness = createRoomHarness({ agents: agentLookup, runner: scriptedRunner(() => 'ok') });
    claudeDir = await mkdtemp(join(tmpdir(), 'adopt-claude-'));
    relayDir = await mkdtemp(join(tmpdir(), 'adopt-relay-'));
    hoisted.claudeDir = claudeDir;
    reader = new TranscriptReader();
  });

  afterEach(async () => {
    await router?.shutdown();
    vi.restoreAllMocks();
    await rm(claudeDir, { recursive: true, force: true });
    await rm(relayDir, { recursive: true, force: true });
  });

  it('probe PASS: a real transcript on disk adopts the fixture session and vacates sessions.json', async () => {
    await seedSessions([[`${BINDING_ID}:chat:${CHAT_ID}`, 'sess-real']]);
    await writeTranscript('sess-real');
    await startRouter();

    const { lifecycle } = makeLifecycle();
    const { id, adopted } = await lifecycle.bridge(createInput());

    expect(adopted).toBe(true);
    // The room-session ledger now points the (room, agent) pair at the adopted id.
    expect(harness.store.getRoomSession(id, agentAuthorId(id))).toBe('sess-real');
    // The entry left sessions.json (persisted): the router no longer holds it.
    expect(router.getSessionsByBinding(BINDING_ID)).toHaveLength(0);
    // The room log gained the pointer notice, and NOT the old messages.
    const notices = harness.store
      .listEntries(id, { limit: 100 })
      .filter((e) => e.kind === 'notice' && e.body.notice === 'bridge_history_note');
    expect(notices).toHaveLength(1);
    expect((notices[0].body as { text: string }).text).toContain('picks up a conversation');
  });

  it('probe FAIL: a stale sessions.json id with no transcript starts fresh and still vacates the map', async () => {
    await seedSessions([[`${BINDING_ID}:chat:${CHAT_ID}`, 'sess-ghost']]);
    // No writeTranscript: the id names a session with no JSONL on disk.
    await startRouter();

    const { lifecycle } = makeLifecycle();
    const { id, adopted } = await lifecycle.bridge(createInput());

    expect(adopted).toBe(false);
    // Nothing bound: the first turn will mint a fresh id.
    expect(harness.store.getRoomSession(id, agentAuthorId(id))).toBeNull();
    // The stale entry is gone from sessions.json regardless — it must not be
    // resurrectable by a later unbridge (§7.4).
    expect(router.getSessionsByBinding(BINDING_ID)).toHaveLength(0);
    const notice = harness.store
      .listEntries(id, { limit: 100 })
      .find((e) => e.kind === 'notice' && e.body.notice === 'bridge_history_note');
    expect((notice!.body as { text: string }).text).toContain('starts a new conversation');
  });

  it('no candidate: an empty sessions.json starts fresh, adopting nothing', async () => {
    await seedSessions([]);
    await startRouter();

    const { lifecycle } = makeLifecycle();
    const { id, adopted } = await lifecycle.bridge(createInput());

    expect(adopted).toBe(false);
    expect(harness.store.getRoomSession(id, agentAuthorId(id))).toBeNull();
  });
});
