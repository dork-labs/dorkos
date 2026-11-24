/**
 * `BridgeSessionAdopter` + `BridgeLifecycle.bridge` — adopting an existing chat
 * session at bridge time, gated on a transcript probe (chats-as-channels spec
 * §7.1–§7.4).
 *
 * **The real thing runs where it is the thing under test.** The real
 * `RoomService`, the real room-session ledger (`RoomStore.bindRoomSession` →
 * `getRoomSession`, the first-write-wins mechanism a resumed turn reads), the
 * real `RoomTriggerDispatcher` (only its RUNNER is scripted, because the
 * alternative is a model call), and the real `BridgeLifecycle.bridge` create
 * path. The one seam that is a test double is the `TranscriptProbe` — the
 * DURABLE disk signal — modelled by a fixture set of session ids that "have a
 * transcript"; its integration against the real claude-code `TranscriptReader`
 * and a real `sessions.json` lives in `adopt-session-probe.integration.test.ts`.
 *
 * A7.1 asserts on the RESUMED conversation — the session id the first bridged
 * turn actually receives (`harness.runner.turns[0].sessionId`), not the ledger
 * row — because a row nobody resumes proves nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  settleUntil,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import {
  BridgeLifecycle,
  BridgeSessionAdopter,
  type BridgeCreateInput,
  type LifecycleBinding,
  type TranscriptProbe,
} from '../index.js';

const ADAPTER = 'tg-main';
const BINDING_ID = 'binding-ana';
const AGENT_ID = 'agent-1';
const AGENT_PATH = '/agents/ana';
const CHAT_ID = '555';

const agentLookup = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/**
 * A fixture transcript probe: only claude-code answers, and a session
 * "exists" iff its id is in `withTranscript`. Models the durable disk signal
 * without the claude-code reader.
 */
function fixtureProbe(
  withTranscript: Set<string>
): TranscriptProbe & { hasTranscript: ReturnType<typeof vi.fn> } {
  const hasTranscript = vi.fn((_root: string, sessionId: string) =>
    Promise.resolve({ exists: withTranscript.has(sessionId) })
  );
  return { canProbe: (rt) => rt === 'claude-code', hasTranscript };
}

describe('BridgeSessionAdopter + BridgeLifecycle.bridge (chats-as-channels §7.1–§7.4)', () => {
  let harness: RoomHarness;

  beforeEach(() => {
    harness = createRoomHarness({
      agents: agentLookup,
      runner: scriptedRunner(() => 'the answer'),
    });
  });

  /** A bindings writer over an in-memory row, recording every flip. */
  function bindingsFake() {
    const rows = new Map<string, LifecycleBinding>([
      [
        BINDING_ID,
        { id: BINDING_ID, adapterId: ADAPTER, chatId: CHAT_ID, bridge: 'off', roomId: null },
      ],
    ]);
    const update = vi.fn(
      async (id: string, updates: { bridge?: 'off' | 'room'; roomId?: string | null }) => {
        const next = { ...rows.get(id)!, ...updates };
        rows.set(id, next);
        return next;
      }
    );
    return { rows, getById: (id: string) => rows.get(id), update };
  }

  interface AdopterOpts {
    candidate?: { sessionId: string };
    runtimeType?: string;
    withTranscript?: Set<string>;
    taken?: string[];
  }

  function makeAdopter(opts: AdopterOpts) {
    const probe = fixtureProbe(opts.withTranscript ?? new Set());
    const adopter = new BridgeSessionAdopter({
      takeChatSession: (bindingId, chatId) => {
        opts.taken?.push(`${bindingId}:chat:${chatId}`);
        return Promise.resolve(opts.candidate);
      },
      getSessionRuntimeType: () => Promise.resolve(opts.runtimeType ?? 'claude-code'),
      probe,
      resolveAgentRoot: () => '/root',
      rooms: harness.service,
    });
    return { adopter, probe };
  }

  function makeLifecycle(
    adopter: BridgeSessionAdopter,
    bindings: ReturnType<typeof bindingsFake>,
    refreshVisibility?: (adapterId: string) => Promise<void>
  ) {
    return new BridgeLifecycle({
      rooms: harness.service,
      bridges: harness.bridges,
      bindings,
      chatNotice: async () => true,
      operatorAuthorId: () => harness.human,
      adopter,
      refreshVisibility,
    });
  }

  function createInput(overrides: Partial<BridgeCreateInput> = {}): BridgeCreateInput {
    return {
      adapterId: ADAPTER,
      chatId: CHAT_ID,
      bindingId: BINDING_ID,
      agentId: AGENT_ID,
      chatType: 'private',
      channelType: null,
      title: 'Miguel',
      agentPath: AGENT_PATH,
      ...overrides,
    };
  }

  /** Every `bridge_history_note` a bridge posted in a room. */
  function historyNotices(roomId: string): { text: string }[] {
    return harness.store
      .listEntries(roomId, { limit: 100 })
      .filter((e) => e.kind === 'notice' && e.body.notice === 'bridge_history_note')
      .map((e) => e.body as { text: string });
  }

  /** An adopter that finds a live session, but whose adoption throws (DOR-915). */
  function explodingAdopter() {
    const { adopter } = makeAdopter({ candidate: { sessionId: 'sess-live' } });
    const spy = vi.spyOn(adopter, 'adoptAtBridge').mockRejectedValue(new Error('adopt exploded'));
    return { adopter, spy };
  }

  it('A7.1: after adopting a live started session, the first bridged turn RESUMES that conversation', async () => {
    const bindings = bindingsFake();
    const taken: string[] = [];
    const { adopter } = makeAdopter({
      candidate: { sessionId: 'sess-live' },
      withTranscript: new Set(['sess-live']),
      taken,
    });
    const lifecycle = makeLifecycle(adopter, bindings);

    const { id, adopted } = await lifecycle.bridge(createInput());
    expect(adopted).toBe(true);
    // §7.2 vacate: the single {bindingId}:chat:{chatId} entry is taken.
    expect(taken).toEqual([`${BINDING_ID}:chat:${CHAT_ID}`]);
    // The binding was flipped on last (§3.4), pointing at the new room.
    expect(bindings.update).toHaveBeenCalledWith(BINDING_ID, { bridge: 'room', roomId: id });
    expect(historyNotices(id)[0]?.text).toContain('continues an exchange');

    // Drive a real turn: the RUNNER records the session it was asked with.
    harness.service.post(id, { authorId: harness.human, text: 'still there?' });
    await settleUntil(() => harness.runner.turns.length === 1, 'the first bridged turn to run');
    expect(harness.runner.turns[0].sessionId).toBe('sess-live');

    // An idempotent replay does not re-adopt or re-notice.
    const second = await lifecycle.bridge(createInput());
    expect(second).toMatchObject({ id, adopted: false });
    expect(taken).toHaveLength(1);
    expect(historyNotices(id)).toHaveLength(1);
  });

  it('A7.2: a sessionMap id that FAILS the transcript probe starts fresh with the pointer-less notice', async () => {
    const { adopter, probe } = makeAdopter({
      candidate: { sessionId: 'sess-stale' },
      withTranscript: new Set(), // the id names a rekeyed-away / never-started session
    });
    const { id, adopted } = await makeLifecycle(adopter, bindingsFake()).bridge(createInput());
    expect(adopted).toBe(false);
    expect(probe.hasTranscript).toHaveBeenCalledWith('/root', 'sess-stale');
    expect(historyNotices(id)[0]?.text).toContain('starts fresh');

    // The first turn does NOT resume the stale id — it runs on a fresh mint.
    harness.service.post(id, { authorId: harness.human, text: 'hello' });
    await settleUntil(() => harness.runner.turns.length === 1, 'the first turn to run');
    expect(harness.runner.turns[0].sessionId).not.toBe('sess-stale');
  });

  it('a codex-backed binding starts fresh without consulting the disk (per-runtime probe gate)', async () => {
    const { adopter, probe } = makeAdopter({
      candidate: { sessionId: 'sess-codex' },
      runtimeType: 'codex',
      withTranscript: new Set(['sess-codex']), // a transcript would exist, but codex is unprobeable
    });
    const { adopted } = await makeLifecycle(adopter, bindingsFake()).bridge(createInput());
    expect(adopted).toBe(false);
    expect(probe.hasTranscript).not.toHaveBeenCalled();
  });

  it('DOR-915 + DOR-875: an adopt throw leaves the fresh room LIVE and the binding off; a retry heals over the same room', async () => {
    const bindings = bindingsFake();
    const { adopter, spy } = explodingAdopter();
    const lifecycle = makeLifecycle(adopter, bindings);

    await expect(lifecycle.bridge(createInput())).rejects.toThrow('adopt exploded');
    // Archiving would make the retry throw CHAT_ALREADY_BRIDGED instead of healing.
    const orphan = harness.bridges.findBridgeByChat(ADAPTER, CHAT_ID)!;
    expect(orphan.archivedAt).toBeNull();
    expect(harness.store.getRoom(orphan.roomId)?.archived).toBe(false);
    expect(bindings.rows.get(BINDING_ID)).toMatchObject({ bridge: 'off', roomId: null });

    // The retry replays (created:false), skips adopt, and re-flips.
    const { id, adopted } = await lifecycle.bridge(createInput());
    expect(id).toBe(orphan.roomId);
    expect(adopted).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bindings.rows.get(BINDING_ID)).toMatchObject({ bridge: 'room', roomId: id });
  });

  it('DOR-869: a re-bridge after an adopt throw reuses the surviving room', async () => {
    const bindings = bindingsFake();
    const lifecycle = makeLifecycle(explodingAdopter().adopter, bindings);
    await expect(lifecycle.bridge(createInput())).rejects.toThrow('adopt exploded');
    const orphan = harness.bridges.findBridgeByChat(ADAPTER, CHAT_ID)!.roomId;

    const back = await lifecycle.rebridge({
      adapterId: ADAPTER,
      chatId: CHAT_ID,
      bindingId: BINDING_ID,
      agentPath: AGENT_PATH,
    });
    expect(back.id).toBe(orphan);
    expect(bindings.rows.get(BINDING_ID)).toMatchObject({ bridge: 'room', roomId: orphan });
  });

  it('§8 visibility refresh is asked for the bridged adapter, and a rejected refresh does not fail the bridge', async () => {
    const bindings = bindingsFake();
    const refreshVisibility = vi.fn(async () => {
      throw new Error('getMe timed out');
    });
    const lifecycle = makeLifecycle(makeAdopter({}).adopter, bindings, refreshVisibility);

    const { id } = await lifecycle.bridge(createInput());
    expect(refreshVisibility).toHaveBeenCalledWith(ADAPTER);
    expect(bindings.rows.get(BINDING_ID)).toMatchObject({ bridge: 'room', roomId: id });
  });
});
