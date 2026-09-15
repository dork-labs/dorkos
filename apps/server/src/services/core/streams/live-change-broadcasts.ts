/**
 * The two subscriptions that make an agent list and a settings panel live.
 *
 * ## Why this is a module and not two lines in `index.ts`
 *
 * Both are one-line wirings, and a one-line wiring in `index.ts` is exactly the
 * kind of code that cannot be tested: `start()` boots a whole server, so a test
 * that wanted to prove the audience gate was really passed had no way to reach
 * the call site and ended up carrying a VERBATIM COPY of the line instead.
 * A copy proves the copy. Deleting `operatorAudience` from the real wiring left
 * that suite entirely green — measured, in adversarial review, and the reason
 * this file exists.
 *
 * So the decisions live here, `index.ts` calls {@link wireLiveChangeBroadcasts}
 * once, and the tests drive this function with a recording fan-out. A mutation
 * to either broadcast — the audience dropped, the payload widened, the
 * subscription removed — now fails a test.
 *
 * @module services/core/streams/live-change-broadcasts
 */
import type { AgentIdentityChange } from '@dorkos/mesh';
import { operatorAudience } from '../../notifications/notification-entitlement.js';
import type { BroadcastAudience } from '../event-fan-out.js';

/** What a settings write reports — the shape `ConfigManager.onChange` hands out. */
export interface ConfigChange {
  /** Top-level sections this write touched. */
  sections: readonly string[];
}

/** The narrow slice of `MeshCore` this wiring needs. */
export interface AgentsChangedSource {
  /** Subscribe to committed agent identity writes. */
  onAgentsChanged(callback: (change: AgentIdentityChange) => void): void;
}

/** The narrow slice of `ConfigManager` this wiring needs. */
export interface ConfigChangeSource {
  /** Subscribe to settings writes. Returns an unsubscribe. */
  onChange(listener: (change: ConfigChange) => void): () => void;
}

/** The narrow slice of the global fan-out this wiring needs. */
export interface BroadcastSink {
  /** Write one event to every connection the audience admits. */
  broadcast(eventName: string, data: unknown, audience?: BroadcastAudience): void;
}

/** Collaborators for {@link wireLiveChangeBroadcasts}. */
export interface LiveChangeBroadcastDeps {
  /**
   * The mesh core whose identity writes become `agents_changed`.
   *
   * Optional because mesh init is allowed to fail without taking the server
   * down (`index.ts` keeps running with no mesh routes). With no registry there
   * are no agents to announce — but settings still change, so `config_changed`
   * is wired either way rather than both being lost together.
   */
  meshCore: AgentsChangedSource | undefined;
  /** The settings store whose writes become `config_changed`. */
  configManager: ConfigChangeSource;
  /** Where both events are written. */
  eventFanOut: BroadcastSink;
  /** The clock, for the `changedAt` stamp. Overridden only by tests. */
  now?: () => string;
}

/**
 * What `agents_changed` puts on the wire.
 *
 * **Strictly narrower than the in-process `AgentIdentityChange` it is built
 * from**, and the missing field is the point: `projectPath` is dropped. This
 * frame is GLOBAL — it reaches every connection on `/api/events`, an agent's
 * included — nothing on the client reads the payload at all (`useAgentsSync`
 * invalidates caches and ignores what arrived), and a field nobody reads that
 * happens to be an absolute path on somebody's disk is a field with no argument
 * for being there. A server-side subscriber that wants the path takes it from
 * `MeshCore.onAgentsChanged` directly, where it still is.
 */
export interface AgentsChangedEvent {
  /** What happened to the agent. */
  kind: AgentIdentityChange['kind'];
  /** The agent's ULID. */
  agentId: string;
  /** The agent's slug, when known. */
  name?: string;
  /** The agent's display name, when it has one. */
  displayName?: string;
  /** When the write committed. */
  changedAt: string;
}

/** What `config_changed` puts on the wire: section names and a stamp, never a value. */
export interface ConfigChangedEvent {
  /** Top-level sections the write touched. */
  sections: readonly string[];
  /** When the write committed. */
  changedAt: string;
}

/**
 * Subscribe both live-change broadcasts (DOR-2052).
 *
 * **`agents_changed` is global.** An agent was registered, renamed or removed,
 * by any path that reaches the mesh registry, and every open window redraws its
 * agent list from this instead of waiting out a 30-second stale time. An
 * agent's own roster changing is legitimate news for agents too, so there is no
 * audience on it — which is safe precisely because the payload is names and ids
 * (see {@link AgentsChangedEvent}).
 *
 * **`config_changed` is ADDRESSED.** Settings are a person's surface. It goes
 * out under `operatorAudience`, the same gate `notification` uses, so an agent
 * holding an `/api/events` connection never learns that somebody rearranged
 * their sidebar. The payload is section NAMES only — config holds credentials,
 * and a subscriber that wants a value reads it back off `GET /api/config`,
 * which also keeps the event from going stale between the write and the read.
 *
 * One asymmetry worth knowing: `agents_changed` is suppressed when a write
 * changed nothing (the mesh registry compares the row before and after), while
 * `config_changed` has no such suppression — `ConfigManager` reports every
 * write, including one that stored an identical value.
 *
 * @param deps - The mesh core, the config manager, and the fan-out.
 */
export function wireLiveChangeBroadcasts(deps: LiveChangeBroadcastDeps): void {
  const { meshCore, configManager, eventFanOut } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  meshCore?.onAgentsChanged((change) => {
    // Field by field rather than a spread of `change`, so widening the
    // in-process event can never widen the wire by accident.
    const event: AgentsChangedEvent = {
      kind: change.kind,
      agentId: change.agentId,
      name: change.name,
      displayName: change.displayName,
      changedAt: now(),
    };
    eventFanOut.broadcast('agents_changed', event);
  });

  configManager.onChange((change) => {
    const event: ConfigChangedEvent = { sections: change.sections, changedAt: now() };
    eventFanOut.broadcast('config_changed', event, operatorAudience);
  });
}
