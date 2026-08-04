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
import { createChatNoticeSender, type PublishResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
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
  ChatBridge,
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
 * A fixture transcript probe: `probeable` runtimes answer, and a session
 * "exists" iff its id is in `withTranscript`. Models the durable disk signal
 * without the claude-code reader.
 */
function fixtureProbe(
  withTranscript: Set<string>,
  probeable: Set<string> = new Set(['claude-code'])
): TranscriptProbe & { hasTranscript: ReturnType<typeof vi.fn> } {
  const hasTranscript = vi.fn((_root: string, sessionId: string) =>
    Promise.resolve({ exists: withTranscript.has(sessionId) })
  );
  return { canProbe: (rt) => probeable.has(rt), hasTranscript };
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
    probeable?: Set<string>;
    agentRoot?: string | null;
    taken?: string[];
    runtimeAsked?: string[];
  }

  function makeAdopter(opts: AdopterOpts) {
    const probe = fixtureProbe(opts.withTranscript ?? new Set(), opts.probeable);
    const adopter = new BridgeSessionAdopter({
      takeChatSession: (bindingId, chatId) => {
        opts.taken?.push(`${bindingId}:chat:${chatId}`);
        return Promise.resolve(opts.candidate);
      },
      getSessionRuntimeType: (sessionId) => {
        opts.runtimeAsked?.push(sessionId);
        return Promise.resolve(opts.runtimeType ?? 'claude-code');
      },
      probe,
      resolveAgentRoot: () => (opts.agentRoot === null ? undefined : (opts.agentRoot ?? '/root')),
      rooms: harness.service,
    });
    return { adopter, probe };
  }

  function makeLifecycle(adopter: BridgeSessionAdopter, bindings: ReturnType<typeof bindingsFake>) {
    return new BridgeLifecycle({
      rooms: harness.service,
      bridges: harness.bridges,
      bindings,
      chatNotice: async () => true,
      operatorAuthorId: () => harness.human,
      adopter,
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

  /** The one `bridge_history_note` a bridge posts, or undefined. */
  function historyNotice(roomId: string): { text: string } | undefined {
    return harness.store
      .listEntries(roomId, { limit: 100 })
      .find((e) => e.kind === 'notice' && e.body.notice === 'bridge_history_note')?.body as
      | { text: string }
      | undefined;
  }

  it('A7.1: after adopting a live started session, the first bridged turn RESUMES that conversation', async () => {
    const bindings = bindingsFake();
    const { adopter } = makeAdopter({
      candidate: { sessionId: 'sess-live' },
      withTranscript: new Set(['sess-live']),
    });
    const lifecycle = makeLifecycle(adopter, bindings);

    const { id, adopted } = await lifecycle.bridge(createInput());
    expect(adopted).toBe(true);
    // The binding was flipped on last (§3.4), pointing at the new room.
    expect(bindings.update).toHaveBeenCalledWith(BINDING_ID, { bridge: 'room', roomId: id });

    // Drive a real turn: the operator speaks into their own bridged DM, the
    // agent (manifest default `always`) answers, and the RUNNER records the
    // session it was asked with — the transcript the turn receives.
    harness.service.post(id, { authorId: harness.human, text: 'still there?' });
    await settleUntil(() => harness.runner.turns.length === 1, 'the first bridged turn to run');
    expect(harness.runner.turns[0].sessionId).toBe('sess-live');
  });

  it('A7.2: a sessionMap id that FAILS the transcript probe starts fresh with the pointer-less notice', async () => {
    const bindings = bindingsFake();
    const { adopter, probe } = makeAdopter({
      candidate: { sessionId: 'sess-stale' },
      withTranscript: new Set(), // the id names a rekeyed-away / never-started session
    });
    const lifecycle = makeLifecycle(adopter, bindings);

    const { id, adopted } = await lifecycle.bridge(createInput());
    expect(adopted).toBe(false);
    expect(probe.hasTranscript).toHaveBeenCalledWith('/root', 'sess-stale');

    // The notice is the pointer-LESS variant: a new conversation, no pointer.
    const notice = historyNotice(id);
    expect(notice?.text).toContain('starts a new conversation');
    expect(notice?.text).not.toContain('picks up');

    // The first turn does NOT resume the stale id — it runs on a fresh mint.
    harness.service.post(id, { authorId: harness.human, text: 'hello' });
    await settleUntil(() => harness.runner.turns.length === 1, 'the first turn to run');
    expect(harness.runner.turns[0].sessionId).not.toBe('sess-stale');
  });

  it('adopting posts the POINTER notice and binds the ledger before the first turn', async () => {
    const bindings = bindingsFake();
    const { adopter } = makeAdopter({
      candidate: { sessionId: 'sess-live' },
      withTranscript: new Set(['sess-live']),
    });
    const { id } = await makeLifecycle(adopter, bindings).bridge(createInput());

    const notice = historyNotice(id);
    expect(notice?.text).toContain('picks up a conversation');
    expect(notice?.text).toContain("aren't copied here");
  });

  it('a codex-backed binding takes the fresh-start path without error (per-runtime probe gate)', async () => {
    const bindings = bindingsFake();
    const { adopter, probe } = makeAdopter({
      candidate: { sessionId: 'sess-codex' },
      runtimeType: 'codex',
      withTranscript: new Set(['sess-codex']), // a transcript would exist, but codex is unprobeable
    });
    const { id, adopted } = await makeLifecycle(adopter, bindings).bridge(createInput());

    expect(adopted).toBe(false);
    // canProbe short-circuits: the disk is never consulted for a runtime that
    // cannot answer, rather than a fabricated probe.
    expect(probe.hasTranscript).not.toHaveBeenCalled();
    expect(historyNotice(id)?.text).toContain('starts a new conversation');
  });

  it('an opencode-backed binding also takes the fresh-start path', async () => {
    const bindings = bindingsFake();
    const { adopter, probe } = makeAdopter({
      candidate: { sessionId: 'sess-oc' },
      runtimeType: 'opencode',
      withTranscript: new Set(['sess-oc']),
    });
    const { adopted } = await makeLifecycle(adopter, bindings).bridge(createInput());
    expect(adopted).toBe(false);
    expect(probe.hasTranscript).not.toHaveBeenCalled();
  });

  it('no sessionMap candidate → fresh start, and the runtime is never even asked', async () => {
    const bindings = bindingsFake();
    const runtimeAsked: string[] = [];
    const { adopter } = makeAdopter({ candidate: undefined, runtimeAsked });
    const { id, adopted } = await makeLifecycle(adopter, bindings).bridge(createInput());

    expect(adopted).toBe(false);
    expect(runtimeAsked).toEqual([]);
    expect(historyNotice(id)?.text).toContain('starts a new conversation');
  });

  it('an unresolvable agent root fails the probe and starts fresh', async () => {
    const bindings = bindingsFake();
    const { adopter, probe } = makeAdopter({
      candidate: { sessionId: 'sess-live' },
      withTranscript: new Set(['sess-live']),
      agentRoot: null,
    });
    const { adopted } = await makeLifecycle(adopter, bindings).bridge(createInput());
    expect(adopted).toBe(false);
    expect(probe.hasTranscript).not.toHaveBeenCalled();
  });

  it('the adopter takes the single {bindingId}:chat:{chatId} entry (§7.2 vacate)', async () => {
    const bindings = bindingsFake();
    const taken: string[] = [];
    const { adopter } = makeAdopter({
      candidate: { sessionId: 'sess-live' },
      withTranscript: new Set(['sess-live']),
      taken,
    });
    await makeLifecycle(adopter, bindings).bridge(createInput());
    expect(taken).toEqual([`${BINDING_ID}:chat:${CHAT_ID}`]);
  });

  it('A7.4: a turn in a bridged room receives room_context containing the prior ROOM entries', async () => {
    // A bridged GROUP created through the real create+adopt path (fresh: no
    // session to adopt), then the real inbound bridge writes an unmentioned
    // entry that triggers no turn, and a mention whose turn's room_context
    // carries that earlier entry — the room log driving the turn's history.
    const bindings = bindingsFake();
    const { adopter } = makeAdopter({ candidate: undefined });
    const publish = vi.fn(async (): Promise<PublishResult> => ({ messageId: 'm', deliveredTo: 1 }));
    const chatNotice = createChatNoticeSender({
      publish: publish as unknown as (s: string, p: unknown, o: unknown) => Promise<PublishResult>,
      resolveTarget: () => ({ bindingId: BINDING_ID }),
    });
    const lifecycle = new BridgeLifecycle({
      rooms: harness.service,
      bridges: harness.bridges,
      bindings,
      chatNotice,
      operatorAuthorId: () => harness.human,
      adopter,
    });
    const { id } = await lifecycle.bridge(
      createInput({ chatType: 'group', channelType: 'group', title: 'Team' })
    );

    const bridge = new ChatBridge({
      rooms: harness.service,
      bridges: harness.bridges,
      lifecycle,
      chatNotice,
    });
    const bindingRow: LifecycleBinding = {
      id: BINDING_ID,
      adapterId: ADAPTER,
      chatId: CHAT_ID,
      bridge: 'room',
      roomId: id,
    };
    const envelope = (messageId: number, content: string, botUsername?: string): RelayEnvelope => ({
      id: `env-${messageId}`,
      subject: `relay.human.telegram.${ADAPTER}.group.${CHAT_ID}`,
      from: 'telegram.tg-main.bot',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() + 60_000,
        callBudgetRemaining: 5,
      },
      createdAt: new Date().toISOString(),
      payload: {
        content,
        senderName: 'Miguel',
        platformData: {
          chatId: CHAT_ID,
          messageId,
          chatType: 'group',
          fromId: 145223,
          botUsername,
        },
      },
    });

    // Unmentioned chatter: an entry, no turn (mention-only channel).
    await bridge.ingest(bindingRow, envelope(1, 'the deploy is stuck'), { agentPath: AGENT_PATH });
    expect(harness.runner.turns).toHaveLength(0);

    // A mention triggers a turn, and the earlier chatter is in its room_context.
    await bridge.ingest(bindingRow, envelope(2, '@anabot help', 'anabot'), {
      agentPath: AGENT_PATH,
    });
    await settleUntil(() => harness.runner.turns.length === 1, 'the mention to trigger a turn');
    const seen = harness.runner.turns[0].roomContext.pending.map((e) => e.text);
    expect(seen).toContain('the deploy is stuck');
    expect(harness.runner.turns[0].roomContext.room.bridged).toBe(true);
  });

  it('an idempotent replay (already bridged) does not re-adopt or re-notice', async () => {
    const bindings = bindingsFake();
    const taken: string[] = [];
    const { adopter } = makeAdopter({
      candidate: { sessionId: 'sess-live' },
      withTranscript: new Set(['sess-live']),
      taken,
    });
    const lifecycle = makeLifecycle(adopter, bindings);
    const first = await lifecycle.bridge(createInput());
    const second = await lifecycle.bridge(createInput());

    expect(second.id).toBe(first.id);
    expect(second.adopted).toBe(false);
    // takeChatSession ran only for the genuine first create.
    expect(taken).toEqual([`${BINDING_ID}:chat:${CHAT_ID}`]);
    // Exactly one history notice, from the first bridge.
    expect(
      harness.store
        .listEntries(first.id, { limit: 100 })
        .filter((e) => e.kind === 'notice' && e.body.notice === 'bridge_history_note')
    ).toHaveLength(1);
  });
});
