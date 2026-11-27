/**
 * Relay routes, the claim feed and the relay events on the unified SSE stream,
 * mounted only when Relay is enabled and started.
 *
 * Moved out of `core-routes.ts` unchanged, to keep that file under the
 * 500-line limit; it runs at the same point in `start()`.
 *
 * @module startup/steps/relay-routes
 */
import { setRelayEnabled } from '../../services/relay/relay-state.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { ServerRefs } from '../server-refs.js';
import type { MountCoreRoutesInput } from './core-routes.js';

/** What the relay routes take from the core route wiring. */
export type MountRelayRoutesInput = Pick<
  MountCoreRoutesInput,
  'deps' | 'mountedRouters' | 'activityService' | 'roomStore'
>;

/**
 * Mount the relay routes and wire relay events to the unified SSE stream.
 * The caller checks that Relay is enabled; this returns early if its core is not up.
 *
 * @param refs - The server's live references.
 * @param input - The route deps and list to extend, and the services the routes use.
 */
export function mountRelayRoutes(refs: ServerRefs, input: MountRelayRoutesInput): void {
  const { deps, mountedRouters, activityService, roomStore } = input;
  if (!refs.relayCore) return;
  deps.relay = {
    relayCore: refs.relayCore,
    ...(refs.adapterManager && { adapterManager: refs.adapterManager }),
    ...(refs.traceStore && { traceStore: refs.traceStore }),
    activity: activityService,
    // Follows a renamed session to its successor, so a room conversation's retired id is
    // refused too.
    isRoomSession: (sessionId) =>
      roomStore.sessionLedger.bindingForSession(sessionId) !== undefined,
    // Read at request time, as an agent registers after these routes mount.
    agentSubjectOf: (agentPath) => refs.meshCore?.getSubjectByPath(agentPath)?.subject,
    chatMesh: () => refs.meshCore,
    agentSessions: () => refs.adapterManager?.getAgentSessionStore(),
  };
  // The claim feed (connection-scoping spec §Part 3) — mounted only when
  // the store was actually wired (relay enabled + binding subsystem up).
  const unclaimedChatsStore = refs.adapterManager?.getUnclaimedChats();
  const bindingStoreForClaims = refs.adapterManager?.getBindingStore();
  if (unclaimedChatsStore && bindingStoreForClaims) {
    // The claim card's "Answer in a channel" primary action (DOR-882) needs
    // the same lifecycle coordinator DOR-878's "Bridge to a channel" route
    // uses — optional, so a claim still lands (privately) on an install
    // where bridging isn't wired.
    const lifecycleForClaims = refs.adapterManager?.getBridgeLifecycle();
    // The group-add claim flow's "Leave" action (DOR-883) — bound to this
    // one narrowed reference rather than closing over `adapterManager`
    // itself, so the route keeps asking for exactly the one capability it
    // needs (and so TS can see the closure below is over a value already
    // known non-null, not the outer optional).
    const leaveChatForClaims = refs.adapterManager;
    deps.unclaimedChats = {
      store: unclaimedChatsStore,
      bindingStore: bindingStoreForClaims,
      ...(refs.meshCore && { meshCore: refs.meshCore }),
      ...(lifecycleForClaims && { lifecycle: lifecycleForClaims }),
      ...(leaveChatForClaims && {
        leaveChat: (adapterId: string, chatId: string) =>
          leaveChatForClaims.leaveChat(adapterId, chatId),
      }),
    };
  }
  setRelayEnabled(true);

  // Wire relay events to unified SSE stream
  refs.relayCore.subscribe('relay.human.console.>', (envelope) => {
    eventFanOut.broadcast('relay_message', envelope);
  });

  refs.relayCore.onSignal('relay.human.console.>', (_subject, signal) => {
    const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
    eventFanOut.broadcast(eventType, signal);
  });

  eventFanOut.broadcast('relay_connected', {
    pattern: 'relay.human.console.>',
    connectedAt: new Date().toISOString(),
  });

  mountedRouters.push('relay');
}
