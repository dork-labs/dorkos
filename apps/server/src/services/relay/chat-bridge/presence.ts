/**
 * The presence forwarder: a room's live working indicator becomes a relay
 * signal on the bridged chat's `relay.human.*` subject, so a Telegram chat
 * bridged to a room shows a typing action for exactly as long as the agent
 * holds the turn (chats-as-channels spec §6.8).
 *
 * **Deliberately live, never durable — the opposite of `deliver.ts`, on
 * purpose.** {@link ChatBridgeDelivery} drives entry delivery off the durable
 * room log, never the live stream, because a dropped entry is a lost message
 * (spec §6.1: `publishEntry` → `RoomBroadcaster` is a live fan-out that drops
 * events for absent subscribers, so delivery cannot ride it). Presence is the
 * opposite kind of fact: it is true only while a claim is held, has no
 * "undelivered" state to retry, and a stale re-statement for a turn that
 * already finished would be a LIE, not a recovered message. Riding the live
 * signal stream (`RoomService.publishSignal` → `RoomBroadcaster`) is
 * therefore correct for presence, not a shortcut that happens to work — do
 * not "fix" this into the durable delivery/catch-up path; that would
 * resurrect indicators for turns nobody is running anymore, and would put
 * ephemeral state on the room log the rooms spec deliberately keeps off it
 * ("Ephemeral signals never enter the room log",
 * `specs/rooms/02-specification.md:229`).
 *
 * **Honesty property, preserved by construction.** This module adds no timer,
 * no debounce, and no heuristic of its own: {@link ChatBridgePresence.forward}
 * is a one-to-one relay of whatever `publishPresence` (`room-trigger.ts`)
 * already decided — claim, republish, and release all ride the same
 * dispatcher claim lifecycle the cockpit's own presence line reads. The
 * indicator therefore exists on Telegram for exactly as long as the turn
 * claim exists, with nothing here able to extend, shorten, or fake it.
 *
 * @module server/services/relay/chat-bridge/presence
 */
import type { Signal } from '@dorkos/shared/relay-schemas';
import type { RoomPresencePayload } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { Bridge, BridgeStore } from './bridge-store.js';

/** Emit an ephemeral signal onto the relay bus — {@link RelayCore.signal}. */
export interface PresenceSignalPublisher {
  /**
   * @param subject - The chat's `relay.human.*` subject.
   * @param signal - The signal envelope; never persisted.
   */
  signal(subject: string, signal: Signal): void;
}

/** Everything {@link ChatBridgePresence} is constructed from. */
export interface ChatBridgePresenceDeps {
  /** Resolve a room's live bridge row, when it has one. */
  bridges: Pick<BridgeStore, 'findBridgeByRoom'>;
  /**
   * Build the chat's `relay.human.*` subject from its bridge row — the same
   * resolver {@link ChatBridgeDelivery} uses, injected for the same reason
   * (the platform segment lives on the adapter, not the bridge row).
   */
  resolveSubject: (bridge: Bridge) => string | null;
  /** Emit the relay signal. */
  publisher: PresenceSignalPublisher;
  /** Clock, injectable so the signal's timestamp is testable. */
  now?: () => Date;
}

/**
 * Map a room's three-state presence lifecycle onto the two states
 * `handleTypingSignal` (`packages/relay/src/adapters/telegram/outbound.ts`)
 * understands. `working` and `working_late` both mean "the claim is still
 * held" — Telegram has one chat action, not a second idiom for a slow turn —
 * so both keep it alive; `done` clears it. `handleTypingSignal` treats
 * anything other than `'active'` as a clear, so `'stopped'` is a readable
 * choice for the other branch, not a value the handler singles out.
 *
 * @param state - The claim's current lifecycle state.
 */
function toSignalState(state: RoomPresencePayload['state']): string {
  return state === 'done' ? 'stopped' : 'active';
}

/**
 * The bridge-side presence forwarder (chats-as-channels spec §6.8).
 *
 * One instance per server, holding no state of its own beyond its deps: every
 * call resolves the room's CURRENT bridge row, so a room that bridges,
 * unbridges, or archives between two signals is answered correctly each time
 * rather than from a stale snapshot.
 */
export class ChatBridgePresence {
  private readonly deps: ChatBridgePresenceDeps;
  private readonly now: () => Date;

  constructor(deps: ChatBridgePresenceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Forward one room presence signal to its platform chat, if and only if the
   * room has a live (unarchived) bridge whose subject resolves. Silent on
   * every other room — no platform call, and nothing logged — because an
   * unbridged room's `progress` signal is this module's ordinary case, not an
   * error: most rooms are never bridged, and every claim/release in one of
   * them reaches here once.
   *
   * @param roomId - The room the signal was published on.
   * @param authorId - Who the claim is about.
   * @param presence - The claim's current lifecycle state, whole.
   */
  forward(roomId: string, authorId: string, presence: RoomPresencePayload): void {
    const bridge = this.deps.bridges.findBridgeByRoom(roomId);
    if (!bridge || bridge.archivedAt !== null) return;
    const subject = this.deps.resolveSubject(bridge);
    if (!subject) return;

    const signal: Signal = {
      type: 'progress',
      state: toSignalState(presence.state),
      endpointSubject: subject,
      timestamp: this.now().toISOString(),
      data: { authorId, entryId: presence.entryId, since: presence.since },
    };

    try {
      this.deps.publisher.signal(subject, signal);
    } catch (err) {
      logger.warn('[chat-bridge] presence forward threw', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
