/**
 * The presence forwarder, exercised through the REAL dispatcher
 * (chats-as-channels spec §6.8) — the acceptance test A6.8 asks for: a turn
 * claim in a bridged room produces a Telegram typing action via the
 * `progress` branch, and releasing the claim clears it.
 *
 * **What "real" means here, and where the boundary sits.** `RoomService`, its
 * `RoomTriggerDispatcher`, `BridgeStore`, and `ChatBridgePresence` are all the
 * genuine article (`createRoomHarness` — only the turn runner is scripted,
 * because the alternative is a model call). The signal transport is a real
 * `@dorkos/relay` `SignalEmitter` — the exact class `RelayCore.signal` /
 * `RelayCore.onSignal` delegate to internally — subscribed with the identical
 * one-line routing rule `telegram-adapter.ts` wires at start ("`typing` or
 * `progress` reaches the typing loop"). What is NOT re-run here is
 * `handleTypingSignal` itself and the grammy `sendChatAction` call it
 * makes — that function is `packages/relay`'s own internal, not exported
 * across the package boundary (`@dorkos/relay`'s public surface is `.` and
 * `./testing` only; see `packages/relay/package.json`'s `exports`), and its
 * `'active'` → start / anything else → stop contract is `packages/relay`'s
 * own suite's job to pin. This test proves the half chats-as-channels adds:
 * that a real claim/release in a BRIDGED room reaches the relay signal bus,
 * on the right subject, carrying exactly the `state` values that contract
 * keys off — and that an unbridged room's identical claim/release reaches it
 * not at all.
 */
import { describe, it, expect } from 'vitest';
import { SignalEmitter } from '@dorkos/relay';
import type { Signal } from '@dorkos/shared/relay-schemas';
import type { RoomTurnRequest, RoomTurnResult } from '../../../rooms/room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  settleUntil,
  type ScriptedTurnRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { ChatBridgePresence } from '../presence.js';
import type { Bridge } from '../bridge-store.js';

const AGENT_PATH = '/agents/ana';
const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** The exact subject `resolveBridgeSubject` builds in production (`apps/server/src/index.ts`) for a Telegram bridge. */
function subjectFor(bridge: Bridge): string {
  return bridge.platformChatType === 'private'
    ? `relay.human.telegram.${bridge.adapterId}.${bridge.chatId}`
    : `relay.human.telegram.${bridge.adapterId}.group.${bridge.chatId}`;
}

/**
 * A turn the test finishes by hand, so the claim is provably still held when
 * the assertions read the emitted signals — a turn that answered immediately
 * would have released before anything could observe the claimed state.
 */
function gatedTurn(): { runner: ScriptedTurnRunner; handed(): boolean; release(): void } {
  let openGate: (() => void) | undefined;
  let handedFlag = false;
  const runner: ScriptedTurnRunner = {
    turns: [],
    interrupted: [],
    interrupt: () => Promise.resolve(false),
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      handedFlag = true;
      const sessionId = request.sessionId ?? `session-${request.authorId}`;
      return new Promise((resolve) => {
        openGate = () => resolve({ sessionId, text: 'on it' });
      });
    },
  };
  return {
    runner,
    handed: () => handedFlag,
    release: () => {
      if (!openGate) throw new Error('no turn is gated — nothing to release');
      const open = openGate;
      openGate = undefined;
      open();
    },
  };
}

/**
 * Wire a presence forwarder over a real `SignalEmitter`, and the same
 * `signal === 'progress'` / whole-payload filter `binding-subsystem.ts`
 * applies before ever calling {@link ChatBridgePresence.forward} — so this
 * test exercises the actual routing decision, not a version that trusts
 * every call.
 */
function wirePresence(
  service: ReturnType<typeof createRoomHarness>['service'],
  bridges: ReturnType<typeof createRoomHarness>['bridges']
): {
  typingEvents: Array<{ subject: string; state: string }>;
  presence: ChatBridgePresence;
} {
  const emitter = new SignalEmitter();
  const typingEvents: Array<{ subject: string; state: string }> = [];
  emitter.subscribe('relay.human.>', (subject: string, signal: Signal) => {
    if (signal.type === 'typing' || signal.type === 'progress') {
      typingEvents.push({ subject, state: signal.state });
    }
  });
  const presence = new ChatBridgePresence({
    bridges,
    resolveSubject: subjectFor,
    publisher: { signal: (subject, signal) => emitter.emit(subject, signal) },
  });
  service.setSignalListener((roomId, signal, authorId, payload) => {
    if (signal !== 'progress' || !payload?.state || !payload.entryId || !payload.since) return;
    presence.forward(roomId, authorId, {
      state: payload.state,
      entryId: payload.entryId,
      since: payload.since,
    });
  });
  return { typingEvents, presence };
}

describe('the bridge presence forwarder, through the real dispatcher (A6.8)', () => {
  it('shows a typing action for exactly as long as the turn claim, and clears it on release', async () => {
    const gate = gatedTurn();
    const { service, bridges, human } = createRoomHarness({ agents, runner: gate.runner });
    const { typingEvents } = wirePresence(service, bridges);

    const room = service.createBridgedRoom({
      adapterId: 'tg-main',
      chatId: '555111',
      bindingId: 'binding-ana',
      chatType: 'private',
      channelType: null,
      title: 'Miguel',
      agentPath: AGENT_PATH,
      operatorAuthorId: human,
    });
    const bridge = bridges.findBridgeByRoom(room.id);
    if (!bridge) throw new Error('createBridgedRoom did not leave a bridge row');
    const subject = subjectFor(bridge);

    // The claim: a post in the bridged room hands Ana a turn, which the gate
    // holds open — so the claim is provably alive when we read the emitted
    // signal.
    service.post(room.id, { authorId: human, text: 'can you check the deploy?' });
    await settleUntil(() => gate.handed(), 'Ana handed a turn in the bridged room');

    expect(typingEvents).toEqual([{ subject, state: 'active' }]);

    // The release: landing the answer drops the claim, and that is what
    // clears the indicator — nothing here is a timer or a guess about how
    // long a turn usually takes.
    gate.release();
    await service.triggersIdle();

    expect(typingEvents).toEqual([
      { subject, state: 'active' },
      { subject, state: 'stopped' },
    ]);
  });

  it('makes no platform call for a claim in an unbridged room', async () => {
    const gate = gatedTurn();
    const { service, bridges, human } = createRoomHarness({ agents, runner: gate.runner });
    const { typingEvents } = wirePresence(service, bridges);

    // An ordinary DM — same harness, same agent, same claim lifecycle, no
    // bridge row. `ChatBridgePresence.forward` still runs (the listener is
    // global across every room this service publishes for); the assertion is
    // that it finds nothing to forward to.
    const room = service.createRoom(
      { kind: 'dm', title: 'Ana', members: [], agentPaths: [AGENT_PATH] },
      human
    );

    service.post(room.id, { authorId: human, text: 'can you check the deploy?' });
    await settleUntil(() => gate.handed(), 'Ana handed a turn in the unbridged room');

    gate.release();
    await service.triggersIdle();

    expect(typingEvents).toEqual([]);
  });

  it('still clears the typing indicator when the bridge archives mid-claim (regression)', async () => {
    // The bug an independent review reproduced against `forward`'s original
    // fresh-lookup-only design: `findBridgeByRoom` is re-resolved on every
    // call, which is right for the ordinary case — but a bridge that archives
    // WHILE a claim is held (a reachable path: `BridgeLifecycle.unbridge` on
    // operator disconnect or a bot-blocked 403, or
    // `onRoomArchivedDuringIngest`) meant the claim's terminal `'stopped'`
    // found no live bridge at release time and was silently dropped —
    // Telegram would keep showing "typing…" for up to `TYPING_INACTIVITY_MS`
    // (60s, `outbound.ts`) after the agent had actually stopped, on a chat
    // that was not even bridged anymore. Without the `lastActiveSubject`
    // fallback in `presence.ts`, this test fails: `typingEvents` stops at
    // `'active'` and never gets a `'stopped'`.
    const gate = gatedTurn();
    const { service, bridges, human } = createRoomHarness({ agents, runner: gate.runner });
    const { typingEvents, presence } = wirePresence(service, bridges);

    const room = service.createBridgedRoom({
      adapterId: 'tg-main',
      chatId: '555222',
      bindingId: 'binding-ana',
      chatType: 'private',
      channelType: null,
      title: 'Miguel',
      agentPath: AGENT_PATH,
      operatorAuthorId: human,
    });
    const bridge = bridges.findBridgeByRoom(room.id);
    if (!bridge) throw new Error('createBridgedRoom did not leave a bridge row');
    const subject = subjectFor(bridge);

    // The claim: Ana takes a turn, held open by the gate.
    service.post(room.id, { authorId: human, text: 'can you check the deploy?' });
    await settleUntil(() => gate.handed(), 'Ana handed a turn in the bridged room');
    expect(typingEvents).toEqual([{ subject, state: 'active' }]);
    expect(presence.trackedClaimCount).toBe(1);

    // The bridge archives WHILE the claim is still held — the reachable path
    // this regression is about, not a contrived ordering.
    service.archiveBridgedRoom(room.id, human);
    expect(bridges.findBridgeByRoom(room.id)?.archivedAt).not.toBeNull();

    // The claim ends. Its post-delivery write hits the now-archived room and
    // is refused (`ROOM_ARCHIVED`) — the dispatcher's own `catch` in `runOne`
    // turns that into a `'failed'` outcome and a damped silence-notice
    // attempt, neither of which is this test's concern — but the `finally`
    // still releases the claim and publishes `'done'` regardless of how the
    // turn's delivery went, which is what drives `forward` here.
    gate.release();
    await service.triggersIdle();

    // The terminal 'stopped' reached the LAST-KNOWN subject exactly once,
    // even though a fresh `findBridgeByRoom` now returns an archived row —
    // and the claim's tracked entry is gone, so nothing here can leak.
    expect(typingEvents).toEqual([
      { subject, state: 'active' },
      { subject, state: 'stopped' },
    ]);
    expect(presence.trackedClaimCount).toBe(0);
  });
});
